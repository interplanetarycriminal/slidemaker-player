// js/app.js — SlideMaker OS entry point: landing, validation, wiring.
import { Preloader } from './preload.js';
import { Player } from './player.js';
import { Grid } from './grid.js';

// Relative on purpose — works from any static server AND GitHub Pages subpaths.
const DEMO_DECK_URL = 'decks/the-source-code/deck.json';

const $ = (id) => document.getElementById(id);
const els = {
  landing: $('landing'),
  bootLines: $('bootLines'),
  jsonInput: $('jsonInput'),
  btnLoad: $('btnLoad'),
  btnDemo: $('btnDemo'),
  errLine: $('errLine'),
  progressBox: $('progressBox'),
  progressBar: $('progressBar'),
  phaseLabel: $('phaseLabel'),
  btnStart: $('btnStart'),
  readyNote: $('readyNote'),
  stageView: $('stageView'),
  stage: $('stage'),
  slideImg: $('slideImg'),
  transVideo: $('transVideo'),
  fadeImg: $('fadeImg'),
  caption: $('caption'),
  controls: $('controls'),
  btnBack: $('btnBack'),
  btnNext: $('btnNext'),
  counter: $('counter'),
  dots: $('dots'),
  btnGrid: $('btnGrid'),
  btnFs: $('btnFs'),
  gridOverlay: $('gridOverlay'),
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let deck = null;
let preloader = null;
let player = null;
let grid = null;
let started = false;
let loadToken = 0; // guards stale preloader events after a new deck is loaded

// ------------------------------------------------------------------
// boot sequence
// ------------------------------------------------------------------

const BOOT_TEXT = [
  'SLIDEMAKER OS v1.0 — PHOSPHOR DISPLAY SUBSYSTEM',
  'MEM CHECK ........ 640K OK (ENOUGH FOR ANYONE)',
  'INITIALIZING PHOSPHOR ........ OK',
  'MOUNTING REEL DRIVE A: ....... OK',
  'AWAITING DECK PAYLOAD.',
  'READY.',
];

function runBoot() {
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  cursor.textContent = ' ';
  if (reducedMotion) {
    els.bootLines.textContent = BOOT_TEXT.join('\n') + '\n';
    els.bootLines.appendChild(cursor);
    return;
  }
  const textNode = document.createTextNode('');
  els.bootLines.appendChild(textNode);
  els.bootLines.appendChild(cursor);
  let line = 0;
  let ch = 0;
  const tick = () => {
    if (line >= BOOT_TEXT.length) return;
    const cur = BOOT_TEXT[line];
    if (ch < cur.length) {
      textNode.data += cur[ch];
      ch += 1;
      setTimeout(tick, 8 + Math.random() * 16);
    } else {
      textNode.data += '\n';
      line += 1;
      ch = 0;
      setTimeout(tick, 130);
    }
  };
  setTimeout(tick, 250);
}

// ------------------------------------------------------------------
// validation + error banner (never alert())
// ------------------------------------------------------------------

function showError(msg) {
  els.errLine.textContent = `ERR: ${msg}`;
  els.errLine.hidden = false;
}

function clearError() {
  els.errLine.hidden = true;
  els.errLine.textContent = '';
}

/** Throws with a human-readable message when the payload is not a valid deck. */
function validateDeck(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('payload is not a JSON object');
  }
  if (data.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${JSON.stringify(data.schemaVersion)} — expected 1`);
  }
  if (!Array.isArray(data.slides) || data.slides.length === 0) {
    throw new Error('slides[] is missing or empty');
  }
  data.slides.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.image
        || typeof s.image.src !== 'string' || s.image.src.length === 0) {
      throw new Error(`slide ${i} is missing image.src`);
    }
  });
  if (data.transitions !== undefined && data.transitions !== null) {
    if (!Array.isArray(data.transitions)) {
      throw new Error('transitions must be an array when present');
    }
    data.transitions.forEach((t, i) => {
      if (!t || typeof t.fromIndex !== 'number' || typeof t.toIndex !== 'number') {
        throw new Error(`transition ${i} is missing numeric fromIndex/toIndex`);
      }
      if (t.forward && typeof t.forward.src !== 'string') {
        throw new Error(`transition ${i}: forward.src must be a string`);
      }
      if (t.reverse && typeof t.reverse.src !== 'string') {
        throw new Error(`transition ${i}: reverse.src must be a string (or reverse: null)`);
      }
    });
  }
  return data;
}

// ------------------------------------------------------------------
// deck loading (paste / demo fetch / drag-and-drop)
// ------------------------------------------------------------------

function loadDeckFromText(text, sourceLabel) {
  clearError();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    showError(`${sourceLabel}: NOT VALID JSON — ${e.message}`);
    return;
  }
  try {
    validateDeck(data);
  } catch (e) {
    showError(`${sourceLabel}: BAD DECK — ${e.message}`);
    return;
  }
  beginPreload(data);
}

async function loadDemo() {
  clearError();
  els.btnDemo.disabled = true;
  try {
    const res = await fetch(DEMO_DECK_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    loadDeckFromText(text, 'DEMO DECK');
  } catch (e) {
    showError(`DEMO DECK: fetch failed — ${e.message} (is ${DEMO_DECK_URL} deployed?)`);
  } finally {
    els.btnDemo.disabled = false;
  }
}

['dragover', 'dragenter'].forEach((name) => {
  window.addEventListener(name, (e) => e.preventDefault());
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (started) return; // show is running — ignore drops
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const isJson = file.name.toLowerCase().endsWith('.json') || (file.type || '').includes('json');
  if (!isJson) {
    showError(`DROP: ${file.name} — expected a .json file`);
    return;
  }
  try {
    const text = await file.text();
    loadDeckFromText(text, `FILE ${file.name}`);
  } catch (err) {
    showError(`DROP: could not read ${file.name} — ${err.message}`);
  }
});

// ------------------------------------------------------------------
// preload progress UI
// ------------------------------------------------------------------

const BAR_CELLS = 24;

function setBar(pct, phase) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS)));
  els.progressBar.textContent =
    `[${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}] ` +
    `${String(pct).padStart(3, ' ')}% LOADING REELS`;
  if (phase) els.phaseLabel.textContent = `PHASE: ${phase}`;
}

function beginPreload(newDeck) {
  const token = ++loadToken;
  if (preloader) preloader.dispose();
  deck = newDeck;

  preloader = new Preloader(deck);
  els.progressBox.hidden = false;
  els.btnStart.disabled = true;
  els.readyNote.hidden = true;
  els.phaseLabel.textContent = `PHASE: IMAGES — "${deck.title || deck.deckId || 'untitled deck'}"`;
  setBar(0);

  preloader.addEventListener('progress', (e) => {
    if (token !== loadToken) return;
    const { phase, loaded, total } = e.detail;
    const pct = total === 0 ? 100 : Math.round((loaded / total) * 100);
    setBar(pct, `${phase} ${loaded}/${total}`);
  });

  preloader.addEventListener('startready', () => {
    if (token !== loadToken) return;
    els.btnStart.disabled = false;
    els.readyNote.hidden = false;
  });

  preloader.addEventListener('done', () => {
    if (token !== loadToken) return;
    setBar(100, 'ALL REELS LOADED');
  });

  preloader.loadAll().catch((err) => {
    if (token !== loadToken) return;
    showError(`PRELOAD: ${err.message}`);
    els.progressBox.hidden = true;
  });
}

// ------------------------------------------------------------------
// the show
// ------------------------------------------------------------------

function startShow() {
  if (started || !preloader || !preloader.startReady) return;
  started = true;

  els.landing.hidden = true;
  els.stageView.hidden = false;

  player = new Player({
    stage: els.stage,
    slideImg: els.slideImg,
    video: els.transVideo,
    fadeImg: els.fadeImg,
    preloader,
  });
  grid = new Grid({
    container: els.gridOverlay,
    deck,
    preloader,
    onSelect: (i) => {
      grid.close();
      player.jumpTo(i);
    },
  });

  buildDots();
  player.addEventListener('statechange', onStateChange);
  player.addEventListener('edge', onEdge);
  player.start(0);
  pokeUI();
}

function buildDots() {
  els.dots.textContent = '';
  deck.slides.forEach((slide, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.title = `${i + 1}. ${slide.title || ''}`.trimEnd();
    dot.addEventListener('click', () => player.jumpTo(i));
    els.dots.appendChild(dot);
  });
}

function onStateChange(e) {
  const { index } = e.detail;
  Array.from(els.dots.children).forEach((dot, i) => {
    dot.classList.toggle('on', i === index);
  });
  els.counter.textContent = `${index + 1} / ${deck.slides.length}`;
  const title = deck.slides[index].title || '';
  els.caption.textContent = title;
  els.caption.classList.toggle('empty', title.length === 0);
  if (grid) grid.setCurrent(index);
}

function onEdge() {
  // subtle "you're at the edge of the deck" flash on the progress dots
  els.dots.classList.remove('edge-flash');
  void els.dots.offsetWidth; // restart the CSS animation
  els.dots.classList.add('edge-flash');
}

// ------------------------------------------------------------------
// fullscreen + auto-hiding chrome
// ------------------------------------------------------------------

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
  } else {
    const req = els.stage.requestFullscreen || els.stage.webkitRequestFullscreen;
    if (req) req.call(els.stage);
  }
}

let hideTimer = null;
function pokeUI() {
  els.stage.classList.remove('hide-ui');
  clearTimeout(hideTimer);
  if (isFullscreen()) {
    hideTimer = setTimeout(() => els.stage.classList.add('hide-ui'), 3000);
  }
}

// ESC exits fullscreen natively; re-show controls on any fullscreen change.
document.addEventListener('fullscreenchange', pokeUI);
document.addEventListener('webkitfullscreenchange', pokeUI);
document.addEventListener('mousemove', () => { if (started) pokeUI(); });

// ------------------------------------------------------------------
// input wiring
// ------------------------------------------------------------------

els.btnLoad.addEventListener('click', () => {
  const text = els.jsonInput.value.trim();
  if (!text) {
    showError('PASTE: textarea is empty — paste a deck.json payload first');
    return;
  }
  loadDeckFromText(text, 'PASTE');
});
els.btnDemo.addEventListener('click', loadDemo);
els.btnStart.addEventListener('click', startShow);

els.btnNext.addEventListener('click', () => player && player.next());
els.btnBack.addEventListener('click', () => player && player.back());
els.btnGrid.addEventListener('click', () => grid && grid.toggle());
els.btnFs.addEventListener('click', toggleFullscreen);

// click right half of the stage = next, left half = back
els.stage.addEventListener('click', (e) => {
  if (!started || !player) return;
  if (e.target.closest('#controls') || e.target.closest('#gridOverlay') || e.target.closest('button')) {
    return;
  }
  const rect = els.stage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x >= rect.width / 2) player.next();
  else player.back();
});

document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (!started || !player) return;
  pokeUI();
  switch (e.key) {
    case 'ArrowRight':
    case ' ':
    case 'PageDown':
      e.preventDefault();
      player.next();
      break;
    case 'ArrowLeft':
    case 'PageUp':
      e.preventDefault();
      player.back();
      break;
    case 'Home':
      e.preventDefault();
      player.jumpTo(0);
      break;
    case 'End':
      e.preventDefault();
      player.jumpTo(deck.slides.length - 1);
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'g':
    case 'G':
      grid.toggle();
      break;
    case 'Escape':
      if (grid.isOpen) grid.close();
      break;
    default:
      break;
  }
});

// ------------------------------------------------------------------

runBoot();
