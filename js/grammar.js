// js/grammar.js — the FIXED quality boundaries for morph-transition prompts.
// This module is the tool's opinion; the user supplies intent, never the rules.
//
// Grounded in two fields:
//   1. Editing & motion-graphics grammar (match cuts): a transition is justified
//      by shape/color/movement continuity between the two frames — purpose
//      first, decoration never.
//   2. Camera language for AI video models: temporal, causal description of
//      change over time — physical verbs + a named camera move — reads as one
//      continuous take; post-production words ("fade", "blend", "transition")
//      read as canned effects and produce mush.
//
// The assembled formula (fixed):
//   [subject transformation] + [connective] + [destination] + [camera move]
//   + [resolution into the final frame]

/** Physical transformation verbs — causal, continuous, filmable. */
export const PHYSICAL_VERBS = [
  'stretches', 'unfurls', 'blooms', 'dissolves into', 'flows into',
  'collapses into', 'folds into', 'melts into', 'grows into', 'splinters into',
  'ripples into', 'crystallizes into', 'ignites into', 'unravels into',
  'reassembles into', 'erupts into', 'drifts into', 'spirals into',
];

/** Connective language that binds two states into one continuous action. */
export const CONNECTIVES = [
  'as', 'revealing', 'which becomes', 'reaching into', 'unfolding into',
  'carrying us into', 'opening onto', 'giving way to',
];

/**
 * Named camera moves. `hint` explains what the move is FOR (from the field-2
 * table) — shown as tooltips so authors pick by purpose, not by name.
 */
export const CAMERA_MOVES = [
  { id: 'dolly-in',   label: 'dolly in',    phrase: 'the camera dollies forward', hint: 'Push INTO an object so it fills frame and becomes the next scene' },
  { id: 'dolly-out',  label: 'dolly out',   phrase: 'the camera dollies back', hint: 'Pull away to reveal the next scene was around us all along' },
  { id: 'truck',      label: 'truck left/right', phrase: 'the camera trucks sideways', hint: 'Slide laterally — reveal image 2 as if it were always beside image 1' },
  { id: 'crane-up',   label: 'crane up',    phrase: 'the camera cranes upward', hint: 'Rise out of image 1 into a wide reveal of image 2' },
  { id: 'crane-down', label: 'crane down',  phrase: 'the camera cranes down', hint: 'Descend from overview into the detail of image 2' },
  { id: 'whip-pan',   label: 'whip pan',    phrase: 'the camera whip-pans in a blur', hint: 'Hide the join inside motion blur' },
  { id: 'rack-focus', label: 'rack focus',  phrase: 'the focus racks from foreground to background', hint: 'Let blur unlock a hidden second image sharpening into view' },
  { id: 'dolly-zoom', label: 'dolly zoom',  phrase: 'the camera dolly-zooms, warping perspective', hint: 'Disorienting, dreamlike morph between spaces' },
  { id: 'orbit',      label: 'orbit',       phrase: 'the camera orbits the subject', hint: 'Circle round to reveal the transformed subject from the other side' },
  { id: 'static',     label: 'locked off',  phrase: 'the camera holds perfectly still', hint: 'Let the transformation carry everything — strongest with a graphic match' },
];

/** Match-type coaching chips (field 1) — education, not enforcement. */
export const MATCH_HINTS = [
  { id: 'graphic',  label: 'graphic match',  hint: 'Join on a shared shape or color — pick an element in image 1 whose silhouette lives on in image 2 (bone → satellite).' },
  { id: 'movement', label: 'movement match', hint: 'Continue one motion across the join — something already moving in image 1 keeps moving and becomes image 2.' },
  { id: 'purpose',  label: 'purpose first',  hint: 'If a hard cut would work fine, don’t dress it up. The morph must clarify or heighten the story beat.' },
];

/**
 * Post-production vocabulary that reads as a canned effect to video models.
 * Linted with suggestions — never silently rewritten.
 */
export const BANNED_TERMS = [
  { term: 'transition', suggest: 'describe the physical change itself (e.g. "the window stretches into...")' },
  { term: 'fade',       suggest: 'try "dissolves into", "melts into", or "drifts into"' },
  { term: 'blend',      suggest: 'try "flows into" or "reassembles into"' },
  { term: 'crossfade',  suggest: 'try "dissolves into" with a named camera move' },
  { term: 'wipe',       suggest: 'try "the camera trucks sideways, revealing..."' },
  { term: 'cut to',     suggest: 'bind the states instead: "which becomes", "revealing"' },
  { term: 'jump cut',   suggest: 'use a whip pan to hide the join inside motion blur' },
];

/** The fixed continuity contract wrapped around EVERY prompt (non-editable). */
export const CONTRACT_PREFIX =
  'One single continuous shot, no cuts, no fades to black, no text overlays. ' +
  'Starting exactly on the first frame: ';
export const CONTRACT_SUFFIX =
  ', arriving at and resolving exactly into the final frame.';

/**
 * Assemble the final prompt from composer fields (the fixed formula).
 * @param {object} c {subject, verb, connective, destination, cameraId}
 * @returns {string}
 */
export function assemblePrompt(c) {
  const camera = CAMERA_MOVES.find((m) => m.id === c.cameraId) ?? CAMERA_MOVES[0];
  const subject = (c.subject || 'the central element of the scene').trim().replace(/[.\s]+$/, '');
  const verb = (c.verb || PHYSICAL_VERBS[0]).trim();
  const connective = (c.connective || 'revealing').trim();
  const destination = (c.destination || 'the next scene').trim().replace(/[.\s]+$/, '');
  // Verbs that already end in "into" take the destination directly —
  // "dissolves into revealing X" reads broken; "dissolves into X" is the intent.
  const action = /\binto$/.test(verb)
    ? `${subject} ${verb} ${destination}`
    : `${subject} ${verb}, ${connective} ${destination}`;
  return CONTRACT_PREFIX + `${action}, as ${camera.phrase}` + CONTRACT_SUFFIX;
}

/** Wrap a raw (advanced-mode) prompt in the same fixed contract. */
export function wrapRawPrompt(raw) {
  const body = String(raw || '').trim().replace(/[.\s]+$/, '');
  return CONTRACT_PREFIX + body + CONTRACT_SUFFIX;
}

/**
 * Lint text against the banned post-production vocabulary.
 * @returns {{term:string, suggest:string}[]} warnings (empty = clean)
 */
export function lintPrompt(text) {
  const t = String(text || '').toLowerCase();
  // Optional s/d/ed/ing suffix catches inflections (fades, fading, transitions).
  return BANNED_TERMS.filter(({ term }) =>
    new RegExp(`\\b${term.replace(/ /g, '\\s+')}(?:s|d|ed|ing)?\\b`, 'i').test(t),
  );
}
