// js/tablet.js — TABLET MODE: a touch-first THIRD view over the SAME Studio
// engine. It implements the draw → guided-clip → keyframe-morph workflow:
//
//   LEFT  : draw directional strokes on slide N → bake the drawing INTO the
//           image → image-to-video (single first_frame) → auto-extract the
//           clip's LAST frame  = "→ morph start"
//   RIGHT : draw on slide N+1 → I2V → auto-extract the clip's FIRST frame
//           = "morph end →"
//   CENTER: once BOTH handoff frames exist, first/last-frame MORPH between them
//           (firstFrame=leftHandoff, lastFrame=rightHandoff). That morph becomes
//           the pair's transition (written back via SC.setGapClip).
//
// This sidesteps OpenRouter's broken video-to-video by morphing between two
// extracted keyframes instead of feeding clips in.
//
// It owns NO generation / polling / download / credits logic. The ONLY import
// is the controller seam from studio.js:
//   - StudioController: reel()/currentKey()/select()/selectAdjacent()/session()
//     /models()/registry()/estimateCost()/fmtUsd()/frameDims()/imageUrl()
//     /hasKeyReady()/clipUrlForGap() + submitAndAwaitClip() + setGapClip()
//   - onStudioChange (re-render on every engine change)
//
// There is NO network here, NO fetch, NO /videos call — SC.submitAndAwaitClip
// does all of that. Per-pair drawings + clips + extracted frames persist in an
// OWN IndexedDB ('slidemaker-tablet') so a reload never loses work. The finished
// morph lives in the gap (SC.setGapClip), so it is not double-stored here.
// Zero dependencies. All theming comes from the shared token layer.

import { StudioController as SC, onStudioChange } from './studio.js';

// ------------------------------------------------------------------
// constants
// ------------------------------------------------------------------

const MODE_KEY = 'slidemaker.mode';
const DB_NAME = 'slidemaker-tablet';
const DB_VERSION = 1;
const STORE = 'pairs';

const reduceMotion = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

// brush palette — chosen to stay visible on ANY slide (light or dark)
const SWATCHES = ['#ff3b30', '#21e6c1', '#ffd60a', '#ffffff', '#000000'];
// brush sizes are in 1280×720 COMPOSITE space (px), so they bake in 1:1
const SIZES = [
  { label: 'S', px: 8 },
  { label: 'M', px: 16 },
  { label: 'L', px: 30 },
];
const DEFAULT_SWATCH = '#ff3b30';
const DEFAULT_SIZE = 16;

// I2V models = any tier that accepts a first_frame (morph OR firstframe).
// The center morph needs first+last, so ONLY tier 'morph' is offered there.
const DEFAULT_I2V = 'google/veo-3.1-lite';
const DEFAULT_MORPH = 'kwaivgi/kling-v3.0-pro';
const FALLBACK_DURATIONS = [4];
const DEFAULT_DURATION = 4;

const DEFAULT_I2V_PROMPT =
  'Animate the scene so elements move along the directions of the drawn strokes; '
  + 'smooth continuous cinematic motion, stable lighting and framing.';
const DEFAULT_MORPH_PROMPT =
  'Morph continuously from the first frame to the last frame; '
  + 'seamless graphic-match transition, consistent lighting and color, no cuts.';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// module state (VIEW-only — the deck/engine state lives in studio.js)
// ------------------------------------------------------------------

let mode = 'classic';            // 'classic' | 'tablet' (this view on/off)
let db = null;                   // our own IndexedDB handle
let brushColor = DEFAULT_SWATCH;
let brushSize = DEFAULT_SIZE;

// per-pair working artifacts, keyed by pairKey. Each pair:
//   { left: SideState, right: SideState }
// SideState: { strokes:[Stroke], clipBlob:Blob|null, clipUrl:string|null,
//              handoff:dataURL|null, status:'idle'|'generating'|'done'|'failed',
//              statusText:string }
// Stroke: { color, size, points:[{x,y}] }  (points in 1280×720 composite space)
const pairs = new Map();
const restored = new Set();       // pairKeys whose IndexedDB load has been attempted
let currentKey = null;           // the focused pairKey (mirrors SC.currentKey())
const busy = { left: false, right: false, center: false };

const el = {};                   // cached shell elements

// ------------------------------------------------------------------
// tiny helpers
// ------------------------------------------------------------------

