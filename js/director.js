// js/director.js — DIRECTOR MODE: a flagship cinematic SECOND VIEW over the
// SAME Studio engine. It renders a reel rail + a three-column hero stage, and
// RE-HOMES the shared #composer into the centre column so every field, lint,
// preview, passthrough and GENERATE work verbatim.
//
// It owns NO generation / polling / persistence / composer logic. The ONLY
// import is the controller seam from studio.js:
//   - StudioController (read reel()/currentKey()/settings()/session(); call
//     select()/close()/selectAdjacent()/generate()/regenerate(); relocate
//     composerEl())
//   - onStudioChange (re-render on every engine change)
//
// There is NO network here, NO fetch, NO video-job code. Zero dependencies.
// All theming comes from the shared token layer (css/director.css).

import { StudioController as SC, onStudioChange } from './studio.js';

// ------------------------------------------------------------------
// constants + tiny utils
// ------------------------------------------------------------------

const MODE_KEY = 'slidemaker.mode';
const FAVS_KEY = 'slidemaker.director.favs';
const SPINNER = ['|', '/', '—', '\\'];
const GEN_ETA_MS = 90000;           // soft ETA for the determinate-ish progress bar
const GEN_COPY = [
  'Sending your two frames to the model…',
  'The model is interpolating between the frames…',
  'Rendering the in-between motion…',
  'Holding continuity on the anchor…',
  'Finishing and encoding the clip…',
];

const reduceMotion = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);

function loadFavs() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function saveFavs(set) {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

function fmtElapsed(startMs) {
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------
// module state (view-only — the engine's state lives in studio.js)
// ------------------------------------------------------------------

const favs = loadFavs();
let composerHome = null;    // { parent, next } — where #composer lives in classic mode
let mode = 'classic';
let spinFrame = 0;
let genCopyIdx = 0;

const el = {};             // cached director-shell elements

// ------------------------------------------------------------------
// mode toggle + composer relocation (the heart of "same engine, two views")
// ------------------------------------------------------------------

/**
 * Move the shared #composer node between its classic home and the Director
 * centre column. It is the SAME DOM node either way, so every input value,
 * every studio.js event listener, and the engine's composingKey are preserved
 * across a toggle — switching views never loses composer state.
 */
function relocateComposerInto(target) {
  const composer = SC.composerEl();
  if (!composer) return;
  if (!composerHome) {
    // remember the exact classic slot ONCE, so we can restore it verbatim
    composerHome = { parent: composer.parentNode, next: composer.nextSibling };
  }
  if (target === 'director') {
    el.stageCenter.appendChild(composer);   // after chips + hero
  } else if (composerHome && composerHome.parent) {
    composerHome.parent.insertBefore(composer, composerHome.next);
  }
}

function applyMode(next, { persist = true } = {}) {
  mode = next === 'director' ? 'director' : 'classic';
  const on = mode === 'director';

  // class on <html> AND <body> — the pre-paint <head> snippet sets it on
  // <html> to avoid a flash; JS keeps both in sync.
  document.documentElement.classList.toggle('director-mode', on);
  document.body.classList.toggle('director-mode', on);

  el.director.hidden = !on;
  relocateComposerInto(on ? 'director' : 'classic');

  if (el.toggle) {
    el.toggle.innerHTML = on
      ? '<span class="tw">✦</span> CLASSIC'
      : '<span class="tw">✦</span> NEW DESIGN';
    el.toggle.setAttribute('aria-pressed', String(on));
  }

  if (persist) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }
  if (on) renderAll();
}

function toggleMode() { applyMode(mode === 'director' ? 'classic' : 'director'); }

// ------------------------------------------------------------------
// reel rail
// ------------------------------------------------------------------

function statusLabel(gap) {
  switch (gap.status) {
    case 'empty':      return gap.prompt ? 'staged' : 'unwritten';
    case 'queued':     return 'queued';
    case 'generating': return (gap.lastStatus || 'working').toLowerCase();
    case 'done':       return SC.fmtUsd(gap.cost);
    case 'failed':     return 'failed';
    default:           return gap.status;
  }
}

function buildReelSlide(item, focused) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'reelSlide' + (focused ? ' in-focus' : '');
  card.setAttribute('role', 'listitem');

  const thumb = document.createElement('div');
  thumb.className = 'reelThumb' + (item.missing ? ' awaiting' : '');
  if (item.missing) {
    thumb.textContent = 'AWAITING IMAGE';
  } else if (item.imageUrl) {
    const img = document.createElement('img');
    img.src = item.imageUrl;
    img.alt = item.title;
    thumb.appendChild(img);
  }
  card.appendChild(thumb);

  const cap = document.createElement('div');
  cap.className = 'reelCap';
  cap.textContent = `${String(item.index + 1).padStart(2, '0')} · ${item.title}`;
  card.appendChild(cap);

  // clicking a slide selects its right-hand gap (or the left one for the last)
  card.addEventListener('click', () => selectGapForSlide(item.index));
  return card;
}

