// js/grammar.js — the FIXED quality boundaries for morph-transition prompts. v2.
// The tool's opinion; the user supplies intent, never the rules.
//
// v2 is grounded in three fields of research (July 2026):
//   1. Match-cut editing grammar: a transition is justified by shape/color/
//      movement continuity — purpose first, decoration never.
//   2. Cross-model prompt structure (official Veo/Kling guides): CAMERA-FIRST
//      field ordering; models weight early tokens hardest. Timestamp beats
//      ([00:00-00:02] ...) are Veo-native and Kling-3-tolerated when used as
//      beats WITHIN one shot, never as separate shots.
//   3. Morph-community formulas: name the start subject, the end subject, AND
//      the invariant (the "anchor" the eye tracks); split the action verb from
//      the morph TEXTURE (how matter behaves); lock lighting/color grade;
//      default slow + eased motion; one dominant action per prompt.
//
// The assembled v2 formula (fixed order, optional fields collapse away):
//   [beats?] + [camera] : [subject] [verb] [connective?] [destination]
//   [, texture?][, anchor-hold?][, motion?][. lighting?][. styleTail?]

/** Physical transformation verbs — causal, continuous, filmable. */
export const PHYSICAL_VERBS = [
  'stretches', 'unfurls', 'blooms', 'dissolves into', 'flows into',
  'collapses into', 'folds into', 'melts into', 'grows into', 'splinters into',
  'ripples into', 'crystallizes into', 'ignites into', 'unravels into',
  'reassembles into', 'erupts into', 'drifts into', 'spirals into',
];

/** Connective language binding two states into one continuous action. */
export const CONNECTIVES = [
  'as', 'revealing', 'which becomes', 'reaching into', 'unfolding into',
  'carrying us into', 'opening onto', 'giving way to',
];

/**
 * Morph TEXTURES — how the matter itself behaves during the change.
 * Distinct from the verb (the action): pros specify both.
 */
export const TEXTURES = [
  'dissolving into liquid', 'reshaping grain by grain', 'fusing seamlessly',
  'warping like heat haze', 'crystallizing into place',
  'unweaving into threads of light', 'scattering into particles and reassembling',
  'melting like slow film burn',
];

/** Anchor suggestions — the invariant the eye tracks through the morph. */
export const ANCHOR_SUGGESTIONS = [
  'the frame center', 'the horizon line', "the subject's silhouette",
  'the dominant light direction', 'the green phosphor glow', 'the held gaze',
];

/**
 * Motion intensity levels. Research default: slow + eased reads as continuity;
 * speed only via a NAMED move (whip pan), never a bare "fast".
 */
export const MOTION_LEVELS = [
  { id: 'glacial',  label: 'glacial',  phrase: 'in extreme slow motion, easing in and out' },
  { id: 'slow',     label: 'slow',     phrase: 'slowly and smoothly, easing in and out' },
  { id: 'measured', label: 'measured', phrase: 'at a measured, steady pace' },
  { id: 'brisk',    label: 'brisk',    phrase: 'briskly, in one confident accelerating sweep' },
  { id: 'whip',     label: 'whip',     phrase: 'in one whip-fast blur of motion' },
];

/** Default lighting/grade continuity clause (toggleable text, ON by default). */
export const LIGHTING_DEFAULT = 'Consistent lighting and color grade throughout';

/**
 * Named camera moves. `hint` explains what the move is FOR — authors pick by
 * purpose, not by name. Emitted FIRST in the assembled prompt (SOTA ordering).
 */