function freshSide() {
  return { strokes: [], clipBlob: null, clipUrl: null, handoff: null, status: 'idle', statusText: '' };
}
function pairState(key) {
  let p = pairs.get(key);
  if (!p) { p = { left: freshSide(), right: freshSide() }; pairs.set(key, p); }
  return p;
}
function sideOf(key, which) { return pairState(key)[which]; }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// ------------------------------------------------------------------
// OWN IndexedDB (never touches studio-db.js)
// ------------------------------------------------------------------

function openDB() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'pairKey' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

function idbGet(pairKey) {
  return openDB().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(pairKey);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  })).catch(() => null);
}

function idbPut(record) {
  return openDB().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(() => { /* persistence is best-effort; never break the UI */ });
}

/** Serialise the in-memory pair (strokes + clip blobs + handoff frames). */
function persistPair(key) {
  const p = pairs.get(key);
  if (!p) return Promise.resolve();
  const pack = (s) => ({
    strokes: s.strokes,
    clipBlob: s.clipBlob || null,
    handoff: s.handoff || null,
    status: s.status,
  });
  return idbPut({ pairKey: key, left: pack(p.left), right: pack(p.right), updatedAt: Date.now() });
}

/**
 * Restore a pair from IndexedDB, MERGING onto any in-memory entry that the
 * synchronous stage render may already have created. Persisted data is only
 * adopted where the live side is still untouched, so we never clobber work.
 */
async function restorePair(key) {
  if (restored.has(key)) return pairs.get(key);
  const rec = await idbGet(key);
  const p = pairState(key);         // existing (possibly empty) or fresh
  restored.add(key);
  if (rec) {
    for (const which of ['left', 'right']) {
      const src = rec[which];
      if (!src) continue;
      const s = p[which];
      if (s.strokes.length === 0 && !s.clipBlob) {   // still untouched → adopt
        s.strokes = Array.isArray(src.strokes) ? src.strokes : [];
        s.handoff = src.handoff || null;
        if (src.clipBlob instanceof Blob) {
          s.clipBlob = src.clipBlob;
          s.clipUrl = URL.createObjectURL(src.clipBlob);
        }
        s.status = s.clipBlob ? 'done' : 'idle';
      }
    }
  }
  return p;
}

// ------------------------------------------------------------------
// mode toggle + 3-way coordination (classic | director | tablet)
// ------------------------------------------------------------------

function applyMode(next, { persist = true } = {}) {
  mode = next === 'tablet' ? 'tablet' : 'classic';
  const on = mode === 'tablet';

  document.documentElement.classList.toggle('tablet-mode', on);
  document.body.classList.toggle('tablet-mode', on);

  if (on) {
    // Tablet is mutually exclusive with Director — clear it and tell the
    // Director view to stand down (it listens for the same event).
    document.documentElement.classList.remove('director-mode');
    document.body.classList.remove('director-mode');
    document.dispatchEvent(new CustomEvent('slidemaker:modechange', { detail: 'tablet' }));
  }

  if (el.tablet) el.tablet.hidden = !on;

  if (el.toggle) {
    el.toggle.innerHTML = on ? '<span class="tw">&#9638;</span> CLASSIC' : '<span class="tw">&#9638;</span> TABLET';
    el.toggle.setAttribute('aria-pressed', String(on));
  }

  if (persist) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }

  if (on) {
    // adopt the engine's focused pair; if none, open the first gap
    ensureSelection();
    renderAll();
  }
}

function toggleMode() { applyMode(mode === 'tablet' ? 'classic' : 'tablet'); }

function ensureSelection() {
  const cur = SC.currentKey();
  if (cur) return;
  const firstGap = SC.reel().find((it) => it.type === 'gap');
  if (firstGap) SC.select(firstGap.key);
}

// ------------------------------------------------------------------
// reel rail — reuse SC.reel(); click a gap → SC.select(key)
// ------------------------------------------------------------------

function buildReelSlide(item, focused) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'tabReelSlide' + (focused ? ' in-focus' : '');
  card.setAttribute('role', 'listitem');
  const thumb = document.createElement('div');
  thumb.className = 'tabReelThumb' + (item.missing ? ' awaiting' : '');
  if (item.missing) thumb.textContent = 'AWAITING IMAGE';
  else if (item.imageUrl) { const i = new Image(); i.src = item.imageUrl; i.alt = item.title; thumb.appendChild(i); }
  card.appendChild(thumb);
  const cap = document.createElement('div');
  cap.className = 'tabReelCap';
  cap.textContent = `${String(item.index + 1).padStart(2, '0')} · ${item.title}`;
  card.appendChild(cap);
  card.addEventListener('click', () => selectGapForSlide(item.index));
  return card;
}

