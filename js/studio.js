// js/studio.js — SlideMaker Studio: per-transition morph authoring.
//
// The grammar module (js/grammar.js) is the FIXED quality boundary — this app
// only ever collects intent (subject / verb / connective / destination /
// camera move) and feeds it through assemblePrompt/wrapRawPrompt/lintPrompt.
//
// Zero dependencies. Network: openrouter.ai only. All URLs relative.

import {
  PHYSICAL_VERBS, CONNECTIVES, CAMERA_MOVES, MATCH_HINTS,
  CONTRACT_PREFIX, CONTRACT_SUFFIX,
  assemblePrompt, wrapRawPrompt, lintPrompt,
} from './grammar.js';
import { OpenRouterClient, OutOfCreditsError } from './openrouter-client.js';
import * as db from './studio-db.js';
import { Player } from './player.js';

// ------------------------------------------------------------------
// constants
// ------------------------------------------------------------------

const KEY_STORAGE = 'slidemaker.openrouter.key';
const GENERATOR = 'slidemaker-studio@1.0.0';
const FRAME_W = 1280;
const FRAME_H = 720;
const POLL_MS = 15000;
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_CONCURRENT = 2;
const CUSTOM_VERB = '__custom__';

/**
 * Hardcoded model registry — verified against GET /videos/models at load.
 * pricePerSec from observed billing; billFloorSec = minimum seconds BILLED
 * (observed live: kling billed a 3s request as 5s; wan billed 4s as 5s —
 * the delivered clip still honors the requested duration).
 */
const MODEL_REGISTRY = [
  { id: 'kwaivgi/kling-v3.0-pro', label: 'KLING 3.0 PRO', pricePerSec: 0.112, billFloorSec: 5, note: 'RECOMMENDED — first/last-frame native, 3-15s pacing (billed 5s min)' },
  { id: 'kwaivgi/kling-v3.0-std', label: 'KLING 3.0 STD', pricePerSec: 0.084, billFloorSec: 5, note: 'Kling look, lighter price (billed 5s min)' },
  { id: 'alibaba/wan-2.7',      label: 'WAN 2.7',      pricePerSec: 0.10,  billFloorSec: 5, note: 'best prompt adherence in our bake-off' },
  { id: 'google/veo-3.1-lite',  label: 'VEO 3.1 LITE', pricePerSec: 0.03,  billFloorSec: 0, note: 'draft/value' },
  { id: 'bytedance/seedance-2.0', label: 'SEEDANCE 2.0', pricePerSec: 0.151, billFloorSec: 0, note: 'alternative look' },
];
const FALLBACK_DURATIONS = [4];
const DEFAULT_DURATION = 4;

const SPINNER_FRAMES = ['|', '/', '—', '\\'];

// ------------------------------------------------------------------
// dom
// ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  modelSelect: $('modelSelect'), modelNote: $('modelNote'),
  durationSelect: $('durationSelect'), titleInput: $('titleInput'),
  spendVal: $('spendVal'), creditsVal: $('creditsVal'),
  btnKey: $('btnKey'), btnAddImages: $('btnAddImages'),
  btnExportDeck: $('btnExportDeck'), btnExportProject: $('btnExportProject'),
  btnImportProject: $('btnImportProject'),
  creditBanner: $('creditBanner'), noteLine: $('noteLine'), errLine: $('errLine'),
  detachNote: $('detachNote'), stripEmpty: $('stripEmpty'), filmstrip: $('filmstrip'),
  composer: $('composer'), composerTitle: $('composerTitle'),
  btnCloseComposer: $('btnCloseComposer'),
  composerLeft: $('composerLeft'), composerLeftCap: $('composerLeftCap'),
  composerRight: $('composerRight'), composerRightCap: $('composerRightCap'),
  fSubject: $('fSubject'), fVerb: $('fVerb'), fVerbCustom: $('fVerbCustom'),
  fConnective: $('fConnective'), fDestination: $('fDestination'),
  fCamera: $('fCamera'), cameraHint: $('cameraHint'),
  matchChips: $('matchChips'), chipHint: $('chipHint'),
  promptPreview: $('promptPreview'), lintBox: $('lintBox'),
  btnAdvanced: $('btnAdvanced'), rawWrap: $('rawWrap'), fRaw: $('fRaw'),
  btnGenerate: $('btnGenerate'), composerStatus: $('composerStatus'),
  previewModal: $('previewModal'), pvStage: $('pvStage'), pvSlide: $('pvSlide'),
  pvVideo: $('pvVideo'), pvFade: $('pvFade'), pvBack: $('pvBack'), pvNext: $('pvNext'),
  pvCounter: $('pvCounter'), pvClose: $('pvClose'),
  drawerScrim: $('drawerScrim'), keyDrawer: $('keyDrawer'), keyInput: $('keyInput'),
  keyState: $('keyState'), btnSaveKey: $('btnSaveKey'), btnTestKey: $('btnTestKey'),
  btnForgetKey: $('btnForgetKey'), keyReport: $('keyReport'), btnCloseDrawer: $('btnCloseDrawer'),
  dropOverlay: $('dropOverlay'), filePicker: $('filePicker'), projectPicker: $('projectPicker'),
};

const reducedMotion = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------
// state
// ------------------------------------------------------------------

const client = new OpenRouterClient();

const state = {
  title: 'UNTITLED DECK',
  createdAt: new Date().toISOString(),
  settings: { videoModel: MODEL_REGISTRY[0].id, duration: DEFAULT_DURATION },
  slides: [],   // [{ uid, title, sourceName, missing }]
  gaps: {},     // pairKey "fromUid::toUid" -> gap record
};

let sessionSpend = 0;
let outOfCredits = false;
let importConfirmUntil = 0;

const imageUrls = new Map();   // slide uid -> objectURL of normalized PNG
const clipUrls = new Map();    // gap uid -> objectURL of mp4 blob
const pollTimers = new Map();  // pairKey -> timeout id
let queue = [];                // pairKeys with status "queued"
let composingKey = null;
let pvPlayer = null;
let spinnerFrame = 0;
let saveTimer = null;

// ------------------------------------------------------------------
// small utils
// ------------------------------------------------------------------