export const CAMERA_MOVES = [
  { id: 'dolly-in',   label: 'dolly in',    phrase: 'The camera dollies forward', hint: 'Push INTO an object so it fills frame and becomes the next scene' },
  { id: 'dolly-out',  label: 'dolly out',   phrase: 'The camera dollies back', hint: 'Pull away to reveal the next scene was around us all along' },
  { id: 'truck',      label: 'truck left/right', phrase: 'The camera trucks sideways', hint: 'Slide laterally — reveal image 2 as if it were always beside image 1' },
  { id: 'crane-up',   label: 'crane up',    phrase: 'The camera cranes upward', hint: 'Rise out of image 1 into a wide reveal of image 2' },
  { id: 'crane-down', label: 'crane down',  phrase: 'The camera cranes down', hint: 'Descend from overview into the detail of image 2' },
  { id: 'whip-pan',   label: 'whip pan',    phrase: 'The camera whip-pans in a blur', hint: 'Hide the join inside motion blur' },
  { id: 'rack-focus', label: 'rack focus',  phrase: 'The focus racks from foreground to background', hint: 'Let blur unlock a hidden second image sharpening into view' },
  { id: 'dolly-zoom', label: 'dolly zoom',  phrase: 'The camera dolly-zooms, warping perspective', hint: 'Disorienting, dreamlike morph between spaces' },
  { id: 'orbit',      label: 'orbit',       phrase: 'The camera orbits the subject', hint: 'Circle round to reveal the transformed subject from the other side' },
  { id: 'static',     label: 'locked off',  phrase: 'The camera holds perfectly still', hint: 'Let the transformation carry everything — strongest with a graphic match' },
];

/** Match-type coaching chips — education, not enforcement. */
export const MATCH_HINTS = [
  { id: 'graphic',  label: 'graphic match',  hint: 'Join on a shared shape or color — pick an element in image 1 whose silhouette lives on in image 2 (bone → satellite).' },
  { id: 'movement', label: 'movement match', hint: 'Continue one motion across the join — something already moving in image 1 keeps moving and becomes image 2.' },
  { id: 'purpose',  label: 'purpose first',  hint: 'If a hard cut would work fine, don’t dress it up. The morph must clarify or heighten the story beat.' },
];

/** Consensus default negative prompt (short, safety net — not the control surface). */
export const NEGATIVE_DEFAULT =
  'cut, jump cut, fade, dissolve, flash, strobe, flicker, morphing artifacts, ' +
  'warped faces, extra limbs, glitch, jitter, ghosting, duplicate frames, ' +
  'text, watermark, logo, subtitles, camera shake, blurry, low quality, deformed';

/** Editing-room vocabulary — reads as a canned post effect; always linted. */
export const BANNED_EDITING = [
  { term: 'transition', suggest: 'describe the physical change itself (e.g. "the window stretches into...")' },
  { term: 'fade',       suggest: 'try "dissolves into", "melts into", or "drifts into"' },
  { term: 'blend',      suggest: 'try "flows into" or "reassembles into"' },
  { term: 'crossfade',  suggest: 'try "dissolves into" with a named camera move' },
  { term: 'wipe',       suggest: 'try "the camera trucks sideways, revealing..."' },
  { term: 'cut to',     suggest: 'bind the states instead: "which becomes", "revealing"' },
  { term: 'jump cut',   suggest: 'use a whip pan to hide the join inside motion blur' },
  { term: 'montage',    suggest: 'this is ONE continuous shot — describe a single motion' },
  { term: 'cutaway',    suggest: 'stay in the shot — describe what the camera does instead' },
  { term: 'split screen', suggest: 'describe one unified frame' },
  { term: 'flashback',  suggest: 'describe the change as physically happening now' },
  { term: 'scene change', suggest: 'describe the scene TRANSFORMING, not changing' },
];

/** Discontinuity vocabulary — invites cuts, jumps, and multi-action mush. */
export const BANNED_DISCONTINUITY = [
  { term: 'flash',    suggest: 'brightness spikes read as cuts — try "the light swells"' },
  { term: 'strobe',   suggest: 'try a continuous light change instead' },
  { term: 'glitch',   suggest: 'if you want digital texture, try "the image ripples like a broken signal" (still risky)' },
  { term: 'teleport', suggest: 'move the camera or morph the space — never jump it' },
  { term: 'suddenly', suggest: 'continuity words work better: "gradually", "steadily"' },
  { term: 'abruptly', suggest: 'try "decisively" with an eased motion level' },
  { term: 'instantly', suggest: 'give the change duration — "over a single breath"' },
  { term: 'at the same time', suggest: 'ONE dominant action per morph — sequence with "then" via beats instead' },
  { term: 'while also', suggest: 'one dominant action — move the extra idea to a beat or drop it' },
];

/**
 * Camera-choreography phrases that legitimately contain banned stems
 * ("arcs into a tilt", "transitions into a crane") — masked before linting.
 */
