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
