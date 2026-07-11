// js/preload.js — asset preloader for the SlideMaker OS player.
// Plain ES2022 module. Zero dependencies.

/**
 * SHARED src resolution rule — MUST stay identical to the logic documented
 * in pipeline/src/payload.js (the Phase1<->Phase2 contract):
 *   1. src starting with "http://" | "https://" | "data:"  -> use verbatim
 *   2. else, if assetBase is non-empty -> assetBase (trailing slashes trimmed) + "/" + src
 *   3. else -> returned as-is, resolving relative to the page URL
 */
export function resolveSrc(src, assetBase = '') {
  if (typeof src !== 'string') return '';
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src;
  }
  if (assetBase) {
    return assetBase.replace(/\/+$/, '') + '/' + src;
  }
  return src;
}

const VIDEO_CONCURRENCY = 3;
const START_GATE_VIDEOS = 2; // START enables after all images + first N forward clips settle

function truncate(s, n = 96) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Preloader
 *
 * Load order:
 *   1. ALL slide images (new Image() + await img.decode(), in parallel) — any failure is FATAL
 *   2. forward transition videos in deck order  (fetch -> blob -> object URL, concurrency 3)
 *   3. reverse transition videos                (same)
 * "data:" video srcs bypass fetch entirely and are used directly.
 * A single failed video is a warning: that direction is marked missing and the
 * player falls back to a crossfade.
 *
 * Events dispatched:
 *   "progress"    detail: { phase: "IMAGES"|"TRANSITIONS", loaded, total }
 *   "startready"  fired once — images decoded + first 2 forward clips settled
 *   "asset-error" detail: { key, dir, error }  (non-fatal video failure)
 *   "done"        everything settled
 */
export class Preloader extends EventTarget {
  constructor(deck) {
    super();
    this.deck = deck;
    this.assetBase = typeof deck.assetBase === 'string' ? deck.assetBase : '';
    this.images = new Array(deck.slides.length).fill(null);
    this.startReady = false;
    this.done = false;
    this.objectUrls = [];

    // Transitions are looked up via a Map keyed "fromIndex-toIndex" —
    // NEVER by array position (pairs may be absent, reverse may be null).
    this.transitions = new Map();
    for (const t of Array.isArray(deck.transitions) ? deck.transitions : []) {
      if (!t || typeof t.fromIndex !== 'number' || typeof t.toIndex !== 'number') continue;
      this.transitions.set(`${t.fromIndex}-${t.toIndex}`, {
        fwdSrc: t.forward && typeof t.forward.src === 'string' ? t.forward.src : null,
        revSrc: t.reverse && typeof t.reverse.src === 'string' ? t.reverse.src : null,
        forwardUrl: null,
        reverseUrl: null,
        durationSec: (t.forward && typeof t.forward.durationSec === 'number')
          ? t.forward.durationSec : null,
      });
    }
  }

  /** Resolved URL for slide n's image (same URL the preloaded Image used → cache hit). */
  imageSrc(index) {
    return resolveSrc(this.deck.slides[index].image.src, this.assetBase);
  }

  /**
   * @returns {{forwardUrl: string|null, reverseUrl: string|null, durationSec: number|null} | null}
   *   null when the {from,to} pair is absent from the deck entirely.
   *   forwardUrl/reverseUrl are null until loaded, or after a load/playback failure.
   */
  getTransition(from, to) {
    const entry = this.transitions.get(`${from}-${to}`);
    if (!entry) return null;
    return {
      forwardUrl: entry.forwardUrl,
      reverseUrl: entry.reverseUrl,
      durationSec: entry.durationSec,
    };
  }

  /** Called by the player when a clip errors mid-playback: treat it as missing from now on. */
  markFailed(from, to, direction) {
    const entry = this.transitions.get(`${from}-${to}`);
    if (!entry) return;
    if (direction === 'reverse') entry.reverseUrl = null;
    else entry.forwardUrl = null;
  }

  async loadAll() {
    await this.loadImages();      // fatal on any failure
    this.checkStartGateNoVideos();
    await this.loadVideos();      // per-clip failures are non-fatal
    this.done = true;
    this.dispatchEvent(new CustomEvent('done'));
  }