function buildReelGap(gap, focused) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'tabReelGap' + (focused ? ' focused' : '') + ` st-${gap.status}`;
  card.setAttribute('role', 'listitem');
  const glyph = document.createElement('div');
  glyph.className = 'tabReelGapGlyph';
  glyph.textContent = gap.status === 'done' ? '▦' : (gap.status === 'generating' ? '…' : '+');
  card.appendChild(glyph);
  const cap = document.createElement('div');
  cap.className = 'tabReelCap';
  cap.textContent = `${gap.fromIndex + 1}→${gap.toIndex + 1}`;
  card.appendChild(cap);
  card.addEventListener('click', () => SC.select(gap.key));
  return card;
}

function selectGapForSlide(slideIndex) {
  const gaps = SC.reel().filter((it) => it.type === 'gap');
  const pick = gaps.find((g) => g.fromIndex === slideIndex) || gaps.find((g) => g.toIndex === slideIndex);
  if (pick) SC.select(pick.key);
}

function renderReel(reel, focusKey) {
  const rail = el.reel;
  rail.textContent = '';
  if (reel.length === 0) {
    const p = document.createElement('div');
    p.className = 'tabReelEmpty';
    p.textContent = '> drop images in Classic/Studio — each becomes a slide; every gap becomes a morph';
    rail.appendChild(p);
    return;
  }
  const focusGap = reel.find((it) => it.type === 'gap' && it.key === focusKey);
  const ff = focusGap ? focusGap.fromIndex : -1;
  const ft = focusGap ? focusGap.toIndex : -1;
  for (const item of reel) {
    if (item.type === 'slide') rail.appendChild(buildReelSlide(item, item.index === ff || item.index === ft));
    else rail.appendChild(buildReelGap(item, item.key === focusKey));
  }
  const f = rail.querySelector('.tabReelGap.focused');
  if (f && f.scrollIntoView) f.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
}

// ------------------------------------------------------------------
// drawing canvas — Pointer Events, strokes stored in 1280×720 space
// ------------------------------------------------------------------

const dims = () => SC.frameDims();  // {w:1280,h:720}

/** Map a pointer event to composite (1280×720) coordinates. */
function toComposite(canvas, e) {
  const { w, h } = dims();
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / (r.width || 1)) * w;
  const y = ((e.clientY - r.top) / (r.height || 1)) * h;
  return { x, y };
}

/** Draw a list of strokes onto a 2D context. `scale` maps composite→target px. */
function paintStrokes(ctx, strokes, scale) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    if (!s.points || s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, s.size * scale);
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * scale, s.points[0].y * scale);
    if (s.points.length === 1) {
      // a dot — draw a tiny segment so it renders
      ctx.lineTo(s.points[0].x * scale + 0.01, s.points[0].y * scale + 0.01);
    } else {
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * scale, s.points[i].y * scale);
    }
    ctx.stroke();
  }
}

/** Size the display canvas to its CSS box (device-pixel crisp) + repaint. */
function resizeCanvas(which) {
  const c = el[which].canvas;
  const rect = c.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  repaintCanvas(which);
}

function repaintCanvas(which) {
  const c = el[which].canvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!currentKey) return;
  const { w } = dims();
  const scale = c.width / w;               // composite(1280)→canvas px
  paintStrokes(ctx, sideOf(currentKey, which).strokes, scale);
}

function attachDrawing(which) {
  const c = el[which].canvas;
  let stroke = null;
  const down = (e) => {
    if (!currentKey) return;
    const s = sideOf(currentKey, which);
    if (s.status === 'done' || s.status === 'generating') return;  // clip showing / busy
    c.setPointerCapture && c.setPointerCapture(e.pointerId);
    stroke = { color: brushColor, size: brushSize, points: [toComposite(c, e)] };
    s.strokes.push(stroke);
    repaintCanvas(which);
    e.preventDefault();
  };
  const move = (e) => {
    if (!stroke) return;
    stroke.points.push(toComposite(c, e));
    repaintCanvas(which);
    e.preventDefault();
  };
  const up = () => {
    if (!stroke) return;
    stroke = null;
    persistPair(currentKey);   // autosave after each stroke
  };
  c.addEventListener('pointerdown', down);
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('pointerleave', up);
}

