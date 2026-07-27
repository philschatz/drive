# Regenerating the deck's images

Every `.png` and `.gif` in `docs/` is produced by this directory — nothing here is
hand-captured. `docs/slides.md` embeds all thirteen of them, and `npm run slides`
copies the whole set into `dist/slides/`.

```bash
npm run docs:capture                      # all thirteen assets
npm run docs:capture -- -g homepage.png   # just one (each asset is one test)
npm run docs:capture -- -g '\.gif'        # only the screencasts
npm run docs:capture -- --headed          # watch it happen
```

Two-peer GIFs used to die intermittently in `finishRecording` with `ENOENT … .webm`.
The cause was `recordVideo.dir` sitting inside Playwright's `outputDir`, so its own
artifact cleanup could delete a recording out from under `saveAs()`; `outputDir` is
now the narrower `.work/pw`. If it reappears, re-running that asset alone still works.

Give a full run a machine to itself. These are two WASM peers apiece and they are
contention-sensitive in a way that shows up in the *output*, not as a failure:
back-to-back, `linking-a-device.gif` stretched from 28s/1.8MB to 104s/9.3MB purely
because the relay handshake and document sync crawled.

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
talking over the relay, not a mock. Two of them (`linking-a-device.gif`,
`device-permissions.gif`) then link those contexts into *one* user with two devices, which
is a different claim and looks it. Content comes from the eleven bundled example
documents in `src/client/home/examples/`, seeded via the empty home page's
"Yes, create examples" offer.

| Asset | Shows |
|---|---|
| `homepage.png` | The document list, seeded with all the bundled examples |
| `settings.png` | The settings index |
| `todo.png` | A populated task list (*Family Groceries*) |
| `connections.png` | Connection Debugging, with a second peer connected |
| `new-doc.gif` | FAB → type picker → kebab → Rename → naming a new task list → adding a task |
| `timeline.gif` | Editing, then scrubbing the version-history slider |
| `linking-a-device.gif` | A device with a library of documents links a second one, which then receives them all |
| `presence-updates.gif` | Two peers in the same task editor; the dot walks down the other's property list — Title, Priority, Description — greying each row they occupy |
| `add-and-share-with-friend.gif` | Sharing an open document with a new contact by QR, who then opens it |
| `datagrid-presence.gif` | Two peers panning and selecting in one sheet: each other's tagged cells, a Monte Carlo histogram, a range's aggregates, an edit propagating |
| `source-presence.gif` | A grid on the left, the same document as JSON on the right: the dot tracks the selected cell, and editing an empty one makes the key appear |
| `validation.gif` | A task list beside its JSON: deleting an optional field regroups the task, and an invalid enum raises a schema error in both panes |
| `device-permissions.gif` | One user's two devices on the same counters document; the second device is walked admin → edit → read → edit → admin from Settings → Devices, and its write affordances vanish and return live |

Every asset above is on a slide — the deck references all thirteen, so a stale capture
is always visible somewhere. Keep it that way when adding one: an asset nothing embeds
is an asset nobody notices has rotted. To check:

```bash
cd docs && for f in *.png *.gif; do grep -q "$f" slides.md || echo "UNREFERENCED: $f"; done
```

Two of the GIFs adjust their fixture before recording, and both tweaks are about the
430px frame rather than cosmetics: `datagrid-presence.gif` unfreezes and narrows the
label column (a 300px *sticky* column sits on top of every tap target to its right),
and `device-permissions.gif` hand-writes its counters document because the bundled example's
completion keys are `{{today-6d@…}}` templates that only the importer expands.

Anything showing two devices names them `📱 Android` and `📱 iOS` via `setDeviceName`.
A device otherwise names itself after the browser it is running in, so both panes
would read the same thing — see the note below about *when* that has to happen.

## Layout

| File | Role |
|---|---|
| `playwright.config.ts` | Phone viewport (430×932), video on, its own `testMatch` |
| `cursor.ts` | The injected pointer overlay, plus `tap` / `glide` / `type` / `scanFlash` |
| `gif.ts` | ffmpeg wrappers: `toGif`, `hstackGif`, and the shared `LEAD_IN` hold |
| `support.ts` | `capturePeer`, `take` / `takePair`, `seedExamples`, `still`, `befriend`, `share`, `setDisplayName` / `setDeviceName` |
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

