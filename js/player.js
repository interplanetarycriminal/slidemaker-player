// js/player.js — the 3-state playback machine.
// States: STATIC(n) | PLAYING_FWD | PLAYING_REV. Every path converges to a valid STATIC(n).

export const State = Object.freeze({
  STATIC: 'STATIC',
  PLAYING_FWD: 'PLAYING_FWD',
  PLAYING_REV: 'PLAYING_REV',
});

const CROSSFADE_MS = 350;
const SKIP_SAFETY_MS = 300; // if 'ended' never fires after a seek-to-end, finish anyway

export class Player extends EventTarget {
  /**
   * @param {object} o
   * @param {HTMLElement}      o.stage    #stage (gets the .video-active class)
   * @param {HTMLImageElement} o.slideImg #slideImg
   * @param {HTMLVideoElement} o.video    #transVideo
   * @param {HTMLImageElement} o.fadeImg  #fadeImg (crossfade layer)
   * @param {import('./preload.js').Preloader} o.preloader
   */
  constructor({ stage, slideImg, video, fadeImg, preloader }) {
    super();
    this.stage = stage;
    this.slideImg = slideImg;
    this.video = video;
    this.fadeImg = fadeImg;
    this.preloader = preloader;
    this.deck = preloader.deck;

    this.index = 0;
    this.state = State.STATIC;
    this.mode = null;          // 'video' | 'fade' while transitioning, else null
    this.target = -1;          // slide index we are transitioning to
    this.pair = null;          // {from, to, dir} of the clip in flight
    this.skipRequested = false;
    this.skipTimer = null;
    this.fadeTimer = null;
    this.reducedMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.video.muted = true; // belt-and-braces with the muted attribute (autoplay policy)

    // Show the video only once frames are actually flowing — prevents first-frame flash.
    this.video.addEventListener('playing', () => {
      if (this.mode === 'video') this.stage.classList.add('video-active');
    });
    this.video.addEventListener('ended', () => {
      if (this.mode === 'video') this.finishTransition();
    });
    // A clip erroring mid-playback is treated as missing: crossfade to the target.
    this.video.addEventListener('error', () => {
      if (this.mode === 'video') this.videoFailed();
    });
  }

  get lastIndex() { return this.deck.slides.length - 1; }
  get isTransitioning() { return this.state !== State.STATIC; }

  /** Show the initial slide. */
  start(index = 0) {
    this.index = this.clamp(index);
    this.slideImg.src = this.preloader.imageSrc(this.index);
    this.emitState();
  }

  /** STATIC(n) -> PLAYING_FWD -> STATIC(n+1). At the last slide: no-op + edge event. */
  next() {
    if (this.isTransitioning) { this.requestSkip(); return; }
    if (this.index >= this.lastIndex) { this.emitEdge('end'); return; }
    const from = this.index;
    const to = this.index + 1;
    const t = this.preloader.getTransition(from, to);
    if (t && t.forwardUrl) {
      this.playClip(t.forwardUrl, to, State.PLAYING_FWD, { from, to, dir: 'forward' });
    } else {
      // Pair absent, clip failed, or not buffered yet -> crossfade fallback.
      this.crossfadeTo(to, State.PLAYING_FWD);
    }
  }

  /** STATIC(n) -> PLAYING_REV (reverse clip of pair (n-1, n)) -> STATIC(n-1). */
  back() {
    if (this.isTransitioning) { this.requestSkip(); return; }
    if (this.index <= 0) { this.emitEdge('start'); return; }
    const from = this.index - 1;
    const to = this.index;
    const t = this.preloader.getTransition(from, to);
    if (t && t.reverseUrl) {
      this.playClip(t.reverseUrl, from, State.PLAYING_REV, { from, to, dir: 'reverse' });
    } else {
      this.crossfadeTo(from, State.PLAYING_REV);
    }
  }

