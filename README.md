# SlideMaker OS — Player

A static, zero-dependency web player for SlideMaker `deck.json` payloads:
slide images with AI-morphing video transitions (slide N is the first frame of
the clip, slide N+1 the last), wrapped in a retro CRT-terminal skin.

Plain HTML/CSS/JS (ES modules). No build step, no CDNs, no network calls other
than fetching the deck assets themselves.

## Run locally

Serve this folder with any static server (ES modules do not work from `file://`):

```
cd player
python -m http.server 8080
```

Then open <http://localhost:8080/>.

Any other static server works too (`npx serve`, `php -S localhost:8080`, ...).

## Load a deck

- **Paste** a `deck.json` payload into the textarea and hit `[ LOAD ]`
- **`[ LOAD DEMO DECK ]`** fetches `decks/the-source-code/deck.json`
- **Drag & drop** a `.json` file anywhere on the page

`[ START ▶ ]` enables once all slide images are decoded and the first two
forward transition clips are buffered; the rest keeps loading in the background.

A tiny self-contained smoke deck lives at `decks/test/deck.json`
(two 1x1 data-URI slides, no transitions) — paste its contents to sanity-check
the player without any assets on disk.

## Controls

| Input                     | Action                       |
| ------------------------- | ---------------------------- |
| `→` / `Space` / `PageDown` / click right half | next (morph forward) |
| `←` / `PageUp` / click left half              | back (reversed morph) |
| `F`                       | fullscreen                   |
| `G`                       | grid overview (Esc closes)   |
| `Home` / `End`            | first / last slide           |
| press again mid-morph     | skip to the end of the clip  |

Missing or failed transition clips fall back to a 350 ms crossfade
(a hard cut under `prefers-reduced-motion`).

## SlideMaker Studio (`studio.html`) — Prompt Engine v2

An interactive **per-transition authoring page** (amber CRT skin) at
[`studio.html`](studio.html) — linked from the player landing as
`[ OPEN STUDIO ]`. Instead of batch-generating a whole deck and hoping, you
step into each transition:

1. **Drop images** anywhere (or `[ + ADD IMAGES ]`). Each is normalized to
   exactly 1280x720 PNG with a **16:9 cover crop** (letterboxing causes
   bar-pumping in morphs). Originals + normalized copies persist in
   IndexedDB (`slidemaker-studio`), so a reload restores everything.
2. The **filmstrip** alternates slide thumbs with **gap cards** — one per
   transition. Click a gap to open the **composer**: slide N full-size on the
   left, slide N+1 on the right, and the prompt engine in the middle. The
   quality boundaries live in [`js/grammar.js`](js/grammar.js) and are not
   editable — the continuity contract is shown dimmed around your words.
3. **`[ GENERATE — $x ]`** fires *just that one* transition through the
   OpenRouter video API (first/last frame = your two slides). Max 2 jobs run
   concurrently; more are queued. Jobs poll every 15 s; the job id is saved
   immediately, so reloading the page **resumes in-flight jobs**.