const CHOREOGRAPHY_WHITELIST = [
  /\b(?:arcs?|settles?|resolves?|eases?|flows?|sweeps?)\s+into\b/gi,
  /\btransitions?\s+into\s+(?:a|an|the)?\s*(?:tilt|pan|dolly|crane|orbit|zoom|track(?:ing)?|whip|push|pull)\b/gi,
];

/** Stems used by the one-dominant-action lint. */
const TRANSFORM_STEMS = [
  'stretch', 'unfurl', 'bloom', 'dissolv', 'flow', 'collaps', 'fold', 'melt',
  'grow', 'splinter', 'rippl', 'crystalliz', 'ignit', 'unravel', 'reassembl',
  'erupt', 'drift', 'spiral', 'morph', 'reshap', 'fus', 'warp', 'scatter',
  'unweav', 'transform',
];

/** The fixed continuity contract wrapped around EVERY prompt (non-editable). */
export const CONTRACT_PREFIX =
  'One single continuous shot, no cuts, no fades to black, no text overlays. ' +
  'Starting exactly on the first frame: ';
export const CONTRACT_SUFFIX =
  ' The motion settles and resolves exactly into the final frame.';

const trimTail = (s) => String(s || '').trim().replace(/[.\s]+$/, '');

function cameraPhraseFor(c) {
  if (c.cameraPhrase && String(c.cameraPhrase).trim()) {
    return trimTail(c.cameraPhrase);
  }
  const m = CAMERA_MOVES.find((x) => x.id === c.cameraId) ?? CAMERA_MOVES[0];
  return m.phrase;
}

function motionPhraseFor(id) {
  const m = MOTION_LEVELS.find((x) => x.id === id);
  return m ? m.phrase : '';
}

/** Format seconds as [MM:SS-MM:SS] (Veo-style, minute-safe). */
function beatStamp(start, end) {
  const f = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  return `[${f(start)}-${f(end)}]`;
}

/**
 * Assemble the final prompt from composer fields (the fixed v2 formula,
 * CAMERA FIRST). All fields optional except subject/destination defaults.
 *
 * @param {object} c {
 *   cameraId, cameraPhrase?,            // named move or custom phrase
 *   subject, verb, connective, destination,
 *   texture?, anchor?, motion?,         // v2 direction knobs
 *   lighting?  (string|false)           // false/'' = omit; default clause used when true/undefined? NO — studio passes resolved text or ''
 *   styleTail?,
 *   beats?: [{start,end,text}],         // intra-shot beats, seconds
 *   verbosity?: 'minimal'|'directed'    // default 'directed'
 * }
 */
export function assemblePrompt(c) {
  const camera = cameraPhraseFor(c);
  const anchor = trimTail(c.anchor);
  const verbosity = c.verbosity === 'minimal' ? 'minimal' : 'directed';

  if (verbosity === 'minimal') {
    // Trust the frames: contract + camera + anchor only (Kling/Luma do their
    // best interpolation nearly promptless when both frames are strong).
    const holdClause = anchor ? `, while ${anchor} holds fixed` : '';
    return CONTRACT_PREFIX + `${camera}${holdClause}.` + CONTRACT_SUFFIX;
  }

  const subject = trimTail(c.subject) || 'the central element of the scene';
  const verb = (c.verb || PHYSICAL_VERBS[0]).trim();
  const connective = (c.connective || 'revealing').trim();
  const destination = trimTail(c.destination) || 'the next scene';

  // Verbs already ending in "into" take the destination directly.
  const action = /\binto$/.test(verb)
    ? `${subject} ${verb} ${destination}`
    : `${subject} ${verb}, ${connective} ${destination}`;

  const parts = [`${camera}: ${action}`];
  const texture = trimTail(c.texture);
  if (texture) parts.push(texture);
  if (anchor) parts.push(`while ${anchor} holds fixed`);
  const motion = motionPhraseFor(c.motion);
  if (motion) parts.push(motion);

  let body = parts.join(', ') + '.';
  const lighting = trimTail(c.lighting);
  if (lighting) body += ` ${lighting}.`;
  const styleTail = trimTail(c.styleTail);
  if (styleTail) body += ` ${styleTail}.`;

  if (Array.isArray(c.beats) && c.beats.length > 0) {
    const beatLines = c.beats
      .filter((b) => b && String(b.text || '').trim())
      .map((b) => `${beatStamp(b.start, b.end)} ${trimTail(b.text)}.`);
    if (beatLines.length > 0) body += ` Timing: ${beatLines.join(' ')}`;
  }

  return CONTRACT_PREFIX + body + CONTRACT_SUFFIX;
}