function undoSide(which) {
  if (!currentKey) return;
  const s = sideOf(currentKey, which);
  if (s.status === 'done') return;
  s.strokes.pop();
  repaintCanvas(which);
  persistPair(currentKey);
}
function clearSide(which) {
  if (!currentKey) return;
  const s = sideOf(currentKey, which);
  if (s.status === 'done') return;
  s.strokes = [];
  repaintCanvas(which);
  persistPair(currentKey);
}

// ------------------------------------------------------------------
// composite: bake the drawing INTO the slide image → PNG dataURL
// ------------------------------------------------------------------

async function compositeSide(which) {
  const { w, h } = dims();
  const gap = focusedGap();
  if (!gap) throw new Error('no pair selected');
  const slideIndex = which === 'left' ? gap.fromIndex : gap.toIndex;
  const slide = SC.reel().find((it) => it.type === 'slide' && it.index === slideIndex);
  if (!slide || !slide.imageUrl) throw new Error('slide image missing');
  const img = await loadImage(slide.imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  paintStrokes(ctx, sideOf(currentKey, which).strokes, 1);  // strokes already in 1280-space
  return canvas.toDataURL('image/png');
}

// ------------------------------------------------------------------
// client-side frame extraction — video → seeked → canvas → dataURL.
// Gated on 'loadeddata'/'seeked' EVENTS (never play()) so it works in
// background tabs. A short timeout backstops the seeked-at-0 edge case.
// ------------------------------------------------------------------

function extractFrame(blob, which /* 'first' | 'last' */) {
  return new Promise((resolve, reject) => {
    const { w, h } = dims();
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let settled = false;
    let fallback = null;
    const cleanup = () => { if (fallback) clearTimeout(fallback); try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
    const capture = () => {
      if (settled) return;
      settled = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        const data = canvas.toDataURL('image/png');
        cleanup();
        resolve(data);
      } catch (e) { cleanup(); reject(e); }
    };
    video.addEventListener('loadeddata', () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const target = which === 'last' ? Math.max(0, dur - 0.05) : 0.0;
      // seeking to 0 when already at 0 may not emit 'seeked' — backstop it
      fallback = setTimeout(capture, which === 'first' ? 250 : 1200);
      try { video.currentTime = target; } catch { capture(); }
    }, { once: true });
    video.addEventListener('seeked', capture, { once: true });
    video.addEventListener('error', () => { cleanup(); reject(new Error('video decode failed')); }, { once: true });
    video.src = url;
  });
}

// ------------------------------------------------------------------
// generation — LEFT/RIGHT I2V, then CENTER morph. All via the seam.
// ------------------------------------------------------------------

function focusedGap() {
  const k = currentKey;
  return k ? SC.reel().find((it) => it.type === 'gap' && it.key === k) || null : null;
}

function setSideStatus(which, status, text) {
  const s = sideOf(currentKey, which);
  s.status = status;
  if (text != null) s.statusText = text;
}

function outOfCredits() { return !!(SC.session() && SC.session().outOfCredits); }

async function generateSide(which) {
  if (busy[which] || !currentKey) return;
  if (!SC.hasKeyReady()) { setSideStatus(which, 'failed', 'NO API KEY — open [ KEY ] in Classic/Studio and paste one.'); renderAll(); return; }
  const key = currentKey;
  const model = el.i2vModel.value;
  const duration = Number(el.i2vDur.value) || DEFAULT_DURATION;
  const hint = (which === 'left' ? el.leftPrompt : el.rightPrompt).value.trim();
  const prompt = hint || DEFAULT_I2V_PROMPT;
  busy[which] = true;
  setSideStatus(which, 'generating', 'Baking the drawing into the frame…');
  renderAll();
  try {
    const firstFrame = await compositeSide(which);
    setSideStatus(which, 'generating', 'Submitting image-to-video…');
    renderAll();
    const { blob, costUsd } = await SC.submitAndAwaitClip({
      model, duration, firstFrame,
      includeLastFrame: false,          // I2V: single conditioning frame
      prompt,
      onStatus: (st) => { if (key === currentKey) { setSideStatus(which, 'generating', `model: ${st}…`); renderAll(); } },
    });
    // auto-extract the handoff frame: LEFT→last, RIGHT→first
    setSideStatus(which, 'generating', 'Extracting handoff frame…');
    renderAll();
    const handoff = await extractFrame(blob, which === 'left' ? 'last' : 'first');
    const s = sideOf(key, which);
    if (s.clipUrl) { try { URL.revokeObjectURL(s.clipUrl); } catch { /* ignore */ } }
    s.clipBlob = blob;
    s.clipUrl = URL.createObjectURL(blob);
    s.handoff = handoff;
    s.status = 'done';
    s.statusText = `clip ready · ${SC.fmtUsd(costUsd)}`;
    await persistPair(key);
  } catch (err) {
    const msg = (err && (err.name === 'OutOfCreditsError' || outOfCredits()))
      ? 'OUT OF CREDITS — generation stopped.'
      : `failed: ${err && err.message ? err.message : err}`;
    setSideStatus(which, 'failed', msg);
  } finally {
    busy[which] = false;
    if (key === currentKey) renderAll();
  }
}