function uid(prefix) {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rnd}`;
}

const pairKey = (fromUid, toUid) => `${fromUid}::${toUid}`;

function fmtUsd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
}

function fmtElapsed(startMs) {
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}

function downloadText(text, filename, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function showErr(msg) {
  els.errLine.textContent = `ERR: ${client.scrubText(msg)}`;
  els.errLine.hidden = false;
}
function clearErr() {
  els.errLine.hidden = true;
  els.errLine.textContent = '';
}
function showNote(msg) {
  els.noteLine.textContent = `> ${client.scrubText(msg)}`;
  els.noteLine.hidden = false;
}

// ------------------------------------------------------------------
// persistence (autosave on every mutation)
// ------------------------------------------------------------------

function serializeGap(g) {
  return {
    uid: g.uid, fromUid: g.fromUid, toUid: g.toUid,
    composer: {
      subject: g.composer.subject || '',
      verb: g.composer.verb || '',
      connective: g.composer.connective || '',
      destination: g.composer.destination || '',
      cameraId: g.composer.cameraId || '',
    },
    rawMode: !!g.rawMode, rawText: g.rawText || '',
    prompt: g.prompt || '',
    status: g.status, jobId: g.jobId ?? null,
    model: g.model ?? null, durationSec: g.durationSec ?? null,
    costUsd: g.costUsd ?? null, error: g.error ?? null,
    startedAt: g.startedAt ?? null, hasClip: !!g.hasClip,
  };
}

function serializeProject() {
  const gaps = {};
  for (const [k, g] of Object.entries(state.gaps)) gaps[k] = serializeGap(g);
  return {
    v: 1,
    title: state.title,
    createdAt: state.createdAt,
    settings: { ...state.settings },
    slides: state.slides.map((s) => ({
      uid: s.uid, title: s.title || '', sourceName: s.sourceName || '', missing: !!s.missing,
    })),
    gaps,
    savedAt: new Date().toISOString(),
  };
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await db.saveProject(serializeProject());
  } catch (err) {
    showErr(`autosave failed — ${err.message}`);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

// ------------------------------------------------------------------
// gaps
// ------------------------------------------------------------------

function newGap(fromUid, toUid) {
  return {
    uid: uid('gap'), fromUid, toUid,
    composer: { subject: '', verb: PHYSICAL_VERBS[0], connective: 'revealing', destination: '', cameraId: CAMERA_MOVES[0].id },
    rawMode: false, rawText: '',
    prompt: '',
    status: 'empty', jobId: null, model: null, durationSec: null,
    costUsd: null, error: null, startedAt: null, hasClip: false,
    lastStatus: null, pollTimedOut: false,
  };
}

function activePairKeys() {
  const keys = [];
  for (let i = 0; i < state.slides.length - 1; i++) {
    keys.push(pairKey(state.slides[i].uid, state.slides[i + 1].uid));
  }
  return keys;
}

/** Ensure a gap exists for every adjacent pair; purge blank detached records. */
function deriveGaps() {
  const active = new Set(activePairKeys());
  for (const k of active) {
    if (!state.gaps[k]) {
      const [fromUid, toUid] = k.split('::');
      state.gaps[k] = newGap(fromUid, toUid);
    }
  }
  for (const [k, g] of Object.entries(state.gaps)) {
    if (active.has(k)) continue;
    const worthKeeping = g.hasClip || g.prompt || g.status !== 'empty';
    if (!worthKeeping) delete state.gaps[k];
  }
  if (composingKey && !active.has(composingKey)) closeComposer();
}

function detachedGaps() {
  const active = new Set(activePairKeys());
  return Object.entries(state.gaps)
    .filter(([k]) => !active.has(k))
    .map(([, g]) => g);
}

// ------------------------------------------------------------------
// image ingestion + normalization
// ------------------------------------------------------------------

/** Canvas-normalize to EXACTLY 1280x720 PNG with a centered cover crop. */
async function normalizeImage(file) {
  const bmp = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.max(FRAME_W / bmp.width, FRAME_H / bmp.height);
    const w = bmp.width * scale;
    const h = bmp.height * scale;
    ctx.drawImage(bmp, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
    });
    return blob;
  } finally {
    bmp.close();
  }
}

function setImageUrl(slideUid, blob) {
  const old = imageUrls.get(slideUid);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* ignore */ } }
  imageUrls.set(slideUid, URL.createObjectURL(blob));
}

function setClipUrl(gapUid, blob) {
  const old = clipUrls.get(gapUid);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* ignore */ } }
  clipUrls.set(gapUid, URL.createObjectURL(blob));
}

async function ingestFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const jsonFile = files.find((f) => f.name.toLowerCase().endsWith('.json') || (f.type || '').includes('json'));
  if (jsonFile && files.length === 1) {
    await importProjectFile(jsonFile);
    return;
  }

  const images = files.filter((f) => (f.type || '').startsWith('image/'));
  const rejected = files.filter((f) => !(f.type || '').startsWith('image/'));
  if (rejected.length) {
    showErr(`skipped ${rejected.map((f) => f.name).join(', ')} — images only (project .json goes through [ IMPORT PROJECT ])`);
  }
  if (images.length === 0) return;

  clearErr();
  const mismatches = [];
  for (const file of images) {
    let normalized;
    try {
      normalized = await normalizeImage(file);
    } catch (err) {
      showErr(`${file.name}: could not decode/normalize — ${err.message}`);
      continue;
    }
    // Re-drop matching: fill an awaiting slot whose sourceName matches.
    let slide = state.slides.find((s) => s.missing && s.sourceName === file.name)
      || state.slides.find((s) => s.missing && s.sourceName.toLowerCase() === file.name.toLowerCase());
    if (slide) {
      slide.missing = false;
    } else {
      if (state.slides.some((s) => s.missing)) mismatches.push(file.name);
      slide = { uid: uid('slide'), title: '', sourceName: file.name, missing: false };
      state.slides.push(slide);
    }
    try {
      await db.putImage(slide.uid, {
        original: file, normalized, sourceName: file.name, type: file.type || 'image/*',
      });
    } catch (err) {
      showErr(`${file.name}: could not persist to IndexedDB — ${err.message}`);
    }
    setImageUrl(slide.uid, normalized);
  }
  if (mismatches.length) {
    showNote(`no project slide matches ${mismatches.join(', ')} — appended as new slides (expected: ${state.slides.filter((s) => s.missing).map((s) => s.sourceName).join(', ') || 'none'})`);
  }
  deriveGaps();
  renderFilmstrip();
  scheduleSave();
}

// ------------------------------------------------------------------
// slide ops
// ------------------------------------------------------------------

function moveSlide(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.slides.length) return;
  const tmp = state.slides[i];
  state.slides[i] = state.slides[j];
  state.slides[j] = tmp;
  deriveGaps();
  renderFilmstrip();
  scheduleSave();
}

async function removeSlide(i) {
  const slide = state.slides[i];
  if (!slide) return;
  state.slides.splice(i, 1);
  const url = imageUrls.get(slide.uid);
  if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  imageUrls.delete(slide.uid);
  try { await db.deleteImage(slide.uid); } catch { /* already gone — fine */ }
  deriveGaps();
  renderFilmstrip();
  scheduleSave();
}

// ------------------------------------------------------------------
// filmstrip rendering
// ------------------------------------------------------------------

function renderFilmstrip() {
  const strip = els.filmstrip;
  strip.textContent = '';
  const has = state.slides.length > 0;
  els.stripEmpty.hidden = has;
  strip.hidden = !has;

  state.slides.forEach((slide, i) => {
    strip.appendChild(buildSlideCard(slide, i));
    if (i < state.slides.length - 1) strip.appendChild(buildGapCard(i));
  });

  const detached = detachedGaps();
  const withClips = detached.filter((g) => g.hasClip).length;
  if (detached.length > 0) {
    els.detachNote.hidden = false;
    els.detachNote.textContent =
      `⚠ ${detached.length} authored gap(s) detached (slide pair no longer adjacent)` +
      (withClips ? ` — ${withClips} generated clip(s) stay in the browser store and re-attach if the order is restored` : '');
  } else {
    els.detachNote.hidden = true;
  }
}

function buildSlideCard(slide, i) {
  const card = document.createElement('div');
  card.className = 'slideCard';

  if (slide.missing) {
    const box = document.createElement('div');
    box.className = 'awaiting';
    box.innerHTML = `<span>AWAITING IMAGE</span><span>${escapeHtml(slide.sourceName || '?')}</span><span class="snote">re-drop the file to fill this slot</span>`;
    card.appendChild(box);
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumbBtn';
    btn.title = 'preview from this slide';
    const img = document.createElement('img');
    img.src = imageUrls.get(slide.uid) || '';
    img.alt = slide.title || slide.sourceName || `slide ${i + 1}`;
    btn.appendChild(img);
    btn.addEventListener('click', () => openPreview(slide.uid));
    card.appendChild(btn);
  }

  const num = document.createElement('div');
  num.className = 'slideNum';
  num.textContent = `SLIDE ${String(i + 1).padStart(2, '0')}${slide.sourceName ? ' · ' + slide.sourceName : ''}`;
  card.appendChild(num);

  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'titleField';
  title.placeholder = 'title (optional)';
  title.value = slide.title || '';
  title.addEventListener('input', () => {
    slide.title = title.value;
    scheduleSave();
  });
  card.appendChild(title);

  const btns = document.createElement('div');
  btns.className = 'cardBtns';
  const mkBtn = (txt, tip, fn, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.title = tip;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    return b;
  };
  btns.appendChild(mkBtn('◀', 'move earlier', () => moveSlide(i, -1), i === 0));
  btns.appendChild(mkBtn('▶', 'move later', () => moveSlide(i, +1), i === state.slides.length - 1));
  const rm = mkBtn('✕', 'remove slide', () => removeSlide(i), false);
  rm.classList.add('rm');
  btns.appendChild(rm);
  card.appendChild(btns);
  return card;
}

function buildGapCard(i) {
  const from = state.slides[i];
  const to = state.slides[i + 1];
  const k = pairKey(from.uid, to.uid);
  const gap = state.gaps[k];
  const card = document.createElement('div');
  card.dataset.key = k;
  card.className = `gapCard st-${gap.status}${k === composingKey ? ' selected' : ''}`;

  const tag = document.createElement('div');
  tag.className = 'gapTag';
  tag.textContent = `MORPH ${i + 1} → ${i + 2}`;
  card.appendChild(tag);

  const awaiting = from.missing || to.missing;
  if (awaiting) {
    card.appendChild(ghint('AWAITING IMAGES — re-drop the files either side first'));
    return card;
  }

  const openBtn = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sbtn small';
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); openComposer(k); });
    return b;
  };

  switch (gap.status) {
    case 'empty': {
      card.appendChild(openBtn('[ COMPOSE ]'));
      card.appendChild(ghint('morph unwritten'));
      break;
    }
    case 'queued': {
      const pos = queue.indexOf(k);
      card.appendChild(ghint(`QUEUED${pos >= 0 ? ` #${pos + 1}` : ''} — waiting for a generation slot (max ${MAX_CONCURRENT})`));
      card.appendChild(openBtn('[ OPEN ]'));
      break;
    }
    case 'generating': {
      const spin = document.createElement('div');
      spin.className = 'spin';
      spin.textContent = reducedMotion ? '•' : SPINNER_FRAMES[spinnerFrame];
      card.appendChild(spin);
      const el = document.createElement('div');
      el.className = 'elapsed';
      el.dataset.start = String(gap.startedAt || Date.now());
      el.textContent = fmtElapsed(gap.startedAt || Date.now());
      card.appendChild(el);
      card.appendChild(ghint(`${(gap.lastStatus || 'pending').toUpperCase()}${gap.pollTimedOut ? ' — POLL TIMEOUT, RELOAD TO RESUME' : ''}`));
      const cost = document.createElement('div');
      cost.className = 'costTag';
      cost.textContent = `~${fmtUsd(estimateCost(gap.model, gap.durationSec))} · ${gap.model || ''}`;
      card.appendChild(cost);
      break;
    }
    case 'done': {
      const clipUrl = clipUrls.get(gap.uid);
      if (clipUrl) {
        const v = document.createElement('video');
        v.src = clipUrl;
        v.muted = true;
        v.loop = true;
        v.autoplay = !reducedMotion;
        v.playsInline = true;
        v.title = gap.prompt;
        card.appendChild(v);
      }
      const btns = document.createElement('div');
      btns.className = 'gbtns';
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'sbtn small';
      replay.textContent = '[ REPLAY ]';
      replay.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = card.querySelector('video');
        if (v) { v.currentTime = 0; v.play().catch(() => {}); }
      });
      btns.appendChild(replay);
      btns.appendChild(openBtn('[ RECOMPOSE ]'));
      const regen = document.createElement('button');
      regen.type = 'button';
      regen.className = 'sbtn small';
      regen.textContent = `[ REGENERATE ${fmtUsd(estimateCost(state.settings.videoModel, state.settings.duration))} ]`;
      regen.addEventListener('click', (e) => { e.stopPropagation(); regenerateGap(k); });
      btns.appendChild(regen);
      card.appendChild(btns);
      const cost = document.createElement('div');
      cost.className = 'costTag';
      cost.textContent = `${fmtUsd(gap.costUsd)} · ${gap.model || ''}`;
      card.appendChild(cost);
      break;
    }
    case 'failed': {
      const err = document.createElement('div');
      err.className = 'errline';
      err.textContent = `ERR: ${gap.error || 'generation failed'}`;
      card.appendChild(err);
      const btns = document.createElement('div');
      btns.className = 'gbtns';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'sbtn small';
      retry.textContent = '[ RETRY ]';
      retry.addEventListener('click', (e) => { e.stopPropagation(); regenerateGap(k); });
      btns.appendChild(retry);
      btns.appendChild(openBtn('[ RECOMPOSE ]'));
      card.appendChild(btns);
      break;
    }
    default: break;
  }

  card.addEventListener('click', () => openComposer(k));
  return card;
}

function ghint(text) {
  const d = document.createElement('div');
  d.className = 'ghint';
  d.textContent = text;
  return d;
}

function refreshGapCard(k) {
  const old = els.filmstrip.querySelector(`.gapCard[data-key="${CSS.escape(k)}"]`);
  if (!old) { renderFilmstrip(); return; }
  const idx = state.slides.findIndex((s) => k.startsWith(s.uid + '::'));
  if (idx < 0 || idx >= state.slides.length - 1
      || pairKey(state.slides[idx].uid, state.slides[idx + 1].uid) !== k) {
    renderFilmstrip();
    return;
  }
  old.replaceWith(buildGapCard(idx));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------------------------------------------------------------------
// composer
// ------------------------------------------------------------------

function buildComposerStatics() {
  // verbs (+ custom)
  for (const v of PHYSICAL_VERBS) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    els.fVerb.appendChild(o);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_VERB; custom.textContent = 'custom…';
  els.fVerb.appendChild(custom);

  for (const c of CONNECTIVES) {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    els.fConnective.appendChild(o);
  }
  for (const m of CAMERA_MOVES) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    els.fCamera.appendChild(o);
  }
  for (const h of MATCH_HINTS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = h.label;
    chip.title = h.hint;
    chip.addEventListener('click', () => {
      const active = chip.classList.toggle('active');
      for (const other of els.matchChips.children) {
        if (other !== chip) other.classList.remove('active');
      }
      els.chipHint.textContent = active ? h.hint : '';
    });
    els.matchChips.appendChild(chip);
  }
}

function slideIndexByUid(u) {
  return state.slides.findIndex((s) => s.uid === u);
}

function openComposer(k) {
  const gap = state.gaps[k];
  if (!gap) return;
  const fi = slideIndexByUid(gap.fromUid);
  const ti = slideIndexByUid(gap.toUid);
  const from = state.slides[fi];
  const to = state.slides[ti];
  if (!from || !to) return;
  if (from.missing || to.missing) {
    showErr(`morph ${fi + 1} → ${ti + 1}: re-drop the missing image(s) before composing`);
    return;
  }
  clearErr();
  composingKey = k;

  els.composerTitle.textContent = `COMPOSER — MORPH ${fi + 1} → ${ti + 1}`;
  els.composerLeft.src = imageUrls.get(from.uid) || '';
  els.composerLeftCap.textContent = `SLIDE ${fi + 1}${from.title ? ' · ' + from.title : ''} (first frame)`;
  els.composerRight.src = imageUrls.get(to.uid) || '';
  els.composerRightCap.textContent = `SLIDE ${ti + 1}${to.title ? ' · ' + to.title : ''} (last frame)`;

  els.fSubject.value = gap.composer.subject || '';
  const verb = gap.composer.verb || PHYSICAL_VERBS[0];
  if (PHYSICAL_VERBS.includes(verb)) {
    els.fVerb.value = verb;
    els.fVerbCustom.hidden = true;
    els.fVerbCustom.value = '';
  } else {
    els.fVerb.value = CUSTOM_VERB;
    els.fVerbCustom.hidden = false;
    els.fVerbCustom.value = verb;
  }
  els.fConnective.value = CONNECTIVES.includes(gap.composer.connective) ? gap.composer.connective : 'revealing';
  els.fDestination.value = gap.composer.destination || '';
  els.fCamera.value = CAMERA_MOVES.some((m) => m.id === gap.composer.cameraId) ? gap.composer.cameraId : CAMERA_MOVES[0].id;

  els.fRaw.value = gap.rawText || '';
  els.rawWrap.hidden = !gap.rawMode;
  els.btnAdvanced.textContent = gap.rawMode ? '[ ADVANCED: ON ]' : '[ ADVANCED: OFF ]';

  els.composer.hidden = false;
  updateComposerPreview();
  renderFilmstrip(); // highlight the selected gap
  els.composer.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
  els.fSubject.focus();
}

function closeComposer() {
  if (els.composer.hidden && composingKey === null) return;
  composingKey = null;
  els.composer.hidden = true;
  renderFilmstrip();
}

function effectiveVerb() {
  return els.fVerb.value === CUSTOM_VERB
    ? (els.fVerbCustom.value.trim() || PHYSICAL_VERBS[0])
    : els.fVerb.value;
}

/** Read fields -> gap record -> preview + lint + button state. */
function updateComposerPreview() {
  const gap = state.gaps[composingKey];
  if (!gap) return;

  els.fVerbCustom.hidden = els.fVerb.value !== CUSTOM_VERB;

  gap.composer.subject = els.fSubject.value;
  gap.composer.verb = effectiveVerb();
  gap.composer.connective = els.fConnective.value;
  gap.composer.destination = els.fDestination.value;
  gap.composer.cameraId = els.fCamera.value;
  gap.rawText = els.fRaw.value;

  const move = CAMERA_MOVES.find((m) => m.id === gap.composer.cameraId) || CAMERA_MOVES[0];
  els.cameraHint.textContent = move.hint;

  // "...into" verbs take the destination directly — the grammar skips the
  // connective, so reflect that boundary in the UI instead of surprising.
  const skipsConnective = /\binto$/.test(gap.composer.verb);
  els.fConnective.disabled = skipsConnective && !gap.rawMode;
  els.fConnective.title = skipsConnective
    ? 'verbs ending in "into" flow straight into the destination — no connective needed'
    : '';

  const full = gap.rawMode
    ? wrapRawPrompt(gap.rawText)
    : assemblePrompt(gap.composer);
  const body = full.slice(CONTRACT_PREFIX.length, full.length - CONTRACT_SUFFIX.length);

  els.promptPreview.textContent = '';
  const pre = document.createElement('span');
  pre.className = 'contract';
  pre.textContent = CONTRACT_PREFIX;
  const mid = document.createElement('span');
  mid.className = 'body';
  mid.textContent = body;
  const suf = document.createElement('span');
  suf.className = 'contract';
  suf.textContent = CONTRACT_SUFFIX;
  els.promptPreview.append(pre, mid, suf);

  const lintSource = gap.rawMode
    ? gap.rawText
    : `${gap.composer.subject} ${gap.composer.verb} ${gap.composer.destination}`;
  const warnings = lintPrompt(lintSource);
  els.lintBox.textContent = '';
  for (const w of warnings) {
    const d = document.createElement('div');
    d.className = 'lint';
    d.textContent = `⚠ '${w.term}' reads as a canned effect to video models — ${w.suggest}`;
    els.lintBox.appendChild(d);
  }

  updateGenerateButton(gap);
  scheduleSave();
}

function updateGenerateButton(gap) {
  const est = fmtUsd(estimateCost(state.settings.videoModel, state.settings.duration));
  if (gap.status === 'generating') {
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = '[ GENERATING… ]';
    els.composerStatus.textContent = `job ${gap.jobId || '(submitting)'} in flight — ${(gap.lastStatus || 'pending').toUpperCase()}`;
  } else if (gap.status === 'queued') {
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = '[ QUEUED ]';
    els.composerStatus.textContent = `queued — max ${MAX_CONCURRENT} morphs generate at once`;
  } else if (gap.status === 'done') {
    els.btnGenerate.disabled = false;
    els.btnGenerate.textContent = `[ REGENERATE — ${est} ]`;
    els.composerStatus.textContent = `done (${fmtUsd(gap.costUsd)} · ${gap.model || ''}) — regenerating replaces the clip`;
  } else {
    els.btnGenerate.disabled = false;
    els.btnGenerate.textContent = `[ GENERATE — ${est} ]`;
    els.composerStatus.textContent = gap.status === 'failed' ? `previous attempt failed — ${gap.error || ''}` : '';
  }
}

function toggleAdvanced() {
  const gap = state.gaps[composingKey];
  if (!gap) return;
  gap.rawMode = !gap.rawMode;
  els.rawWrap.hidden = !gap.rawMode;
  els.btnAdvanced.textContent = gap.rawMode ? '[ ADVANCED: ON ]' : '[ ADVANCED: OFF ]';
  if (gap.rawMode && !gap.rawText.trim()) {
    // Seed raw mode with the current assembled body so intent carries over.
    const full = assemblePrompt(gap.composer);
    els.fRaw.value = full.slice(CONTRACT_PREFIX.length, full.length - CONTRACT_SUFFIX.length);
    gap.rawText = els.fRaw.value;
  }
  updateComposerPreview();
}

// ------------------------------------------------------------------
// model registry / settings bar
// ------------------------------------------------------------------

const modelInfo = new Map(); // id -> { available: bool|null, durations: number[] }

function registryEntry(id) {
  return MODEL_REGISTRY.find((m) => m.id === id) || null;
}

function estimateCost(modelId, duration) {
  const reg = registryEntry(modelId || state.settings.videoModel);
  if (!reg) return null;
  const d = Number(duration || state.settings.duration) || DEFAULT_DURATION;
  return reg.pricePerSec * Math.max(d, reg.billFloorSec || 0);
}

function renderModelSelect() {
  els.modelSelect.textContent = '';
  for (const m of MODEL_REGISTRY) {
    const info = modelInfo.get(m.id);
    const o = document.createElement('option');
    o.value = m.id;
    const avail = info ? info.available : null;
    o.textContent = `${m.label} — ${fmtUsd(estimateCost(m.id, state.settings.duration))}/clip${avail === false ? ' — UNAVAILABLE' : ''}`;
    o.disabled = avail === false;
    els.modelSelect.appendChild(o);
  }
  els.modelSelect.value = state.settings.videoModel;
  if (els.modelSelect.value !== state.settings.videoModel) {
    // stored selection unavailable — fall back to the first enabled option,
    // and TELL the author (imported projects carry a model choice; never swap silently)
    const firstOk = Array.from(els.modelSelect.options).find((o) => !o.disabled);
    if (firstOk) {
      const wanted = state.settings.videoModel;
      els.modelSelect.value = firstOk.value;
      state.settings.videoModel = firstOk.value;
      showNote(`model "${wanted}" is not available in this Studio build/catalog — switched to ${firstOk.textContent.split(' — ')[0]}`);
    }
  }
  renderModelNote();
  renderDurationSelect();
}

function renderModelNote() {
  const reg = registryEntry(state.settings.videoModel);
  const info = modelInfo.get(state.settings.videoModel);
  const verify = info ? (info.available ? 'verified' : 'UNAVAILABLE') : 'unverified';
  els.modelNote.textContent = reg ? `${reg.note} · ${verify}` : '';
}

function renderDurationSelect() {
  const info = modelInfo.get(state.settings.videoModel);
  const durations = (info && Array.isArray(info.durations) && info.durations.length)
    ? info.durations
    : FALLBACK_DURATIONS;
  els.durationSelect.textContent = '';
  for (const d of durations) {
    const o = document.createElement('option');
    o.value = String(d);
    o.textContent = `${d}s`;
    els.durationSelect.appendChild(o);
  }
  const want = durations.includes(state.settings.duration)
    ? state.settings.duration
    : (durations.includes(DEFAULT_DURATION) ? DEFAULT_DURATION : durations[0]);
  els.durationSelect.value = String(want);
  state.settings.duration = want;
}

async function verifyModels() {
  let models;
  try {
    models = await client.listVideoModels();
  } catch (err) {
    showNote(`model registry: could not verify against /videos/models (${err.message}) — using hardcoded list`);
    return;
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const reg of MODEL_REGISTRY) {
    const m = byId.get(reg.id);
    const frames = (m && Array.isArray(m.supported_frame_images)) ? m.supported_frame_images : [];
    const available = !!m && frames.includes('first_frame') && frames.includes('last_frame');
    const durations = (m && Array.isArray(m.supported_durations))
      ? m.supported_durations.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    modelInfo.set(reg.id, { available, durations: durations.length ? durations : FALLBACK_DURATIONS });
  }
  renderModelSelect();
  const unavailable = MODEL_REGISTRY.filter((m) => modelInfo.get(m.id) && !modelInfo.get(m.id).available);
  if (unavailable.length) {
    showNote(`model(s) unavailable for first+last frame video: ${unavailable.map((m) => m.id).join(', ')}`);
  }
}

function updateSpendUI() {
  els.spendVal.textContent = fmtUsd(sessionSpend);
}

async function refreshCredits() {
  if (!client.hasKey) {
    els.creditsVal.textContent = '—';
    return;
  }
  try {
    const c = await client.getCredits();
    const remaining = Number(c.total_credits) - Number(c.total_usage);
    els.creditsVal.textContent = Number.isFinite(remaining) ? `$${remaining.toFixed(2)}` : '—';
    if (Number.isFinite(remaining) && remaining > 0 && outOfCredits) {
      outOfCredits = false;
      els.creditBanner.hidden = true;
      pump();
    }
  } catch (err) {
    els.creditsVal.textContent = '?';
    showNote(`credits refresh failed — ${err.message}`);
  }
}

// ------------------------------------------------------------------
// generation queue + polling
// ------------------------------------------------------------------

function generatingCount() {
  return Object.values(state.gaps)
    .filter((g) => g.status === 'generating' && !g.pollTimedOut).length;
}

function enqueueGap(k) {
  const gap = state.gaps[k];
  if (!gap || gap.status === 'queued' || gap.status === 'generating') return;
  gap.status = 'queued';
  gap.error = null;
  if (!queue.includes(k)) queue.push(k);
  scheduleSave();
  renderFilmstrip();
  if (composingKey === k) updateGenerateButton(gap);
  pump();
}

function regenerateGap(k) {
  const gap = state.gaps[k];
  if (!gap) return;
  if (!gap.prompt) { openComposer(k); return; }
  // Already-paid clip whose download blipped: re-download free, never re-pay.
  if (gap.downloadOnly && gap.jobId) { redownloadClip(k); return; }
  // Regeneration re-prices against the CURRENT settings.
  gap.model = state.settings.videoModel;
  gap.durationSec = state.settings.duration;
  enqueueGap(k);
}

/** Free retry path: fetch the finished clip for an already-paid job. */
async function redownloadClip(k) {
  const gap = state.gaps[k];
  if (!gap || !gap.jobId) return;
  gap.status = 'generating';
  gap.lastStatus = 're-downloading paid clip';
  refreshGapCard(k);
  try {
    const blob = await client.downloadVideoContent(gap.jobId);
    await db.putClip(gap.uid, { blob, mimeType: 'video/mp4', savedAt: Date.now() });
    setClipUrl(gap.uid, blob);
    gap.status = 'done';
    gap.hasClip = true;
    gap.error = null;
    gap.downloadOnly = false;
    await saveNow();
  } catch (err) {
    // Content endpoint itself failed (404/expired) — only NOW fall back to paid.
    gap.status = 'failed';
    gap.downloadOnly = false;
    gap.error = `paid clip no longer downloadable (${client.scrubText(err.message)}) — RETRY submits a new job`;
    scheduleSave();
  }
  refreshGapCard(k);
  if (composingKey === k) updateGenerateButton(gap);
  pump();
}

function onGenerateClick() {
  const gap = state.gaps[composingKey];
  if (!gap) return;
  const full = gap.rawMode ? wrapRawPrompt(gap.rawText) : assemblePrompt(gap.composer);
  gap.prompt = full;
  gap.model = state.settings.videoModel;
  gap.durationSec = state.settings.duration;
  enqueueGap(composingKey);
}

function onOutOfCredits() {
  outOfCredits = true;
  els.creditBanner.hidden = false;
}

function pump() {
  if (outOfCredits) return;
  const active = new Set(activePairKeys());
  const deferred = [];
  while (queue.length > 0 && generatingCount() < MAX_CONCURRENT) {
    const k = queue.shift();
    const gap = state.gaps[k];
    if (!gap || gap.status !== 'queued') continue;
    // A reorder/removal detached this pair after it was queued — never spend
    // on a stale pair. Keep it queued so it fires if adjacency is restored.
    if (!active.has(k)) { deferred.push(k); continue; }
    startGeneration(k); // async — sets status synchronously below
  }
  queue.push(...deferred);
  renderFilmstrip();
}

async function frameDataUrl(slideUid) {
  const rec = await db.getImage(slideUid);
  if (!rec || !rec.normalized) throw new Error('normalized frame missing from IndexedDB');
  return blobToDataUrl(rec.normalized);
}

async function startGeneration(k) {
  const gap = state.gaps[k];
  if (!gap) return;
  gap.status = 'generating'; // counted by generatingCount() immediately
  gap.jobId = null;
  gap.error = null;
  gap.pollTimedOut = false;
  gap.lastStatus = 'submitting';
  gap.startedAt = Date.now();
  refreshGapCard(k);
  if (composingKey === k) updateGenerateButton(gap);
  scheduleSave();

  try {
    if (!client.hasKey) throw new Error('NO API KEY — open [ KEY ] and paste one');
    const [first, last] = await Promise.all([
      frameDataUrl(gap.fromUid),
      frameDataUrl(gap.toUid),
    ]);
    const job = await client.createVideoJob({
      model: gap.model,
      prompt: gap.prompt,
      duration: gap.durationSec,
      firstFrame: first,
      lastFrame: last,
    });
    if (!job || job.id === undefined || job.id === null) {
      throw new Error('no job id in POST /videos response');
    }
    gap.jobId = String(job.id);
    gap.lastStatus = String(job.status || 'pending');
    await saveNow(); // persist jobId IMMEDIATELY — reload resumes this job
    schedulePoll(k, POLL_MS);
  } catch (err) {
    if (err instanceof OutOfCreditsError) {
      onOutOfCredits();
      gap.status = 'queued'; // intent preserved; frozen until credits return
      if (!queue.includes(k)) queue.unshift(k);
    } else {
      gap.status = 'failed';
      gap.error = client.scrubText(err.message);
    }
    scheduleSave();
  }
  refreshGapCard(k);
  if (composingKey === k) updateGenerateButton(gap);
  pump();
}

function schedulePoll(k, ms) {
  clearTimeout(pollTimers.get(k));
  pollTimers.set(k, setTimeout(() => pollJob(k), ms));
}

async function pollJob(k) {
  const gap = state.gaps[k];
  if (!gap || gap.status !== 'generating' || !gap.jobId) {
    pollTimers.delete(k);
    return;
  }
  if (Date.now() - (gap.startedAt || 0) > POLL_TIMEOUT_MS) {
    gap.pollTimedOut = true; // stays "generating" with jobId — reload resumes
    pollTimers.delete(k);
    scheduleSave();
    refreshGapCard(k);
    showNote(`morph poll timed out after 12 min — the job may still finish; reload the page to resume polling (job ${gap.jobId})`);
    pump();
    return;
  }

  let job;
  try {
    job = await client.getVideoJob(gap.jobId);
  } catch (err) {
    if (err instanceof OutOfCreditsError) onOutOfCredits();
    gap.lastStatus = 'poll error (retrying)';
    refreshGapCard(k);
    schedulePoll(k, POLL_MS);
    return;
  }

  const st = String(job.status || '').toLowerCase();
  gap.lastStatus = st || 'unknown';

  if (st === 'completed') {
    try {
      const blob = await client.downloadVideoContent(gap.jobId);
      await db.putClip(gap.uid, { blob, mimeType: 'video/mp4', savedAt: Date.now() });
      setClipUrl(gap.uid, blob);
      gap.status = 'done';
      gap.hasClip = true;
      gap.error = null;
      const cost = Number(job.usage && job.usage.cost);
      gap.costUsd = Number.isFinite(cost) ? cost : null;
      if (Number.isFinite(cost)) sessionSpend += cost;
      updateSpendUI();
      await saveNow();
      refreshCredits(); // fire-and-forget refresh after each completed job
    } catch (err) {
      gap.status = 'failed';
      // The generation is already PAID and downloadable at /videos/{jobId}/content —
      // flag it so RETRY re-downloads instead of submitting a fresh paid job.
      gap.downloadOnly = true;
      gap.error = `clip download failed (job is paid & ready) — RETRY re-downloads free — ${client.scrubText(err.message)}`;
      scheduleSave();
    }
    pollTimers.delete(k);
    refreshGapCard(k);
    if (composingKey === k) updateGenerateButton(gap);
    pump();
  } else if (st === 'failed' || st === 'cancelled' || st === 'expired') {
    gap.status = 'failed';
    const detail = job.error && (job.error.message || job.error);
    gap.error = detail ? client.scrubText(String(detail)).slice(0, 300) : `job ${st}`;
    scheduleSave();
    pollTimers.delete(k);
    refreshGapCard(k);
    if (composingKey === k) updateGenerateButton(gap);
    pump();
  } else {
    refreshGapCard(k);
    schedulePoll(k, POLL_MS);
  }
}

/** On load: resume every persisted in-flight job; re-queue queued ones. */
function resumeJobs() {
  let resumed = 0;
  for (const [k, gap] of Object.entries(state.gaps)) {
    if (gap.status === 'generating') {
      if (gap.jobId) {
        gap.pollTimedOut = false;
        gap.startedAt = Date.now(); // fresh 12-minute polling window
        schedulePoll(k, 1000 + resumed * 700); // stagger the first polls
        resumed += 1;
      } else {
        gap.status = 'failed';
        gap.error = 'interrupted before a job id was recorded — retry';
      }
    } else if (gap.status === 'queued') {
      if (!queue.includes(k)) queue.push(k);
    }
  }
  if (resumed > 0) showNote(`resumed polling ${resumed} in-flight generation job(s)`);
  pump();
}

// ------------------------------------------------------------------
// preview modal (reuses Player from ./player.js via a shim preloader)
// ------------------------------------------------------------------

function presentSlides() {
  return state.slides.filter((s) => !s.missing);
}

function openPreview(startUid) {
  const slides = presentSlides();
  if (slides.length === 0) return;
  let start = slides.findIndex((s) => s.uid === startUid);
  if (start < 0) start = 0;

  const shim = {
    deck: { slides: slides.map((s) => ({ title: s.title || '', image: { src: '' } })) },
    imageSrc: (i) => imageUrls.get(slides[i].uid) || '',
    getTransition: (f, t) => {
      const gap = state.gaps[pairKey(slides[f].uid, slides[t].uid)];
      if (!gap) return null;
      const url = gap.status === 'done' ? (clipUrls.get(gap.uid) || null) : null;
      return { forwardUrl: url, reverseUrl: null, durationSec: gap.durationSec };
      // reverseUrl stays null: Back = crossfade. Reverse clips are an
      // ffmpeg concern of the pipeline, not Studio.
    },
    markFailed: () => { /* session-local preview — nothing to retire */ },
  };

  // ONE Player for the app's lifetime: each Player constructor attaches
  // listeners to the shared <video>; recreating per-open accumulates them.
  if (!pvPlayer) {
    pvPlayer = new Player({
      stage: els.pvStage,
      slideImg: els.pvSlide,
      video: els.pvVideo,
      fadeImg: els.pvFade,
      preloader: shim,
    });
    pvPlayer.addEventListener('statechange', (e) => {
      els.pvCounter.textContent = `${e.detail.index + 1} / ${pvPlayer.deck.slides.length}`;
    });
  } else {
    pvPlayer.preloader = shim;
    pvPlayer.deck = shim.deck;
  }
  els.previewModal.hidden = false;
  pvPlayer.start(start);
}

function closePreview() {
  if (els.previewModal.hidden) return;
  els.previewModal.hidden = true;
  if (pvPlayer) pvPlayer.cancelInFlight(); // keep the instance — listeners stay singular
  try { els.pvVideo.pause(); } catch { /* ignore */ }
  els.pvVideo.removeAttribute('src');
}

// ------------------------------------------------------------------
// key drawer (BYOK)
// ------------------------------------------------------------------

function storedKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

function renderKeyUI() {
  const key = storedKey();
  els.btnKey.textContent = key ? `[ KEY: ●●●${key.slice(-4)} ]` : '[ KEY: NONE ]';
  els.keyState.textContent = key
    ? `key on file: ●●●●${key.slice(-4)} (localStorage "${KEY_STORAGE}")`
    : 'no key saved — paste one above, then [ SAVE KEY ]';
}

function openDrawer() {
  els.drawerScrim.hidden = false;
  els.keyDrawer.hidden = false;
  renderKeyUI();
  els.keyInput.focus();
}

function closeDrawer() {
  els.drawerScrim.hidden = true;
  els.keyDrawer.hidden = true;
  els.keyInput.value = '';
}

function saveKey() {
  const key = els.keyInput.value.trim();
  if (!key) {
    els.keyReport.textContent = 'ERR: paste a key first';
    return;
  }
  try { localStorage.setItem(KEY_STORAGE, key); } catch (err) {
    els.keyReport.textContent = `ERR: localStorage write failed — ${err.message}`;
    return;
  }
  client.setKey(key);
  els.keyInput.value = '';
  els.keyReport.textContent = 'key saved to this browser.';
  outOfCredits = false;
  els.creditBanner.hidden = true;
  renderKeyUI();
  refreshCredits();
  pump();
}

async function testKey() {
  const stored = storedKey();
  const candidate = els.keyInput.value.trim() || stored;
  if (!candidate) {
    els.keyReport.textContent = 'ERR: no key to test — paste one above';
    return;
  }
  els.keyReport.textContent = 'testing…';
  client.setKey(candidate);
  try {
    const [info, credits] = await Promise.all([client.checkKey(), client.getCredits()]);
    const remaining = Number(credits.total_credits) - Number(credits.total_usage);
    const lines = [
      'KEY OK',
      `  credits remaining .... ${Number.isFinite(remaining) ? '$' + remaining.toFixed(2) : '?'}`,
      `  total usage .......... ${Number.isFinite(Number(credits.total_usage)) ? '$' + Number(credits.total_usage).toFixed(2) : '?'}`,
      `  per-key limit left ... ${info.limit_remaining === null || info.limit_remaining === undefined ? 'unlimited' : '$' + Number(info.limit_remaining).toFixed(2)}`,
      `  key expiry ........... ${info.expires_at ? info.expires_at : 'never'}`,
    ];
    if (candidate !== stored) lines.push('', '(tested key is NOT saved yet — hit [ SAVE KEY ] to keep it)');
    els.keyReport.textContent = lines.join('\n');
    if (Number.isFinite(remaining)) {
      els.creditsVal.textContent = `$${remaining.toFixed(2)}`;
      if (remaining > 0 && outOfCredits) {
        outOfCredits = false;
        els.creditBanner.hidden = true;
        pump();
      }
    }
  } catch (err) {
    els.keyReport.textContent = `ERR: ${client.scrubText(err.message)}`;
    client.setKey(stored); // restore whatever was valid before
  }
}

function forgetKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  client.setKey('');
  els.keyInput.value = '';
  els.keyReport.textContent = 'key forgotten — removed from localStorage.';
  els.creditsVal.textContent = '—';
  renderKeyUI();
}

// ------------------------------------------------------------------
// export: inline deck.json
// ------------------------------------------------------------------

async function exportDeck() {
  const slides = presentSlides();
  if (slides.length === 0) {
    showErr('EXPORT DECK: no slides with images yet');
    return;
  }
  clearErr();
  showNote('exporting deck.json (inlining images + clips as data URIs)…');
  els.btnExportDeck.disabled = true;
  try {
    const deckSlides = [];
    for (let i = 0; i < slides.length; i++) {
      const rec = await db.getImage(slides[i].uid);
      if (!rec || !rec.normalized) throw new Error(`slide ${i + 1}: normalized image missing from IndexedDB`);
      deckSlides.push({
        index: i,
        id: `slide-${String(i + 1).padStart(2, '0')}`,
        title: slides[i].title || '',
        sourceFile: slides[i].sourceName || '',
        image: { src: await blobToDataUrl(rec.normalized), mimeType: 'image/png' },
      });
    }
    const transitions = [];
    let totalCost = 0;
    for (let i = 0; i < slides.length - 1; i++) {
      const gap = state.gaps[pairKey(slides[i].uid, slides[i + 1].uid)];
      if (!gap || gap.status !== 'done') continue;
      const clip = await db.getClip(gap.uid);
      if (!clip || !clip.blob) continue;
      transitions.push({
        fromIndex: i,
        toIndex: i + 1,
        forward: {
          src: await blobToDataUrl(clip.blob),
          mimeType: 'video/mp4',
          durationSec: gap.durationSec ?? state.settings.duration,
        },
        reverse: null,
        prompt: gap.prompt,
        model: gap.model,
        costUsd: gap.costUsd,
      });
      if (Number.isFinite(Number(gap.costUsd))) totalCost += Number(gap.costUsd);
    }
    const deck = {
      schemaVersion: 1,
      deckId: slugify(state.title),
      title: state.title,
      createdAt: new Date().toISOString(),
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      assetBase: '',
      slides: deckSlides,
      transitions,
      meta: {
        generator: GENERATOR,
        videoModel: state.settings.videoModel,
        totalCostUsd: Math.round(totalCost * 10000) / 10000,
      },
    };
    const json = JSON.stringify(deck);
    downloadText(json, 'deck.json');
    const mb = (json.length / (1024 * 1024)).toFixed(1);
    showNote(`deck.json exported — ${mb} MB (everything inlined as data URIs, so it gets BIG). Drag this file onto the SlideMaker OS player page.`);
  } catch (err) {
    showErr(`EXPORT DECK: ${err.message}`);
  } finally {
    els.btnExportDeck.disabled = false;
  }
}

// ------------------------------------------------------------------
// export / import: studio-project.json (shared contract — no binaries, NO key)
// ------------------------------------------------------------------

function contractStatus(gap) {
  // The shared contract knows empty|generating|done|failed.
  // "queued" was never submitted (no jobId) -> exported as "empty".
  if (!gap) return 'empty';
  if (gap.status === 'queued') return 'empty';
  return gap.status;
}

/** The prompt the pipeline should use: frozen at generate time, else the
 *  live assembly of any authored intent (so batch regeneration works for
 *  gaps composed in Studio but never fired here). Untouched gaps stay "". */
function exportPrompt(gap) {
  if (!gap) return '';
  if (gap.prompt) return gap.prompt;
  if (gap.rawMode && gap.rawText.trim()) return wrapRawPrompt(gap.rawText);
  if ((gap.composer.subject || '').trim() || (gap.composer.destination || '').trim()) {
    return assemblePrompt(gap.composer);
  }
  return '';
}

function exportProject() {
  const gaps = [];
  for (let i = 0; i < state.slides.length - 1; i++) {
    const gap = state.gaps[pairKey(state.slides[i].uid, state.slides[i + 1].uid)];
    gaps.push({
      fromIndex: i,
      toIndex: i + 1,
      prompt: exportPrompt(gap),
      composer: {
        subject: gap ? gap.composer.subject || '' : '',
        verb: gap ? gap.composer.verb || '' : '',
        connective: gap ? gap.composer.connective || '' : '',
        destination: gap ? gap.composer.destination || '' : '',
        cameraId: gap ? gap.composer.cameraId || '' : '',
      },
      rawMode: !!(gap && gap.rawMode),
      status: contractStatus(gap),
      jobId: gap ? gap.jobId ?? null : null,
      costUsd: gap ? gap.costUsd ?? null : null,
      model: gap ? gap.model ?? null : null,
    });
  }
  const project = {
    schemaVersion: 1,
    kind: 'slidemaker-studio-project',
    title: state.title,
    createdAt: state.createdAt,
    settings: { videoModel: state.settings.videoModel, duration: state.settings.duration },
    slides: state.slides.map((s, i) => ({
      index: i,
      id: `slide-${String(i + 1).padStart(2, '0')}`,
      title: s.title || '',
      sourceName: s.sourceName || '',
    })),
    gaps,
  };
  downloadText(JSON.stringify(project, null, 2), 'studio-project.json');
  showNote('studio-project.json exported — prompts/settings/titles only, no images, no clips, no key.');
}

async function importProjectFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    showErr(`IMPORT: ${file.name} is not valid JSON — ${err.message}`);
    return;
  }
  if (data && data.schemaVersion === 1 && Array.isArray(data.slides) && data.slides[0] && data.slides[0].image) {
    showErr(`IMPORT: ${file.name} looks like a deck.json — drag it onto the SlideMaker OS player page instead`);
    return;
  }
  if (!data || data.kind !== 'slidemaker-studio-project' || data.schemaVersion !== 1) {
    showErr(`IMPORT: ${file.name} is not a slidemaker-studio-project (schemaVersion 1)`);
    return;
  }
  const hasContent = state.slides.length > 0 || Object.values(state.gaps).some((g) => g.hasClip);
  if (hasContent && Date.now() > importConfirmUntil) {
    importConfirmUntil = Date.now() + 10000;
    showErr('IMPORT will replace the current project (clips stay in the browser store) — import again within 10s to confirm');
    return;
  }
  importConfirmUntil = 0;
  clearErr();

  // Stop any active polling; the imported record takes over.
  for (const t of pollTimers.values()) clearTimeout(t);
  pollTimers.clear();
  queue = [];
  closeComposer();

  state.title = typeof data.title === 'string' && data.title ? data.title : 'UNTITLED DECK';
  state.createdAt = typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString();
  if (data.settings && typeof data.settings === 'object') {
    if (typeof data.settings.videoModel === 'string') state.settings.videoModel = data.settings.videoModel;
    const d = Number(data.settings.duration);
    if (Number.isFinite(d) && d > 0) state.settings.duration = d;
  }

  // Slides become awaiting placeholders, matched by sourceName on re-drop.
  state.slides = (Array.isArray(data.slides) ? data.slides : []).map((s) => ({
    uid: uid('slide'),
    title: (s && typeof s.title === 'string') ? s.title : '',
    sourceName: (s && typeof s.sourceName === 'string') ? s.sourceName : '',
    missing: true,
  }));

  state.gaps = {};
  let clipsLost = 0;
  for (const g of (Array.isArray(data.gaps) ? data.gaps : [])) {
    const from = state.slides[g.fromIndex];
    const to = state.slides[g.toIndex];
    if (!from || !to || g.toIndex !== g.fromIndex + 1) continue;
    const gap = newGap(from.uid, to.uid);
    if (g.composer && typeof g.composer === 'object') {
      gap.composer.subject = String(g.composer.subject || '');
      gap.composer.verb = String(g.composer.verb || '') || gap.composer.verb;
      gap.composer.connective = String(g.composer.connective || '') || gap.composer.connective;
      gap.composer.destination = String(g.composer.destination || '');
      gap.composer.cameraId = String(g.composer.cameraId || '') || gap.composer.cameraId;
    }
    gap.rawMode = !!g.rawMode;
    gap.prompt = typeof g.prompt === 'string' ? g.prompt : '';
    if (gap.rawMode && gap.prompt.startsWith(CONTRACT_PREFIX) && gap.prompt.endsWith(CONTRACT_SUFFIX)) {
      gap.rawText = gap.prompt.slice(CONTRACT_PREFIX.length, gap.prompt.length - CONTRACT_SUFFIX.length);
    }
    gap.model = typeof g.model === 'string' ? g.model : null;
    gap.costUsd = Number.isFinite(Number(g.costUsd)) ? Number(g.costUsd) : null;
    if (g.status === 'generating' && g.jobId) {
      gap.status = 'generating'; // resumable — polling only needs the job id
      gap.jobId = String(g.jobId);
      gap.durationSec = state.settings.duration;
    } else if (g.status === 'failed') {
      gap.status = 'failed';
      gap.error = 'failed in the exported session';
    } else if (g.status === 'done') {
      clipsLost += 1; // project files carry no binaries — clip must be regenerated
    }
    state.gaps[pairKey(from.uid, to.uid)] = gap;
  }

  sessionSpend = 0;
  updateSpendUI();
  renderModelSelect();
  els.titleInput.value = state.title;
  deriveGaps();
  renderFilmstrip();
  await saveNow();
  resumeJobs();

  const names = state.slides.map((s) => s.sourceName).filter(Boolean);
  showNote(`project "${state.title}" imported — re-drop ${state.slides.length} image(s) to fill the slots` +
    (names.length ? ` (${names.join(', ')})` : '') +
    (clipsLost ? `; ${clipsLost} previously-done clip(s) are not in project files — regenerate them` : ''));
}

// ------------------------------------------------------------------
// boot: restore autosave, resume jobs
// ------------------------------------------------------------------

async function restoreFromDb() {
  let rec;
  try {
    rec = await db.loadProject();
  } catch (err) {
    showErr(`could not open the browser store — ${err.message}`);
    return;
  }
  if (!rec) return;

  state.title = rec.title || 'UNTITLED DECK';
  state.createdAt = rec.createdAt || state.createdAt;
  if (rec.settings) {
    if (typeof rec.settings.videoModel === 'string') state.settings.videoModel = rec.settings.videoModel;
    const d = Number(rec.settings.duration);
    if (Number.isFinite(d) && d > 0) state.settings.duration = d;
  }
  state.slides = (Array.isArray(rec.slides) ? rec.slides : []).map((s) => ({
    uid: s.uid, title: s.title || '', sourceName: s.sourceName || '', missing: !!s.missing,
  }));
  state.gaps = {};
  for (const [k, g] of Object.entries(rec.gaps || {})) {
    const gap = newGap(g.fromUid, g.toUid);
    Object.assign(gap, {
      uid: g.uid || gap.uid,
      composer: { ...gap.composer, ...(g.composer || {}) },
      rawMode: !!g.rawMode, rawText: g.rawText || '',
      prompt: g.prompt || '',
      status: g.status || 'empty', jobId: g.jobId ?? null,
      model: g.model ?? null, durationSec: g.durationSec ?? null,
      costUsd: g.costUsd ?? null, error: g.error ?? null,
      startedAt: g.startedAt ?? null, hasClip: !!g.hasClip,
    });
    state.gaps[k] = gap;
  }

  // Rehydrate blobs -> object URLs.
  for (const slide of state.slides) {
    if (slide.missing) continue;
    try {
      const img = await db.getImage(slide.uid);
      if (img && img.normalized) setImageUrl(slide.uid, img.normalized);
      else slide.missing = true; // image record vanished — degrade to awaiting
    } catch {
      slide.missing = true;
    }
  }
  for (const gap of Object.values(state.gaps)) {
    if (!gap.hasClip) continue;
    try {
      const clip = await db.getClip(gap.uid);
      if (clip && clip.blob) setClipUrl(gap.uid, clip.blob);
      else if (gap.status === 'done') {
        gap.status = 'failed';
        gap.error = 'clip missing from the browser store — regenerate';
        gap.hasClip = false;
      }
    } catch { /* leave as-is; playback will fall back to crossfade */ }
  }
}

async function boot() {
  buildComposerStatics();
  renderModelSelect();
  updateSpendUI();

  client.setKey(storedKey());
  renderKeyUI();

  await restoreFromDb();
  deriveGaps();
  els.titleInput.value = state.title;
  renderModelSelect();
  renderFilmstrip();
  resumeJobs();

  verifyModels();   // free, unauthenticated endpoint
  refreshCredits(); // free metadata endpoint (only if a key is on file)
}

// ------------------------------------------------------------------
// wiring
// ------------------------------------------------------------------

els.modelSelect.addEventListener('change', () => {
  state.settings.videoModel = els.modelSelect.value;
  renderModelNote();
  renderDurationSelect();
  if (composingKey) updateGenerateButton(state.gaps[composingKey]);
  renderFilmstrip(); // REGENERATE price tags follow the current model
  scheduleSave();
});
els.durationSelect.addEventListener('change', () => {
  state.settings.duration = Number(els.durationSelect.value) || DEFAULT_DURATION;
  if (composingKey) updateGenerateButton(state.gaps[composingKey]);
  renderFilmstrip();
  scheduleSave();
});
els.titleInput.addEventListener('input', () => {
  state.title = els.titleInput.value;
  scheduleSave();
});

els.btnKey.addEventListener('click', openDrawer);
els.btnCloseDrawer.addEventListener('click', closeDrawer);
els.drawerScrim.addEventListener('click', closeDrawer);
els.btnSaveKey.addEventListener('click', saveKey);
els.btnTestKey.addEventListener('click', testKey);
els.btnForgetKey.addEventListener('click', forgetKey);

els.btnAddImages.addEventListener('click', () => els.filePicker.click());
els.filePicker.addEventListener('change', () => {
  ingestFiles(els.filePicker.files);
  els.filePicker.value = '';
});
els.btnExportDeck.addEventListener('click', exportDeck);
els.btnExportProject.addEventListener('click', exportProject);
els.btnImportProject.addEventListener('click', () => els.projectPicker.click());
els.projectPicker.addEventListener('change', () => {
  const f = els.projectPicker.files && els.projectPicker.files[0];
  els.projectPicker.value = '';
  if (f) importProjectFile(f);
});

els.btnCloseComposer.addEventListener('click', closeComposer);
for (const el of [els.fSubject, els.fVerbCustom, els.fDestination, els.fRaw]) {
  el.addEventListener('input', updateComposerPreview);
}
for (const el of [els.fVerb, els.fConnective, els.fCamera]) {
  el.addEventListener('change', updateComposerPreview);
}
els.btnAdvanced.addEventListener('click', toggleAdvanced);
els.btnGenerate.addEventListener('click', onGenerateClick);

els.pvClose.addEventListener('click', closePreview);
els.pvNext.addEventListener('click', () => pvPlayer && pvPlayer.next());
els.pvBack.addEventListener('click', () => pvPlayer && pvPlayer.back());
els.previewModal.addEventListener('click', (e) => {
  if (e.target === els.previewModal) closePreview();
});

// drag & drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    ingestFiles(e.dataTransfer.files);
  }
});

// keyboard: preview first, then drawer, then composer
document.addEventListener('keydown', (e) => {
  if (!els.previewModal.hidden) {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); if (pvPlayer) pvPlayer.next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (pvPlayer) pvPlayer.back(); }
    else if (e.key === 'Escape') closePreview();
    return;
  }
  if (e.key !== 'Escape') return;
  if (!els.keyDrawer.hidden) { closeDrawer(); return; }
  if (!els.composer.hidden) closeComposer();
});

// 1 Hz ticker: spinner frames + elapsed counters on generating cards
setInterval(() => {
  spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
  for (const spin of els.filmstrip.querySelectorAll('.gapCard.st-generating .spin')) {
    spin.textContent = reducedMotion ? '•' : SPINNER_FRAMES[spinnerFrame];
  }
  for (const el of els.filmstrip.querySelectorAll('.gapCard.st-generating .elapsed')) {
    el.textContent = fmtElapsed(Number(el.dataset.start) || Date.now());
  }
}, 1000);

// flush pending autosave when leaving
window.addEventListener('pagehide', () => {
  if (saveTimer) {
    try { db.saveProject(serializeProject()); } catch { /* best effort */ }
  }
});

boot();
