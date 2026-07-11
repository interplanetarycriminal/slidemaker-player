// test/grammar.test.mjs — sanity tests for the FIXED quality-boundary module.
// Run: node player/test/grammar.test.mjs   (grammar.js is pure ESM — no browser)

import assert from 'node:assert/strict';
import {
  PHYSICAL_VERBS, CONNECTIVES, CAMERA_MOVES, MATCH_HINTS, BANNED_TERMS,
  CONTRACT_PREFIX, CONTRACT_SUFFIX,
  assemblePrompt, wrapRawPrompt, lintPrompt,
} from '../js/grammar.js';

// ---- vocabulary tables exist and are non-empty ----
assert.ok(PHYSICAL_VERBS.length > 0, 'PHYSICAL_VERBS non-empty');
assert.ok(CONNECTIVES.length > 0, 'CONNECTIVES non-empty');
assert.ok(CAMERA_MOVES.length > 0 && CAMERA_MOVES.every((m) => m.id && m.label && m.phrase && m.hint),
  'CAMERA_MOVES entries have id/label/phrase/hint');
assert.equal(MATCH_HINTS.length, 3, 'three match-coaching chips');
assert.ok(BANNED_TERMS.every((b) => b.term && b.suggest), 'BANNED_TERMS have term+suggest');

// ---- assemblePrompt: output shape = PREFIX + "<subject> <verb> <connective> <destination> as <camera phrase>" + SUFFIX ----
const fields = {
  subject: 'the lit window in the tower',
  verb: 'stretches',
  connective: 'revealing',
  destination: 'the sunlit valley of the next scene',
  cameraId: 'dolly-in',
};
const p = assemblePrompt(fields);
assert.equal(typeof p, 'string');
assert.ok(p.startsWith(CONTRACT_PREFIX), 'prompt starts with the fixed contract prefix');
assert.ok(p.endsWith(CONTRACT_SUFFIX), 'prompt ends with the fixed contract suffix');
const body = p.slice(CONTRACT_PREFIX.length, p.length - CONTRACT_SUFFIX.length);
assert.equal(
  body,
  'the lit window in the tower stretches, revealing the sunlit valley of the next scene, as the camera dollies forward',
  'assembled body follows the fixed formula',
);

// ---- verbs ending in "into" take the destination directly (no connective) ----
const into = assemblePrompt({ ...fields, verb: 'dissolves into' });
const intoBody = into.slice(CONTRACT_PREFIX.length, into.length - CONTRACT_SUFFIX.length);
assert.equal(
  intoBody,
  'the lit window in the tower dissolves into the sunlit valley of the next scene, as the camera dollies forward',
  '"...into" verbs skip the connective',
);

// ---- assemblePrompt: defaults fill every hole (never a malformed prompt) ----
const d = assemblePrompt({});
assert.ok(d.startsWith(CONTRACT_PREFIX) && d.endsWith(CONTRACT_SUFFIX));
assert.ok(d.length > CONTRACT_PREFIX.length + CONTRACT_SUFFIX.length, 'defaulted body is non-empty');

// ---- trailing punctuation is normalized before the suffix ----
const punct = assemblePrompt({ ...fields, destination: 'the valley.  ' });
assert.ok(punct.includes('the valley, as the camera'), 'trailing dots/spaces stripped from the destination');
assert.ok(!punct.includes('..'), 'no double punctuation anywhere');

// ---- wrapRawPrompt wraps the same fixed contract around raw text ----
const w = wrapRawPrompt('the bone spins into a satellite.');
assert.equal(w, CONTRACT_PREFIX + 'the bone spins into a satellite' + CONTRACT_SUFFIX);

// ---- lintPrompt catches "crossfade" (and friends), passes clean text ----
const warns = lintPrompt('a slow CROSSFADE into the next scene');
assert.ok(warns.some((x) => x.term === 'crossfade'), 'lint catches "crossfade" (case-insensitive)');
assert.ok(warns.every((x) => typeof x.suggest === 'string' && x.suggest.length > 0), 'warnings carry suggestions');
assert.ok(lintPrompt('the window stretches into the sunlit valley').length === 0, 'clean text lints clean');
assert.ok(lintPrompt('jump   cut to black').some((x) => x.term === 'jump cut'), 'multi-word terms match across whitespace');

console.log('grammar.test: all assertions passed');