async function generateMorph() {
  if (busy.center || !currentKey) return;
  const key = currentKey;
  const p = pairState(key);
  if (!p.left.handoff || !p.right.handoff) return;
  if (!SC.hasKeyReady()) { el.morphStatus.textContent = 'NO API KEY — open [ KEY ] in Classic/Studio and paste one.'; return; }
  const model = el.morphModel.value;
  const duration = Number(el.morphDur.value) || DEFAULT_DURATION;
  const prompt = el.morphPrompt.value.trim() || DEFAULT_MORPH_PROMPT;
  busy.center = true;
  el.morphStatus.textContent = 'Submitting first/last-frame morph…';
  renderMorphState();
  try {
    const { blob, costUsd } = await SC.submitAndAwaitClip({
      model, duration,
      firstFrame: p.left.handoff,       // left clip's LAST frame
      lastFrame: p.right.handoff,       // right clip's FIRST frame
      includeLastFrame: true,           // MORPH: both frames conditioned
      prompt,
      onStatus: (st) => { if (key === currentKey) { el.morphStatus.textContent = `model: ${st}…`; } },
    });
    // write the finished morph into the pair's gap → player/exports use it
    await SC.setGapClip(key, blob, { model, prompt, durationSec: duration, costUsd, source: 'tablet' });
    el.morphStatus.textContent = `morph is now this pair's transition · ${SC.fmtUsd(costUsd)}`;
  } catch (err) {
    el.morphStatus.textContent = (err && (err.name === 'OutOfCreditsError' || outOfCredits()))
      ? 'OUT OF CREDITS — generation stopped.'
      : `failed: ${err && err.message ? err.message : err}`;
  } finally {
    busy.center = false;
    if (key === currentKey) renderAll();
  }
}

// ------------------------------------------------------------------
// rendering: stage (left/center/right zones) + HUD
// ------------------------------------------------------------------

function showClip(wrapEl, url) {
  let v = wrapEl.querySelector('video');
  if (!v || v.src !== url) {
    wrapEl.textContent = '';
    v = document.createElement('video');
    v.src = url; v.muted = true; v.loop = true; v.playsInline = true;
    v.autoplay = !reduceMotion;
    wrapEl.appendChild(v);
    if (!reduceMotion) v.play().catch(() => {});
  }
}

function renderSide(which) {
  const s = sideOf(currentKey, which);
  const paint = el[which].paint;
  const clipWrap = el[which].clip;
  const handoff = el[which].handoff;
  const gen = el[which].gen;
  const reroll = el[which].reroll;
  const statusEl = el[which].status;
  const done = s.status === 'done';
  const generating = s.status === 'generating';

  // slide image + drawing canvas vs. finished clip
  el[which].img.hidden = done;
  el[which].canvas.style.display = done ? 'none' : '';
  clipWrap.hidden = !done;
  if (done && s.clipUrl) showClip(clipWrap, s.clipUrl);

  // handoff-frame thumbnail
  if (done && s.handoff) { handoff.hidden = false; handoff.querySelector('img').src = s.handoff; }
  else handoff.hidden = true;

  // buttons
  gen.hidden = done;
  gen.disabled = generating || busy[which];
  reroll.hidden = !done;
  reroll.disabled = busy[which];
  paint.classList.toggle('generating', generating);

  // status copy
  statusEl.textContent = s.statusText
    || (done ? 'clip ready' : 'Draw directional strokes, then generate. The drawing is baked into the image before it goes to the model.');
  statusEl.classList.toggle('err', s.status === 'failed');
}

