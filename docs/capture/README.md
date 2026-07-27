# Regenerating the deck's images

Every `.png` and `.gif` in `docs/` is produced by this directory — nothing here is
hand-captured. `docs/slides.md` embeds five of them, and `npm run slides` copies the
whole set into `dist/slides/`.

```bash
npm run docs:capture                      # all eleven assets
npm run docs:capture -- -g homepage.png   # just one (each asset is one test)
npm run docs:capture -- --headed          # watch it happen
```

## Prerequisites

- **ffmpeg** on `PATH` — the GIF encode uses `palettegen`/`paletteuse`.
- **Playwright's own ffmpeg**, which is what records the `.webm` and is a separate
  binary from the system one: `npx playwright install ffmpeg`. It is statically
  linked, so unlike the browsers Playwright downloads it runs on NixOS as-is.
- Nothing else — the config builds the app and starts the production server on
  port 4445 by itself. That build takes minutes, so while iterating, pre-run it
  once and `reuseExistingServer` will skip it:

  ```bash
  VITE_SYNC_INTERVAL_MS=250 npm run build && PORT=4445 npm start
  ```

## What gets captured

Each peer is an isolated browser context, which means its own IndexedDB and so its
own keyhive device and user group — the two-peer assets are genuinely two identities
talking over the relay, not a mock. Content comes from the eleven bundled example
documents in `src/client/home/examples/`, seeded via the empty home page's
"Yes, create examples" offer.

| Asset | Shows |
|---|---|
| `homepage.png` | The document list, seeded with all the bundled examples |
| `settings.png` | The settings index |
| `todo.png` | A populated task list (*Family Groceries*) |
| `link-device.png` | The Link Device sheet with its rendezvous QR code |
| `connections.png` | Connection Debugging, with a second peer connected |
| `sharing.png` | A document's sharing page with two members |
| `new-doc.gif` | FAB → type picker → naming a new task list → adding a task |
| `timeline.gif` | Editing, then scrubbing the version-history slider |
| `linking-a-device.gif` | A device with a library of documents links a second one, which then receives them all |
| `presence-updates.gif` | Two peers in the same task editor; the dot follows the other's field as it moves |
| `add-and-share-with-friend.gif` | Sharing an open document with a new contact by QR, who then opens it |

Referenced by `slides.md`: `homepage.png`, `new-doc.gif`, `connections.png`,
`linking-a-device.gif`, `presence-updates.gif`. The rest are kept current for future decks.

## Layout

| File | Role |
|---|---|
| `playwright.config.ts` | Phone viewport (430×932), video on, its own `testMatch` |
| `cursor.ts` | The injected pointer overlay, plus `tap` / `glide` / `type` |
| `gif.ts` | ffmpeg wrappers: `toGif`, `hstackGif` |
| `support.ts` | `capturePeer`, `take` / `takePair`, `seedExamples`, `still`, `befriend`, `share` |
| `assets.capture.ts` | One test per asset |

Tests are named `*.capture.ts`, and this directory is outside the root config's
`testDir` — so `npm run test:pw` never runs them, and a capture run never drags the
test suite along.

## Adding an asset

Add a `test('<filename>', …)` to `assets.capture.ts`:

- **A still** — `capturePeer(browser, name)`, drive `peer.page`, then `still(page, 'x.png')`.
- **A screencast** — `capturePeer(browser, name, { video: true })`, do the setup on
  `peer.page`, then `take(peer, async page => { … })` and hand the clip to `toGif`.
- **Two panes side by side** — `takePair(left, right, async (l, r) => { … })` → `hstackGif`.

Drive screencasts with `tap()`/`tapAndType()` from `cursor.ts` rather than
`locator.click()`. Playwright does not record the mouse, so the overlay in
`cursor.ts` follows real pointer events instead — and `locator.click()` teleports the
pointer, which produces a cursor that jumps with no visible travel.

## Things that bite

- **Video is per page and starts when the page is created.** `take()` therefore runs
  setup on one page and the recorded flow on a second, and measures the clip window
  from the second page's creation — otherwise every GIF opens with several seconds
  of WASM and keyhive boot.
- **Native dialogs are load-bearing.** `prompt`/`confirm` gate contact naming, the
  add-device settings sync, rename and archive. `capturePeer` installs a handler;
  set the answer with `peer.setPromptAnswer(…)` before triggering one.
- **`md-*` elements are shadow DOM** — match `md-list-item` by `hasText` substring,
  never an anchored regex (innerText carries a trailing newline).
- **Presence dedupe hides your own devices**, and collapses one user's devices into a
  single dot. Two distinct identities are required or `presence-updates.gif` shows
  nothing.
- **`create-examples` only renders on an empty home page**, so anything using it must
  start from a fresh context.
- **Direct WebRTC is opportunistic.** `connections.png` prefers a `direct (P2P)` dot
  but falls back to `via relay` with a warning rather than failing.
- **Do not downscale to save bytes — it costs them.** `hstackGif`'s `width` option
  makes these *bigger*: lanczos turns crisp UI text into anti-aliased gradients, and
  a GIF cannot compress those. `add-and-share-with-friend.gif` went 1.3 MB → 2.7 MB
  at `width: 720`. Lower `fps` instead; that is the lever that works on flat UI.
- **`video.path()` is a trap.** Playwright only guarantees a recording is on disk
  once the whole *context* closes, and a capture still has work to do in that
  context. `finishRecording` uses `saveAs()`, which waits; encoding from `path()`
  intermittently fails with "No such file or directory".
- **Sheets that open themselves.** The sharing page pops its QR invite automatically
  when a document has no members and you have no contacts. Clicking "Add people" at
  that moment hits the sheet's own full-screen overlay and *dismisses* it — the raw
  `page.mouse` calls `tap()` uses skip actionability checks, so this fails silently.
  If a flow mysteriously does nothing, suspect an overlay and check with
  `locator.click()`, which reports the interception instead of swallowing it.