function attachHoverScrub(video) {
  // hover-scrub a looping done clip; no autoplay under reduced motion
  video.addEventListener('mousemove', (e) => {
    if (!video.duration) return;
    const r = video.getBoundingClientRect();
    const p = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    try { video.pause(); video.currentTime = p * video.duration; } catch { /* ignore */ }
  });
  if (!reduceMotion) {
    video.addEventListener('mouseleave', () => { video.play().catch(() => {}); });
  }
}

function buildReelGap(gap, focused) {
  const card = document.createElement('div');
  card.className = 'reelGap' + (focused ? ' focused' : '') + ` st-${gap.status}`;
  card.setAttribute('role', 'listitem');
  card.tabIndex = 0;

  if (gap.status === 'done' && gap.clipUrl) {
    const thumb = document.createElement('div');
    thumb.className = 'reelThumb';
    const v = document.createElement('video');
    v.src = gap.clipUrl;
    v.muted = true; v.loop = true; v.playsInline = true;
    v.autoplay = !reduceMotion;
    attachHoverScrub(v);
    thumb.appendChild(v);
    if (favs.has(gap.key)) {
      const s = document.createElement('span');
      s.textContent = '★';
      s.style.cssText = 'position:absolute;top:3px;right:4px;font-size:11px;color:var(--accent-2)';
      thumb.appendChild(s);
    }
    card.appendChild(thumb);
  } else if (gap.status === 'generating' || gap.status === 'queued') {
    const box = document.createElement('div');
    box.className = 'gapSpin' + (gap.status === 'generating' ? ' spinning' : '');
    const g = document.createElement('div');
    g.className = 'glyph';
    g.textContent = gap.status === 'queued' ? '⏳' : (reduceMotion ? '•' : SPINNER[spinFrame]);
    box.appendChild(g);
    if (gap.status === 'generating' && gap.startedAt) {
      const t = document.createElement('div');
      t.style.cssText = 'font-size:10px';
      t.dataset.gstart = String(gap.startedAt);
      t.textContent = fmtElapsed(gap.startedAt);
      box.appendChild(t);
    }
    card.appendChild(box);
  } else if (gap.status === 'failed') {
    const f = document.createElement('div');
    f.className = 'gapFail';
    f.textContent = '⚠';
    card.appendChild(f);
  } else {
    const v = document.createElement('div');
    v.className = 'gapVoid';
    v.textContent = gap.prompt ? '⋯' : '+';
    card.appendChild(v);
  }

  const cap = document.createElement('div');
  cap.className = `reelCap st-${gap.status}`;
  cap.textContent = `${gap.fromIndex + 1}→${gap.toIndex + 1} · ${statusLabel(gap)}`;
  card.appendChild(cap);

  const go = () => SC.select(gap.key);
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return card;
}