  /**
   * Input during playback: the FIRST extra press skips to the end of the
   * transition (seek to duration fires 'ended'); further presses are ignored.
   * Nothing is ever queued.
   */
  requestSkip() {
    if (this.skipRequested) return;
    this.skipRequested = true;
    if (this.mode === 'video') {
      try {
        if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
          this.video.currentTime = this.video.duration; // -> 'ended'
        } else {
          this.finishTransition();
          return;
        }
      } catch {
        this.finishTransition();
        return;
      }
      this.skipTimer = setTimeout(() => this.finishTransition(), SKIP_SAFETY_MS);
    } else if (this.mode === 'fade') {
      this.finishCrossfade();
    }
  }

  /** Hard cut to slide n (grid clicks, Home/End, dots). Always lands in STATIC(n). */
  jumpTo(index) {
    const n = this.clamp(index);
    this.cancelInFlight();
    this.index = n;
    this.slideImg.src = this.preloader.imageSrc(n);
    this.state = State.STATIC;
    this.emitState();
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  playClip(url, targetIndex, state, pair) {
    this.state = state;
    this.mode = 'video';
    this.target = targetIndex;
    this.pair = pair;
    this.skipRequested = false;
    this.emitState();

    this.video.src = url;
    try { this.video.currentTime = 0; } catch { /* not seekable yet — fine */ }
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => { if (this.mode === 'video') this.videoFailed(); });
    }
  }

  videoFailed() {
    // Only a real media error (decode/network) permanently retires the clip.
    // Transient play() rejections (backgrounded tab, interrupted play) keep it
    // available for the next attempt — the crossfade below still rescues THIS one.
    if (this.pair && this.video.error) {
      this.preloader.markFailed(this.pair.from, this.pair.to, this.pair.dir);
    }
    const target = this.target;
    const state = this.state;
    this.mode = null;
    this.pair = null;
    this.hideVideo();
    this.crossfadeTo(target, state);
  }

  finishTransition() {
    if (this.mode !== 'video') return; // idempotent (ended + safety timer can both fire)
    clearTimeout(this.skipTimer);
    this.skipTimer = null;
    this.index = this.target;
    // The paused video is already displaying this exact frame, so update the
    // img beneath it first, then unveil on the next frame — no flash.
    this.slideImg.src = this.preloader.imageSrc(this.index);
    this.mode = null;
    this.pair = null;
    this.skipRequested = false;
    this.state = State.STATIC;
    requestAnimationFrame(() => this.hideVideo());
    this.emitState();
  }

  hideVideo() {
    if (this.mode === 'video') return; // a new clip already took over — leave it alone
    this.stage.classList.remove('video-active');
    try { this.video.pause(); } catch { /* ignore */ }
  }

  crossfadeTo(targetIndex, state) {
    this.state = state;
    this.mode = 'fade';
    this.target = targetIndex;
    this.skipRequested = false;
    this.emitState();
    if (this.reducedMotion) { this.finishCrossfade(); return; } // instant hard cut
    this.fadeImg.style.transition = '';
    this.fadeImg.src = this.preloader.imageSrc(targetIndex);
    this.fadeImg.classList.add('show'); // CSS: opacity 0 -> 1 over 350ms
    this.fadeTimer = setTimeout(() => this.finishCrossfade(), CROSSFADE_MS + 40);
  }

  finishCrossfade() {
    if (this.mode !== 'fade') return; // idempotent (skip + timer)
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.index = this.target;
    this.slideImg.src = this.preloader.imageSrc(this.index);
    this.resetFadeLayer();
    this.mode = null;
    this.skipRequested = false;
    this.state = State.STATIC;
    this.emitState();
  }

  /** Snap the fade layer back to transparent WITHOUT animating the reset. */
  resetFadeLayer() {
    this.fadeImg.style.transition = 'none';
    this.fadeImg.classList.remove('show');
    requestAnimationFrame(() => { this.fadeImg.style.transition = ''; });
  }

  /** Abort whatever is in flight (used by jumpTo's hard cut). */
  cancelInFlight() {
    clearTimeout(this.skipTimer);
    this.skipTimer = null;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.mode = null;
    this.pair = null;
    this.skipRequested = false;
    this.hideVideo();
    this.resetFadeLayer();
  }

  clamp(n) {
    return Math.min(Math.max(Number(n) || 0, 0), this.lastIndex);
  }

  emitState() {
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: {
        state: this.state,
        index: this.index,
        target: this.isTransitioning ? this.target : null,
      },
    }));
  }

  emitEdge(side) {
    this.dispatchEvent(new CustomEvent('edge', { detail: { side } }));
  }
}
