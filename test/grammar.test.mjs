// node test/grammar.test.mjs — pure-function tests for the v2 quality grammar.
import {
  assemblePrompt, wrapRawPrompt, lintPrompt, lintDominantAction, lintFramePair,
  CONTRACT_PREFIX, CONTRACT_SUFFIX, CAMERA_MOVES, MOTION_LEVELS, TEXTURES,
  NEGATIVE_DEFAULT,
} from '../js/grammar.js';

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) { failures++; console.error('FAIL:', msg); }
};

// --- assemblePrompt v2: camera-first ordering -------------------------------
const full = assemblePrompt({
  cameraId: 'dolly-in',
  subject: 'the lit window in the tower',
  verb: 'stretches',
  connective: 'unfolding into',
  destination: 'a river of light',
  texture: 'unweaving into threads of light',
  anchor: 'the frame center',
  motion: 'slow',
  lighting: 'Consistent lighting and color grade throughout',
  styleTail: 'warm analog film grain',
});
assert(full.startsWith(CONTRACT_PREFIX), 'contract prefix present');
assert(full.endsWith(CONTRACT_SUFFIX), 'contract suffix present');
assert(
  full.indexOf('The camera dollies forward') < full.indexOf('the lit window'),
  'camera phrase comes FIRST (before subject)',
);
assert(full.includes('while the frame center holds fixed'), 'anchor clause emitted');
assert(full.includes('unweaving into threads of light'), 'texture emitted');
assert(full.includes('slowly and smoothly, easing in and out'), 'motion phrase emitted');
assert(full.includes('Consistent lighting and color grade throughout.'), 'lighting clause emitted');
assert(full.includes('warm analog film grain.'), 'style tail emitted');

// --- optional fields collapse cleanly ---------------------------------------
const sparse = assemblePrompt({
  cameraId: 'crane-up', subject: 'the CRT glow', verb: 'blooms',
  connective: 'revealing', destination: 'a sunlit valley',
});
assert(!sparse.includes('while '), 'no anchor clause when anchor empty');
assert(!sparse.includes('undefined') && !sparse.includes('null'), 'no leaked undefined/null');
assert(sparse.includes('The camera cranes upward: the CRT glow blooms, revealing a sunlit valley.'),
  'sparse camera-first sentence shape');

// --- "into" verb rule survives v2 -------------------------------------------
const into = assemblePrompt({
  cameraId: 'static', subject: 'the green text', verb: 'dissolves into',
  connective: 'revealing', destination: 'a swarm of fireflies',
});
assert(into.includes('the green text dissolves into a swarm of fireflies'),
  '"into" verb skips the connective');
assert(!into.includes('dissolves into revealing'), 'no broken "into + connective" join');

// --- custom camera phrase wins ----------------------------------------------
const customCam = assemblePrompt({
  cameraPhrase: 'The camera spirals down through the ceiling fan',
  subject: 'the popcorn bucket', verb: 'unfurls', connective: 'opening onto',
  destination: 'the skyline',
});
assert(customCam.includes('The camera spirals down through the ceiling fan:'),
  'custom camera phrase used verbatim, camera-first');

// --- minimal verbosity mode ---------------------------------------------------
const minimal = assemblePrompt({
  cameraId: 'dolly-in', anchor: 'the horizon line', verbosity: 'minimal',
  subject: 'ignored', verb: 'ignored', destination: 'ignored',
});
assert(minimal.includes('The camera dollies forward, while the horizon line holds fixed.'),
  'minimal mode = contract + camera + anchor only');
assert(!minimal.includes('ignored'), 'minimal mode drops subject/verb/destination');

// --- beats ---------------------------------------------------------------------
const beats = assemblePrompt({
  cameraId: 'dolly-in', subject: 's', verb: 'stretches', connective: 'as', destination: 'd',
  beats: [
    { start: 0, end: 2, text: 'the glow swells' },
    { start: 2, end: 6, text: 'the room reassembles' },
    { start: 6, end: 8, text: 'everything settles' },
  ],
});
assert(beats.includes('Timing: [00:00-00:02] the glow swells. [00:02-00:06] the room reassembles. [00:06-00:08] everything settles.'),
  'beats emitted as intra-shot timestamp lines');

// --- wrapRawPrompt -----------------------------------------------------------
const raw = wrapRawPrompt('the CRT static blooms into fireflies as the camera cranes up');
assert(raw.startsWith(CONTRACT_PREFIX) && raw.endsWith(CONTRACT_SUFFIX), 'raw mode keeps contract');

// --- lint v2: editing + discontinuity + inflections ---------------------------
const lint1 = lintPrompt('a smooth crossfade wipe to the next scene');
assert(lint1.some((w) => w.term === 'crossfade') && lint1.some((w) => w.term === 'wipe'),
  'editing bans fire');
const lint2 = lintPrompt('suddenly the scene flashes and glitches');
assert(lint2.some((w) => w.term === 'suddenly' && w.kind === 'discontinuity'), 'discontinuity: suddenly');
assert(lint2.some((w) => w.term === 'flash'), 'discontinuity: flashes caught by inflection');
assert(lint2.some((w) => w.term === 'glitch'), 'discontinuity: glitches caught');

// --- lint v2: choreography whitelist ------------------------------------------
const choreo = lintPrompt('a slow dolly that transitions into a tilt up, then settles into the final view');
assert(choreo.length === 0, 'camera choreography not flagged (got: ' + choreo.map((w) => w.term).join(',') + ')');
const stillBanned = lintPrompt('then we transition to the next slide');
assert(stillBanned.some((w) => w.term === 'transition'), 'bare "transition" still banned');

// --- one-dominant-action lint --------------------------------------------------
const dom1 = lintDominantAction({ subject: 'the melting clock face', destination: 'a valley' });
assert(dom1.includes('melt'), 'transform verb in subject flagged');
const dom2 = lintDominantAction({ subject: 'the clock face', destination: 'a quiet valley' });
assert(dom2.length === 0, 'noun-only subject/destination clean');

// --- lintFramePair --------------------------------------------------------------
const mk = (r, g, b) => {
  const px = 64;
  const data = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px * 4; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { data, width: 8, height: 8 };
};
const clash = lintFramePair(mk(220, 30, 30), mk(30, 200, 220)); // red vs cyan
assert(clash.warnings.some((w) => w.includes('palettes differ')), 'palette clash warned');
const lumaJump = lintFramePair(mk(240, 240, 240), mk(10, 10, 10)); // white vs black
assert(lumaJump.warnings.some((w) => w.includes('brightness differs')), 'luma jump warned');
const calm = lintFramePair(mk(40, 180, 90), mk(60, 160, 110)); // two greens
assert(calm.warnings.length === 0, 'similar palettes clean');

// --- constants sanity -----------------------------------------------------------
assert(CAMERA_MOVES.length === 10, '10 camera moves');
assert(MOTION_LEVELS.length === 5, '5 motion levels');
assert(TEXTURES.length === 8, '8 textures');
assert(NEGATIVE_DEFAULT.includes('jump cut') && NEGATIVE_DEFAULT.includes('watermark'), 'negative default seeded');

if (failures === 0) console.log('grammar.test v2: all assertions passed');
else { console.error('grammar.test v2: ' + failures + ' FAILURE(S)'); process.exit(1); }