function renderReel(reel, focusKey) {
  const rail = el.reel;
  rail.textContent = '';
  if (reel.length === 0) {
    const p = document.createElement('div');
    p.className = 'reelEmpty';
    p.textContent = '> drop images to begin — each becomes a slide; every gap becomes a morph';
    rail.appendChild(p);
    return;
  }
  // the two slides flanking the focused gap read as "in focus"
  const focusGap = reel.find((it) => it.type === 'gap' && it.key === focusKey);
  const focusFrom = focusGap ? focusGap.fromIndex : -1;
  const focusTo = focusGap ? focusGap.toIndex : -1;

  for (const item of reel) {
    if (item.type === 'slide') {
      rail.appendChild(buildReelSlide(item, item.index === focusFrom || item.index === focusTo));
    } else {
      rail.appendChild(buildReelGap(item, item.key === focusKey));
    }
  }
  // keep the focused pair visible during long generations
  const f = rail.querySelector('.reelGap.focused');
  if (f && typeof f.scrollIntoView === 'function') {
    f.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
  }
}

/** Click-a-slide → open the gap on its right (or left, for the final slide). */
function selectGapForSlide(slideIndex) {
  const reel = SC.reel();
  const gaps = reel.filter((it) => it.type === 'gap');
  const right = gaps.find((g) => g.fromIndex === slideIndex);
  const left = gaps.find((g) => g.toIndex === slideIndex);
  const pick = right || left;
  if (pick) SC.select(pick.key);
}

// ------------------------------------------------------------------
// stage: big FROM/TO frames + hero state choreography
// ------------------------------------------------------------------

function setFrame(imgEl, wrapEl, url) {
  if (url) {
    imgEl.src = url;
    imgEl.hidden = false;
    wrapEl.classList.remove('blank');
  } else {
    imgEl.removeAttribute('src');
    imgEl.hidden = true;
    wrapEl.classList.add('blank');
  }
}

function showLayer(which) {
  el.empty.hidden = which !== 'empty';
  el.generating.hidden = which !== 'generating';
  el.done.hidden = which !== 'done';
  el.director.classList.toggle('state-generating', which === 'generating');
}

function renderStage(reel, focusKey) {
  const slides = reel.filter((it) => it.type === 'slide');
  const gap = reel.find((it) => it.type === 'gap' && it.key === focusKey) || null;

  // -------- no selection / empty deck → teaching empty state --------
  if (!gap) {
    setFrame(el.leftImg, el.leftWrap, null);
    setFrame(el.rightImg, el.rightWrap, null);
    el.leftCap.innerHTML = '<span class="tag">FROM</span>';
    el.rightCap.innerHTML = '<span class="tag">TO</span>';
    el.empty.querySelector('.big').textContent = slides.length === 0
      ? 'DROP IMAGES TO BEGIN'
      : 'PICK A MORPH FROM THE REEL';
    el.empty.querySelector('.sub').textContent = slides.length === 0
      ? 'Each image becomes a slide; every gap between two slides becomes a morph you direct one at a time.'
      : 'Click any gap in the reel above (or a slide to open the morph on its right). Then compose and GENERATE.';
    showLayer('empty');
    el.presetChips.querySelectorAll('.dirChip').forEach((c) => { c.disabled = true; });
    return;
  }

  // -------- a pair is focused: fill the big frames --------
  const from = slides.find((s) => s.index === gap.fromIndex);
  const to = slides.find((s) => s.index === gap.toIndex);
  setFrame(el.leftImg, el.leftWrap, from ? from.imageUrl : null);
  setFrame(el.rightImg, el.rightWrap, to ? to.imageUrl : null);
  el.leftCap.innerHTML = `<span class="tag">FROM</span> · SLIDE ${gap.fromIndex + 1}`;
  el.rightCap.innerHTML = gap.morphCapable
    ? `<span class="tag">TO</span> · SLIDE ${gap.toIndex + 1}`
    : `<span class="tag">TO</span> · SLIDE ${gap.toIndex + 1} (crossfade — animate-only)`;

  el.presetChips.querySelectorAll('.dirChip').forEach((c) => { c.disabled = false; });

  // -------- hero state choreography --------
  if (gap.status === 'generating') {
    renderGenerating(gap);
    showLayer('generating');
  } else if (gap.status === 'done' && gap.clipUrl) {
    renderDone(gap);
    showLayer('done');
  } else {
    // empty / queued / failed / staged → dashed placeholder over the composer
    el.empty.querySelector('.big').textContent = gap.status === 'failed'
      ? 'GENERATION FAILED — REVISE + RE-ROLL'
      : (gap.status === 'queued' ? 'QUEUED — WAITING FOR A SLOT' : 'DIRECT THIS MORPH');
    el.empty.querySelector('.sub').textContent = gap.status === 'failed'
      ? (gap.error || 'The model rejected the last attempt. Adjust the composer below, then GENERATE.')
      : 'Compose the morph in the fields below — or tap a preset chip — then GENERATE. The two frames above are what the model receives.';
    showLayer('empty');
  }
}