Three things every screencast gets for free, and one to reach for:

- **The opening frame is held** for `LEAD_IN` (1.8s) before anything moves, so a
  viewer arriving mid-loop can read the screen. It clones frame 0 — which means
  whatever is on screen when the clip window opens is what they stare at.
- **`settle` on `takePair`** is how you keep that frame honest. `ready()` plus 700ms
  covers the app shell, not a view that keeps working after mounting (the datagrid
  spins up HyperFormula and runs Monte Carlo). Wait for the real thing there and the
  clip opens on a painted screen instead of a skeleton.
- **`hstackGif(name, l, r, { fps, width })`** — two phone panes is 864px wide and the
  slides render it in a ~512px column, so `width: 720` on a dense asset is free. Note
  that dropping `fps` does *not* reliably shrink a busy clip: fewer frames each carry a
  bigger delta.
- **`scanFlash(page, qr)`** rests the pointer on a QR code and flashes the frame white.
  Nothing scans locally, so without it the code just vanishes and reads as a glitch.

## Things that bite

- **Video is per page and starts when the page is created.** `take()` therefore runs
  setup on one page and the recorded flow on a second, and measures the clip window
  from the second page's creation — otherwise every GIF opens with several seconds
  of WASM and keyhive boot.
- **Native dialogs are load-bearing.** `confirm` gates archive and deletes, and
  `prompt` still gates contact naming and the add-device settings sync.
  `capturePeer` installs a handler; set the answer with `peer.setPromptAnswer(…)`
  before triggering one. **Renaming is no longer one of them** — documents and
  spreadsheet sheets rename through `RenameSheet`, a real Material sheet, which
  is both on-brand and actually visible in a screencast (an OS prompt is not).
- **`md-*` elements are shadow DOM** — match `md-list-item` by `hasText` substring,
  never an anchored regex (innerText carries a trailing newline). `locator.fill()`
  throws on an `md-outlined-text-field` host, so reach the inner control:
  `[data-testid="x"] input` (Playwright's CSS engine pierces open shadow roots).
- **Item editors are property lists.** Task/counter/event editors show a list of
  properties and open one field at a time, so a field is only in the DOM after
  its `<id>-row` has been tapped; `Back` returns to the list. A *new* item opens
  straight in its title pane. Escape pops detail→list rather than closing, so a
  flow that used Escape to dismiss now needs a Close click.
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
- **Device names must be set before linking.** The link rendezvous carries each side's
  `resolveDeviceName()` to the other, so `setDeviceName` after the handshake labels the
  device locally and the *other* device never learns it. Set both up front.
- **Roles are per-person on a document, per-device only in Settings.** The Sharing page
  is group-only by construction — adding a friend adds every device they own — so
  `device-permissions.gif` drives Settings → Devices instead. It works on documents anyway:
  keyhive caps access at the minimum along the delegation path, and `getMyAccess`
  resolves the device.
- **Demote the linked device, never the founder, and never revoke.** A founding
  device's root delegation is permanent in keyhive, so demoting it changes the Select
  and nothing else. And a fully revoked peer is never notified — it keeps its cached
  view, so only a *demotion* produces a visible live change.
- **`DeviceList` has no testids** and its role Select has no id, so the shared
  `radixSelect` helper does not apply. Reach the row through the name input, whose
  `title` is the device's agentId, then `getByRole('combobox')` — and remember the
  listbox is portalled to `document.body`, not nested in the row.
- **Sheets that open themselves.** The sharing page pops its QR invite automatically
  when a document has no members and you have no contacts. Clicking "Add people" at
  that moment hits the sheet's own full-screen overlay and *dismisses* it — the raw
  `page.mouse` calls `tap()` uses skip actionability checks, so this fails silently.
  If a flow mysteriously does nothing, suspect an overlay and check with
  `locator.click()`, which reports the interception instead of swallowing it.