function renderMorphState() {
  const p = currentKey ? pairState(currentKey) : { left: freshSide(), right: freshSide() };
  const bothReady = !!(p.left.handoff && p.right.handoff);
  // the two handoff frames as the morph's first/last
  setMorphImg(el.morphA, p.left.handoff);
  setMorphImg(el.morphB, p.right.handoff);

  const gap = focusedGap();
  const morphUrl = gap && gap.status === 'done' ? SC.clipUrlForGap(currentKey) : null;
  if (morphUrl) { el.morphStage.hidden = false; showClip(el.morphStage, morphUrl); }
  else { el.morphStage.hidden = true; el.morphStage.textContent = ''; }

  el.genMorph.disabled = !bothReady || busy.center;
  el.genMorph.hidden = !!morphUrl && !busy.center;
  el.rerollMorph.hidden = !morphUrl || busy.center;
  el.rerollMorph.disabled = busy.center;

  if (busy.center) { /* status text managed by generateMorph */ }
  else if (morphUrl) el.morphStatus.textContent = "this morph is the pair's transition — RE-ROLL to replace it";
  else if (!bothReady) el.morphStatus.textContent = 'Generate the two side clips first — their extracted frames become the morph’s first & last.';
  else el.morphStatus.textContent = 'Both handoff frames ready — GENERATE MORPH to build the transition.';
}

function setMorphImg(box, dataUrl) {
  if (dataUrl) {
    box.classList.remove('blank');
    box.style.backgroundImage = `url("${dataUrl}")`;
  } else {
    box.classList.add('blank');
    box.style.backgroundImage = '';
  }
}

function renderStage(reel, focusKey) {
  const gap = reel.find((it) => it.type === 'gap' && it.key === focusKey) || null;
  const hasDeck = reel.some((it) => it.type === 'gap');
  el.empty.hidden = !!gap;
  el.stage.hidden = !gap;
  if (!gap) {
    el.empty.querySelector('.big').textContent = hasDeck ? 'PICK A PAIR FROM THE REEL' : 'NO SLIDE PAIR YET';
    el.empty.querySelector('.sub').textContent = hasDeck
      ? 'Tap any gap in the reel above (or a slide to open the morph on its right).'
      : 'Drop images in Classic or Studio first — each image becomes a slide, and every gap between two slides becomes a morph you build here.';
    return;
  }
  el.leftNo.textContent = String(gap.fromIndex + 1);
  el.rightNo.textContent = String(gap.toIndex + 1);
  const slides = reel.filter((it) => it.type === 'slide');
  const from = slides.find((s) => s.index === gap.fromIndex);
  const to = slides.find((s) => s.index === gap.toIndex);
  el.left.img.src = from && from.imageUrl ? from.imageUrl : '';
  el.right.img.src = to && to.imageUrl ? to.imageUrl : '';

  // renderSide toggles canvas visibility; size + repaint AFTER so a rerolled
  // (re-shown) canvas gets measured and its strokes are redrawn.
  renderSide('left');
  renderSide('right');
  resizeCanvas('left');
  resizeCanvas('right');
  renderMorphState();
}

function renderHud() {
  const s = SC.session();
  el.spend.innerHTML = `<span class="tabHudLabel">SESSION SPEND</span><span class="tabHudNum">${SC.fmtUsd(s.spend)}</span>`;
  const creditsSrc = $('creditsVal');
  const creditsTxt = creditsSrc ? creditsSrc.textContent : '—';
  el.credits.innerHTML = `<span class="tabHudLabel">CREDITS</span>`
    + `<span class="tabHudNum ${s.outOfCredits ? 'out' : ''}">${s.outOfCredits ? 'OUT' : creditsTxt}</span>`;
  el.creditBanner.hidden = !s.outOfCredits;
  updateEstimates();
}

function updateEstimates() {
  const i2v = SC.estimateCost(el.i2vModel.value, Number(el.i2vDur.value) || DEFAULT_DURATION);
  el.i2vEst.textContent = i2v == null ? 'price unknown' : `${SC.fmtUsd(i2v)}/side`;
  const mo = SC.estimateCost(el.morphModel.value, Number(el.morphDur.value) || DEFAULT_DURATION);
  el.morphEst.textContent = mo == null ? 'price unknown' : `${SC.fmtUsd(mo)}/morph`;
}

// ------------------------------------------------------------------
// master render (called on entry + every onStudioChange + selection change)
// ------------------------------------------------------------------