4. Click any slide thumb to **preview**: the exact same `Player` class as the
   main page plays slide → clip → slide (missing clips crossfade; Back is
   always a crossfade — reverse clips come from the pipeline's ffmpeg step).

### Composer v2 — three tiers (progressive disclosure)

- **ESSENTIALS** (always open, camera-first — models weight early tokens
  hardest): camera move (10 named moves + custom phrase) → subject →
  physical verb (+custom) → connective (+custom) → destination → GENERATE.
- **DIRECTION** (collapsed): anchor — the invariant the eye tracks — with
  suggestion chips, morph texture (how the matter behaves, +custom), motion
  intensity (glacial → whip, default slow), lighting-continuity clause
  (toggle + editable text, ON by default), style tail, match-cut coaching
  chips.
- **FINE CONTROL** (collapsed): verbosity (directed | minimal — minimal
  trusts the frames and emits contract + camera + anchor only), a 3-beat
  intra-shot timeline (ESTABLISH/TRANSFORM/SETTLE, timestamps auto-portioned
  25%/50%/25% of the clip duration), negative prompt (seeded with the
  consensus default; shown only when the model accepts one), `cfg_scale`
  slider (Kling, experimental), `enhancePrompt`/`conditioningScale` (Veo).

Below the assembled preview a dim **`SENT TO MODEL:`** line lists exactly
which knobs the selected model receives (e.g. `prompt + negative_prompt +
cfg_scale, seed omitted`). The lint row warns on editing-room vocabulary
("fade", "crossfade", ...), discontinuity words ("suddenly", "flash"),
multiple competing transform verbs, AND on **frame-pair mismatches** — both
slides are canvas-sampled and strongly divergent palettes/brightness get an
amber warning (mismatched frames are the top cause of "lens switch" cuts).
`[ ADVANCED ]` still swaps in a raw textarea (wrapped in the contract, linted).

### Model picker — full catalog

All OpenRouter image-to-video models, grouped by capability tier and merged
at load with the live `GET /videos/models` catalog:

- **MORPH (first+last frame)** — 10 models: Kling 3.0 Pro (default,
  recommended) / Std / Video O1, WAN 2.7, Veo 3.1 Lite / Fast / flagship,
  Seedance 1.5 Pro (cheapest, unproven) / 2.0 Fast / 2.0.
- **ANIMATE ONLY (first frame; ends in crossfade)** — HappyHorse 1.1 / 1.0,
  Grok Imagine, WAN 2.6 (Hailuo 2.3 is listed but disabled: 1080p-only).
  Picking one shows a persistent amber note on each gap card: the clip
  animates slide N and playback crossfades into slide N+1; the last frame is
  not sent.
- **UNVERIFIED** — new catalog models we have no knowledge-table entry for
  appear automatically (enabled when they accept a first frame; price
  unknown — check `usage.cost`).
- **UNAVAILABLE** — sora-2-pro (no image input support).

Cost estimates honor observed **billing floors** (Kling 3.0 Pro/Std and
WAN 2.7 bill a 5 s minimum). Kling jobs are submitted **without a seed**
(catalog `seed: false`); provider knobs go through the `provider`
passthrough object.

### Morph recipes

`[ SAVE RECIPE ]` names the current composer field set (stored in IndexedDB);
`[ APPLY ]` fills the open composer; `[ APPLY TO ALL EMPTY GAPS ]` stages
fields + assembled prompts on every unwritten gap (with a count + total-cost
confirm — nothing is queued; you still fire each generate). Five built-in
starters ship with Studio (not deletable): **Graphic-Match Dissolve**,
**Camera Dive**, **Whip-Pan Hide**, **Rack-Focus Reveal**,
**Minimal — Trust the Frames**.

**Bring your own key:** `[ KEY ]` opens the drawer. The OpenRouter key is
stored only in this browser's `localStorage` (`slidemaker.openrouter.key`) and
is never written into exports, project files, logs, or error messages. Anyone
with the key can spend credits — prefer a scoped, disposable key.
`[ TEST KEY ]` shows credits remaining, per-key limit, and expiry.

**Exports:**

- `[ EXPORT DECK.JSON ]` — a fully **inline** `deck.json` (images and mp4
  clips as data URIs; `meta.generator = "slidemaker-studio@2.0.0"`). It gets
  big (tens of MB) — drag it onto the player page.
- `[ EXPORT PROJECT ]` — `studio-project.json` (**schemaVersion 2**): per-gap
  prompt, full composer v2 object, raw mode/text, negative/cfg/enhance/
  conditioning knobs, what was actually sent to the model (minus frames),
  status/job/cost/model, plus settings and titles. **No binaries, no key.**
  Studio imports both v1 and v2 files (v1 gaps get defaults for the new
  fields); old in-browser autosaves load unchanged.
- `[ IMPORT PROJECT ]` — restores a project file; slides become "awaiting
  image" slots matched by `sourceName` when you re-drop the files
  (mismatches are warned and appended as new slides).

Test the fixed grammar module with Node (pure ESM, no browser needed):

```
node player/test/grammar.test.mjs
```

## Deploy to GitHub Pages

1. Push this folder's contents to a public repo (deck assets in `decks/` are
   committed on purpose — they ARE the site).
2. Repo **Settings → Pages** → deploy from branch, root (or `/docs` if you put
   the player there).
3. Done. Every URL in the player is relative, so it works unchanged under a
   project subpath like `https://<user>.github.io/<repo>/`.

## deck.json contract (schemaVersion 1)

Produced by the SlideMaker pipeline (`payload` stage). Essentials:

```jsonc
{
  "schemaVersion": 1,
  "deckId": "the-source-code",
  "title": "THE SOURCE CODE",
  "frameWidth": 1280, "frameHeight": 720,
  "assetBase": "",                       // optional URL prefix for relative srcs
  "slides": [
    { "index": 0, "id": "slide-01", "title": "...", "description": "...",
      "sourceFile": "1.jpg",
      "image": { "src": "decks/the-source-code/slides/slide-01.png", "mimeType": "image/png" } }
  ],
  "transitions": [
    { "fromIndex": 0, "toIndex": 1,
      "forward": { "src": ".../t-01-02.mp4",     "mimeType": "video/mp4", "durationSec": 4 },
      "reverse": { "src": ".../t-01-02-rev.mp4", "mimeType": "video/mp4", "durationSec": 4 } }
  ],
  "meta": { "imageTrack": "b", "videoModel": "google/veo-3.1-lite", "totalCostUsd": 0 }
}
```

- `transitions` is optional; any `{fromIndex,toIndex}` pair may be absent and
  `reverse` may be `null` — the player crossfades instead.
- **src resolution rule** (identical in pipeline and player):
  `http://` / `https://` / `data:` srcs are used verbatim; otherwise a
  non-empty `assetBase` (trailing slash trimmed) is prefixed with `/`;
  otherwise the src resolves relative to the page URL.