  // ---------- phase 1: images ----------

  async loadImages() {
    const slides = this.deck.slides;
    let loaded = 0;
    this.emitProgress('IMAGES', 0, slides.length);
    await Promise.all(slides.map(async (slide, i) => {
      const url = resolveSrc(slide.image.src, this.assetBase);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      try {
        await img.decode();
      } catch (err) {
        throw new Error(`slide image ${slide.id || i} failed to load/decode (${truncate(url)})`);
      }
      this.images[i] = img;
      loaded += 1;
      this.emitProgress('IMAGES', loaded, slides.length);
    }));
    this.imagesDone = true;
  }

  // ---------- phase 2: videos ----------

  async loadVideos() {
    const fwdTasks = [];
    const revTasks = [];
    for (const [key, entry] of this.transitions) {
      if (entry.fwdSrc) fwdTasks.push({ key, entry, dir: 'forward', src: entry.fwdSrc });
      if (entry.revSrc) revTasks.push({ key, entry, dir: 'reverse', src: entry.revSrc });
    }

    const gateNeeded = Math.min(START_GATE_VIDEOS, fwdTasks.length);
    const gateTasks = new Set(fwdTasks.slice(0, gateNeeded)); // first clips in deck order
    let gateSettled = 0;

    const total = fwdTasks.length + revTasks.length;
    let loaded = 0;
    if (total > 0) this.emitProgress('TRANSITIONS', 0, total);

    const runTask = async (task) => {
      try {
        const url = await this.loadVideo(task.src);
        if (task.dir === 'forward') task.entry.forwardUrl = url;
        else task.entry.reverseUrl = url;
      } catch (err) {
        // Non-fatal: mark missing, player will crossfade for this pair/direction.
        console.warn(`[preload] ${task.dir} clip ${task.key} failed — crossfade fallback:`, err);
        this.dispatchEvent(new CustomEvent('asset-error', {
          detail: { key: task.key, dir: task.dir, error: String(err && err.message || err) },
        }));
      } finally {
        loaded += 1;
        this.emitProgress('TRANSITIONS', loaded, total);
        if (gateTasks.has(task)) {
          gateSettled += 1;
          if (gateSettled >= gateNeeded) this.fireStartReady();
        }
      }
    };

    await this.pool(fwdTasks, runTask, VIDEO_CONCURRENCY); // forwards first, deck order
    await this.pool(revTasks, runTask, VIDEO_CONCURRENCY); // then reverses
  }

  /** fetch -> blob -> object URL (zero-buffer playback). "data:" srcs bypass fetch. */
  async loadVideo(src) {
    const url = resolveSrc(src, this.assetBase);
    if (url.startsWith('data:')) return url;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${truncate(url)}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrls.push(objectUrl);
    return objectUrl;
  }

  /** Simple promise pool: at most `limit` tasks in flight. */
  async pool(tasks, run, limit) {
    const queue = tasks.slice();
    const workers = [];
    const n = Math.min(limit, queue.length);
    for (let i = 0; i < n; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          await run(queue.shift());
        }
      })());
    }
    await Promise.all(workers);
  }

  // ---------- gating / events ----------

  /** Decks with fewer than 2 (or zero) forward clips gate on what exists. */
  checkStartGateNoVideos() {
    let fwdCount = 0;
    for (const entry of this.transitions.values()) {
      if (entry.fwdSrc) fwdCount += 1;
    }
    if (fwdCount === 0) this.fireStartReady();
  }

  fireStartReady() {
    if (this.startReady) return;
    this.startReady = true;
    this.dispatchEvent(new CustomEvent('startready'));
  }

  emitProgress(phase, loaded, total) {
    this.dispatchEvent(new CustomEvent('progress', { detail: { phase, loaded, total } }));
  }

  /** Revoke blob URLs (called when a new deck replaces this one). */
  dispose() {
    for (const u of this.objectUrls) {
      try { URL.revokeObjectURL(u); } catch { /* ignore */ }
    }
    this.objectUrls.length = 0;
  }
}