function renderGenerating(gap) {
  const started = gap.startedAt || Date.now();
  el.genElapsed.dataset.gstart = String(started);
  el.genElapsed.textContent = `${fmtElapsed(started)} elapsed · ${gap.modelLabel || gap.model || ''}`;
  el.genCopy.textContent = GEN_COPY[genCopyIdx % GEN_COPY.length];
  updateGenBar(started);
}

function updateGenBar(started) {
  // determinate-ish: an asymptotic curve that never claims to be done
  const elapsed = Date.now() - Number(started || Date.now());
  const pct = Math.min(95, Math.round((1 - Math.exp(-elapsed / GEN_ETA_MS)) * 100));
  el.genBar.style.width = `${pct}%`;
}

function renderDone(gap) {
  const stage = el.doneStage;
  let v = stage.querySelector('video');
  if (!v || v.dataset.key !== gap.key || v.src !== gap.clipUrl) {
    stage.textContent = '';
    v = document.createElement('video');
    v.dataset.key = gap.key;
    v.src = gap.clipUrl;
    v.muted = true; v.loop = true; v.playsInline = true;
    v.autoplay = !reduceMotion;
    stage.appendChild(v);
    v.addEventListener('timeupdate', () => {
      if (v.duration) el.scrub.value = String((v.currentTime / v.duration) * 1000);
    });
    if (!reduceMotion) v.play().catch(() => {});
  }
  const fav = favs.has(gap.key);
  let badge = stage.querySelector('.favBadge');
  if (fav && !badge) {
    badge = document.createElement('span');
    badge.className = 'favBadge';
    badge.textContent = '★';
    stage.appendChild(badge);
  } else if (!fav && badge) {
    badge.remove();
  }
  el.star.classList.toggle('on', fav);
  el.star.textContent = fav ? '[ ★ FAVORITED ]' : '[ ☆ FAVORITE ]';
  el.reroll.textContent = `[ RE-ROLL — ${SC.fmtUsd(gap.estCost)} ]`;
}

// ------------------------------------------------------------------
// HUD: live per-morph cost + session spend + credits
// ------------------------------------------------------------------

function renderHud(reel, focusKey) {
  const s = SC.settings();
  const sess = SC.session();
  const gap = reel.find((it) => it.type === 'gap' && it.key === focusKey) || null;
  const est = gap ? gap.estCost : SC.estimateCost(s.videoModel, s.duration);

  el.cost.innerHTML = `<span class="hudLabel">THIS MORPH</span>`
    + `<span class="hudNum">${est == null ? 'price unknown' : SC.fmtUsd(est)}</span>`;
  el.spend.innerHTML = `<span class="hudLabel">SESSION SPEND</span>`
    + `<span class="hudNum">${SC.fmtUsd(sess.spend)}</span>`;

  // mirror the engine's live credits readout (kept current by studio.js)
  const creditsSrc = $('creditsVal');
  const creditsTxt = creditsSrc ? creditsSrc.textContent : '—';
  el.credits.innerHTML = `<span class="hudLabel">CREDITS</span>`
    + `<span class="hudNum ${sess.outOfCredits ? 'out' : ''}">`
    + `${sess.outOfCredits ? 'OUT' : creditsTxt}</span>`;
}