let restoreToken = 0;
function renderAll() {
  if (mode !== 'tablet') return;
  const reel = SC.reel();
  const focusKey = SC.currentKey();

  // selection changed → make sure the pair's artifacts are loaded from IDB
  if (focusKey && focusKey !== currentKey) {
    currentKey = focusKey;
    if (!restored.has(focusKey)) {
      const token = ++restoreToken;
      restorePair(focusKey).then(() => { if (token === restoreToken && mode === 'tablet') renderAll(); });
    }
  } else if (!focusKey) {
    currentKey = null;
  }

  renderReel(reel, focusKey);
  renderStage(reel, focusKey);
  renderHud();
}

// ------------------------------------------------------------------
// model / duration selects
// ------------------------------------------------------------------

function i2vModels() {
  return SC.models().filter((m) => (m.tier === 'morph' || m.tier === 'firstframe') && !m.disabledReason);
}
function morphModels() {
  return SC.models().filter((m) => m.tier === 'morph' && !m.disabledReason);
}

function fillModelSelect(select, list, preferred) {
  select.textContent = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    let label = m.label;
    if (m.videoInput) label += ' ⎇ VIDEO-IN';       // honest mark (wan-2.7; experimental)
    select.appendChild(opt).textContent = label;
  }
  const has = list.some((m) => m.id === preferred);
  select.value = has ? preferred : (list[0] ? list[0].id : '');
}

function durationsFor(modelId) {
  const reg = SC.registry(modelId);
  const ds = reg && Array.isArray(reg.durations) && reg.durations.length ? reg.durations : FALLBACK_DURATIONS;
  return ds.slice().sort((a, b) => a - b);
}

function fillDurationSelect(select, modelId, keep) {
  const ds = durationsFor(modelId);
  select.textContent = '';
  for (const d of ds) {
    const opt = document.createElement('option');
    opt.value = String(d);
    opt.textContent = `${d}s`;
    select.appendChild(opt);
  }
  const want = ds.includes(keep) ? keep : (ds.includes(DEFAULT_DURATION) ? DEFAULT_DURATION : ds[0]);
  select.value = String(want);
}

function buildModelControls() {
  fillModelSelect(el.i2vModel, i2vModels(), DEFAULT_I2V);
  fillModelSelect(el.morphModel, morphModels(), DEFAULT_MORPH);
  fillDurationSelect(el.i2vDur, el.i2vModel.value, DEFAULT_DURATION);
  fillDurationSelect(el.morphDur, el.morphModel.value, DEFAULT_DURATION);
  updateNoteFor(el.i2vModel, el.i2vEst);
  updateEstimates();
}

function updateNoteFor(select, estEl) {
  const reg = SC.registry(select.value);
  if (reg && reg.videoInput && estEl) estEl.title = reg.note || 'experimental video-input model';
}

// ------------------------------------------------------------------
// brush toolbar
// ------------------------------------------------------------------

function buildBrush() {
  el.swatches.textContent = '';
  for (const color of SWATCHES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tabSwatch' + (color === brushColor ? ' on' : '');
    b.style.setProperty('--sw', color);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(color === brushColor));
    b.setAttribute('aria-label', `brush colour ${color}`);
    b.addEventListener('click', () => {
      brushColor = color;
      for (const c of el.swatches.children) {
        const on = c === b;
        c.classList.toggle('on', on);
        c.setAttribute('aria-checked', String(on));
      }
    });
    el.swatches.appendChild(b);
  }
  el.sizes.textContent = '';
  for (const sz of SIZES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tabSize' + (sz.px === brushSize ? ' on' : '');
    b.textContent = sz.label;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(sz.px === brushSize));
    b.setAttribute('aria-label', `brush size ${sz.label}`);
    b.addEventListener('click', () => {
      brushSize = sz.px;
      for (const c of el.sizes.children) {
        const on = c === b;
        c.classList.toggle('on', on);
        c.setAttribute('aria-checked', String(on));
      }
    });
    el.sizes.appendChild(b);
  }
}

// ------------------------------------------------------------------
// element caching + wiring
// ------------------------------------------------------------------