/** Wrap a raw (advanced-mode) prompt in the same fixed contract. */
export function wrapRawPrompt(raw) {
  const body = trimTail(raw);
  return CONTRACT_PREFIX + body + '.' + CONTRACT_SUFFIX;
}

/** Mask whitelisted camera-choreography phrases so they don't false-positive. */
function maskChoreography(text) {
  let t = String(text || '');
  for (const re of CHOREOGRAPHY_WHITELIST) t = t.replace(re, ' ');
  return t;
}

/**
 * Lint text against banned vocabulary (editing-room + discontinuity).
 * Inflection-tolerant (s/d/ed/ing). Camera choreography is whitelisted first.
 * @returns {{term:string, suggest:string, kind:'editing'|'discontinuity'}[]}
 */
export function lintPrompt(text) {
  const t = maskChoreography(String(text || '').toLowerCase());
  const hit = ({ term }) =>
    new RegExp(`\\b${term.replace(/ /g, '\\s+')}(?:es|s|d|ed|ing)?\\b`, 'i').test(t);
  return [
    ...BANNED_EDITING.filter(hit).map((w) => ({ ...w, kind: 'editing' })),
    ...BANNED_DISCONTINUITY.filter(hit).map((w) => ({ ...w, kind: 'discontinuity' })),
  ];
}

/**
 * One-dominant-action lint: subject and destination should be NOUNS — any
 * transformation verb hiding in them competes with the chosen verb+texture
 * and produces multi-action mush.
 * @returns {string[]} offending stems (empty = clean)
 */
export function lintDominantAction(c) {
  const nounFields = `${c.subject || ''} ${c.destination || ''}`.toLowerCase();
  return TRANSFORM_STEMS.filter((stem) => new RegExp(`\\b${stem}\\w*`, 'i').test(nounFields));
}

/**
 * Frame-pair lint: strongly divergent palettes between the two frames are the
 * top cause of "lens switch" cuts in interpolation models. Pure function over
 * ImageData-like objects ({data:Uint8ClampedArray,width,height}) — testable.
 * @returns {{warnings:string[], stats:{lumaA:number,lumaB:number,hueA:number|null,hueB:number|null}}}
 */
export function lintFramePair(a, b) {
  const avg = (img) => {
    let r = 0, g = 0, bl = 0, n = 0;
    const step = 4 * 16; // sample every 16th pixel
    for (let i = 0; i < img.data.length; i += step) {
      r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2]; n++;
    }
    r /= n; g /= n; bl /= n;
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const sat = max === 0 ? 0 : (max - min) / max;
    let hue = null;
    if (max - min > 8) { // only meaningful when saturated
      if (max === r) hue = ((g - bl) / (max - min)) % 6;
      else if (max === g) hue = (bl - r) / (max - min) + 2;
      else hue = (r - g) / (max - min) + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return { luma, hue, sat };
  };
  const A = avg(a), B = avg(b);
  const warnings = [];
  const hueDist = (A.hue !== null && B.hue !== null)
    ? Math.min(Math.abs(A.hue - B.hue), 360 - Math.abs(A.hue - B.hue))
    : 0;
  if (hueDist > 90 && A.sat > 0.25 && B.sat > 0.25) {
    warnings.push(
      'start/end palettes differ sharply — interpolation models may cut instead of morph; consider naming a shared color or the light direction as the anchor',
    );
  }
  if (Math.abs(A.luma - B.luma) > 96) {
    warnings.push(
      'start/end brightness differs strongly — lock it with the lighting-continuity clause or describe the light change explicitly (e.g. "the room darkens as...")',
    );
  }
  return { warnings, stats: { lumaA: A.luma, lumaB: B.luma, hueA: A.hue, hueB: B.hue } };
}