// ------------------------------------------------------------------
// master render (called on entry + every onStudioChange)
// ------------------------------------------------------------------

function renderAll() {
  if (mode !== 'director') return;
  const reel = SC.reel();
  const focusKey = SC.currentKey();
  renderReel(reel, focusKey);
  renderStage(reel, focusKey);
  renderHud(reel, focusKey);
}

// ------------------------------------------------------------------
// preset chips — reuse Studio's built-in recipes via the relocated
// composer's own recipe <select> + [ APPLY ] (no forked recipe logic)
// ------------------------------------------------------------------

const PRESETS = [
  { id: 'builtin:graphic-match-dissolve', label: 'Graphic-Match Dissolve' },
  { id: 'builtin:camera-dive',            label: 'Camera Dive' },
  { id: 'builtin:whip-pan-hide',          label: 'Whip-Pan Hide' },
  { id: 'builtin:rack-focus-reveal',      label: 'Rack-Focus Reveal' },
  { id: 'builtin:minimal-trust-frames',   label: 'Minimal — Trust the Frames' },
];

function applyPreset(recipeId) {
  if (!SC.isComposing()) return;              // presets act on the open morph
  const select = $('recipeSelect');
  const applyBtn = $('btnApplyRecipe');
  if (!select || !applyBtn) return;
  select.value = recipeId;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  applyBtn.click();                           // runs Studio's own applyRecipe()
}

function buildPresetChips() {
  el.presetChips.textContent = '';
  const lbl = document.createElement('span');
  lbl.className = 'chipLabel';
  lbl.textContent = 'PRESETS';
  el.presetChips.appendChild(lbl);
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dirChip';
    b.textContent = p.label;
    b.title = `apply the "${p.label}" recipe to this morph`;
    b.disabled = true;
    b.addEventListener('click', () => applyPreset(p.id));
    el.presetChips.appendChild(b);
  }
}

// ------------------------------------------------------------------
// done-state actions
// ------------------------------------------------------------------

function focusComposer() {
  const composer = SC.composerEl();
  if (!composer) return;
  composer.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  const subject = $('fSubject');
  if (subject) subject.focus();
}

/** PREVIEW-from-here: reuse the classic filmstrip's existing preview button
 *  (present in the DOM even while the filmstrip is hidden) — no seam hook. */
function previewFromFocus() {
  const focusKey = SC.currentKey();
  const gap = SC.reel().find((it) => it.type === 'gap' && it.key === focusKey);
  if (!gap) return;
  const thumbs = document.querySelectorAll('#filmstrip .slideCard .thumbBtn');
  const btn = thumbs[gap.fromIndex];
  if (btn) btn.click();
}

function toggleFavorite() {
  const focusKey = SC.currentKey();
  if (!focusKey) return;
  if (favs.has(focusKey)) favs.delete(focusKey); else favs.add(focusKey);
  saveFavs(favs);
  renderAll();
}

// ------------------------------------------------------------------
// keyboard (director mode only; ignored while typing in a field)
// ------------------------------------------------------------------

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function focusedDoneVideo() {
  return el.doneStage.querySelector('video');
}

function onKeydown(e) {
  if (mode !== 'director') return;
  if (isTyping(e.target)) return;
  const focusKey = SC.currentKey();
  const gap = SC.reel().find((it) => it.type === 'gap' && it.key === focusKey) || null;

  switch (e.key) {
    case 'ArrowLeft':  e.preventDefault(); SC.selectAdjacent(-1); break;
    case 'ArrowRight': e.preventDefault(); SC.selectAdjacent(+1); break;
    case 'Enter':
      if (SC.isComposing() && gap && gap.status !== 'generating' && gap.status !== 'queued') {
        e.preventDefault(); SC.generate();
      }
      break;
    case 'p': case 'P': case ' ': {
      const v = focusedDoneVideo();
      if (v) { e.preventDefault(); if (v.paused) v.play().catch(() => {}); else v.pause(); }
      break;
    }
    case 'Escape':
      if (SC.isComposing()) { e.preventDefault(); SC.close(); }
      break;
    default: break;
  }
}