function cacheEls() {
  el.tablet = $('tablet');
  el.toggle = $('btnTabletToggle');
  el.reel = $('tabReel');
  el.tools = $('tabTools');
  el.swatches = $('tabSwatches'); el.sizes = $('tabSizes');
  el.i2vModel = $('tabI2VModel'); el.i2vDur = $('tabI2VDur'); el.i2vEst = $('tabI2VEst');
  el.morphModel = $('tabMorphModel'); el.morphDur = $('tabMorphDur'); el.morphEst = $('tabMorphEst');
  el.spend = $('tabSpend'); el.credits = $('tabCredits'); el.creditBanner = $('tabCreditBanner');
  el.empty = $('tabEmpty'); el.stage = $('tabStage');
  el.leftNo = $('tabLeftNo'); el.rightNo = $('tabRightNo');
  el.leftPrompt = $('tabLeftPrompt'); el.rightPrompt = $('tabRightPrompt');
  el.left = {
    paint: $('tabLeftPaint'), img: $('tabLeftImg'), canvas: $('tabLeftCanvas'), clip: $('tabLeftClip'),
    handoff: $('tabLeftHandoff'), status: $('tabLeftStatus'),
    gen: document.querySelector('#tabLeft .tabGen'), reroll: document.querySelector('#tabLeft .tabReroll'),
  };
  el.right = {
    paint: $('tabRightPaint'), img: $('tabRightImg'), canvas: $('tabRightCanvas'), clip: $('tabRightClip'),
    handoff: $('tabRightHandoff'), status: $('tabRightStatus'),
    gen: document.querySelector('#tabRight .tabGen'), reroll: document.querySelector('#tabRight .tabReroll'),
  };
  el.morphA = $('tabMorphA'); el.morphB = $('tabMorphB'); el.morphStage = $('tabMorphStage');
  el.morphPrompt = $('tabMorphPrompt'); el.genMorph = $('tabGenMorph'); el.rerollMorph = $('tabRerollMorph');
  el.morphStatus = $('tabMorphStatus');
}

function wire() {
  if (el.toggle) el.toggle.addEventListener('click', toggleMode);

  attachDrawing('left');
  attachDrawing('right');

  el.left.gen.addEventListener('click', () => generateSide('left'));
  el.right.gen.addEventListener('click', () => generateSide('right'));
  el.left.reroll.addEventListener('click', () => resetSideForReroll('left'));
  el.right.reroll.addEventListener('click', () => resetSideForReroll('right'));
  el.genMorph.addEventListener('click', generateMorph);
  el.rerollMorph.addEventListener('click', generateMorph);

  for (const b of document.querySelectorAll('.tabUndo')) b.addEventListener('click', () => undoSide(b.dataset.side));
  for (const b of document.querySelectorAll('.tabClear')) b.addEventListener('click', () => clearSide(b.dataset.side));

  el.i2vModel.addEventListener('change', () => { fillDurationSelect(el.i2vDur, el.i2vModel.value, Number(el.i2vDur.value)); updateNoteFor(el.i2vModel, el.i2vEst); updateEstimates(); });
  el.morphModel.addEventListener('change', () => { fillDurationSelect(el.morphDur, el.morphModel.value, Number(el.morphDur.value)); updateEstimates(); });
  el.i2vDur.addEventListener('change', updateEstimates);
  el.morphDur.addEventListener('change', updateEstimates);

  document.addEventListener('slidemaker:modechange', (e) => {
    if (e.detail !== 'tablet' && mode === 'tablet') applyMode('classic', { persist: false });
  });

  window.addEventListener('resize', () => {
    if (mode !== 'tablet' || !currentKey) return;
    resizeCanvas('left'); resizeCanvas('right');
  });

  onStudioChange(renderAll);
}

/** RE-ROLL a side clip: drop the finished clip so the drawing reappears, then
 *  the user can revise strokes and GENERATE again (keeps the drawing intact). */
function resetSideForReroll(which) {
  if (!currentKey) return;
  const s = sideOf(currentKey, which);
  if (s.clipUrl) { try { URL.revokeObjectURL(s.clipUrl); } catch { /* ignore */ } }
  s.clipBlob = null; s.clipUrl = null; s.handoff = null; s.status = 'idle'; s.statusText = '';
  persistPair(currentKey);
  renderAll();
}

// ------------------------------------------------------------------
// boot
// ------------------------------------------------------------------

function boot() {
  cacheEls();
  if (!el.tablet) return;   // shell missing — nothing to do
  buildBrush();
  buildModelControls();
  wire();

  // model registry may fill in async (live catalog merge) — rebuild once more
  onStudioChange(() => { if (el.i2vModel.options.length === 0) buildModelControls(); });

  let saved = 'classic';
  try { saved = localStorage.getItem(MODE_KEY) === 'tablet' ? 'tablet' : 'classic'; } catch { /* ignore */ }
  applyMode(saved, { persist: false });
}

boot();