// ------------------------------------------------------------------
// 1 Hz ticker — spinner glyphs, elapsed clocks, progress bar, gen copy
// ------------------------------------------------------------------

function tick() {
  spinFrame = (spinFrame + 1) % SPINNER.length;
  if (mode !== 'director') return;

  for (const g of el.reel.querySelectorAll('.reelGap.spinning .glyph, .reelGap .gapSpin.spinning .glyph')) {
    if (!reduceMotion) g.textContent = SPINNER[spinFrame];
  }
  for (const t of el.reel.querySelectorAll('[data-gstart]')) {
    t.textContent = fmtElapsed(Number(t.dataset.gstart) || Date.now());
  }
  if (!el.generating.hidden) {
    const started = Number(el.genElapsed.dataset.gstart) || Date.now();
    el.genElapsed.textContent = `${fmtElapsed(started)} elapsed`;
    updateGenBar(started);
    // advance the honest rotating copy every ~4s
    if (spinFrame === 0) { genCopyIdx += 1; el.genCopy.textContent = GEN_COPY[genCopyIdx % GEN_COPY.length]; }
  }
}

// ------------------------------------------------------------------
// build the dynamic shell bits + wire everything
// ------------------------------------------------------------------

function cacheEls() {
  el.director = $('director');
  el.toggle = $('btnDirectorToggle');
  el.reel = $('dirReel');
  el.stageCenter = $('dirStageCenter');
  el.presetChips = $('dirPresetChips');
  el.empty = $('dirEmpty');
  el.generating = $('dirGenerating');
  el.done = $('dirDone');
  el.leftWrap = $('dirLeftWrap'); el.leftImg = $('dirLeftImg'); el.leftCap = $('dirLeftCap');
  el.rightWrap = $('dirRightWrap'); el.rightImg = $('dirRightImg'); el.rightCap = $('dirRightCap');
  el.genCopy = $('dirGenCopy'); el.genMeta = $('dirGenMeta');
  el.genBar = $('dirGenBar'); el.genElapsed = $('dirGenElapsed');
  el.doneStage = $('dirDoneStage'); el.scrub = $('dirScrub');
  el.reroll = $('dirReroll'); el.editBtn = $('dirEdit');
  el.star = $('dirStar'); el.previewBtn = $('dirPreview');
  el.cost = $('dirCost'); el.spend = $('dirSpend'); el.credits = $('dirCredits');
}

function wire() {
  if (el.toggle) el.toggle.addEventListener('click', toggleMode);

  el.reroll.addEventListener('click', () => {
    const k = SC.currentKey();
    if (k) SC.regenerate(k);
  });
  el.editBtn.addEventListener('click', focusComposer);
  el.star.addEventListener('click', toggleFavorite);
  el.previewBtn.addEventListener('click', previewFromFocus);

  el.scrub.addEventListener('input', () => {
    const v = focusedDoneVideo();
    if (v && v.duration) v.currentTime = (Number(el.scrub.value) / 1000) * v.duration;
  });

  document.addEventListener('keydown', onKeydown);
  onStudioChange(renderAll);
  setInterval(tick, 1000);
}

// ------------------------------------------------------------------
// boot
// ------------------------------------------------------------------

function boot() {
  cacheEls();
  if (!el.director) return;   // shell missing — nothing to do
  buildPresetChips();
  wire();

  // apply the saved mode (the pre-paint <head> snippet already hid the classic
  // chrome if 'director', so this only wires up state + relocates the composer)
  let saved = 'classic';
  try { saved = localStorage.getItem(MODE_KEY) === 'director' ? 'director' : 'classic'; } catch { /* ignore */ }
  applyMode(saved, { persist: false });
}

boot();
