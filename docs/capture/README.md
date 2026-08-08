# Regenerating the deck's images

Every `.png` and `.gif` in `docs/` is produced by this directory — nothing here is
hand-captured. `docs/slides.md` embeds all sixteen of them, and `npm run slides`
copies the whole set into `dist/slides/`.

Fourteen are captures of the running app; two are rendered mermaid diagrams. They
have separate commands.

```bash
npm run docs:capture                      # all fourteen captured assets
npm run docs:capture -- -g homepage.png   # just one (each asset is one test)
npm run docs:capture -- -g '\.gif'        # only the screencasts
npm run docs:capture -- --headed          # watch it happen

npm run docs:diagrams                     # both diagrams, from docs/*.mmd
npm run docs:diagrams -- add-device       # just the ones matching a substring
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
documents in `src/client/ui/home/examples/`, seeded via the empty home page's
"Yes, create examples" offer.

| Asset | Shows |
|---|---|
| `homepage.png` | The document list, seeded with all the bundled examples |
| `settings.png` | The settings index |
| `connections.png` | The Debugging settings screen, with a second peer connected |
| `tour.gif` | A first run end to end: an empty home page fills itself with the examples, a sheet gets a cell and a range selected, a phrase in a prose document is typed over, and it stops on the QR that adds a second device |
| `new-doc.gif` | FAB → type picker → kebab → Rename → naming a new task list → adding a task |
| `timeline.gif` | Editing, then scrubbing the version-history slider |
| `linking-a-device.gif` | A device with a library of documents links a second one, which then receives them all |
| `presence-updates.gif` | Two peers in the same task editor; the dot walks down the other's property list — Title, Priority, Description — greying each row they occupy |
| `add-and-share-with-friend.gif` | Sharing an open document with a new contact by QR, who then opens it |
| `presence-datagrid.gif` | Two peers in one sheet: each other's tagged cells, a Monte Carlo histogram, three rows highlighted from the headers, a formula opened so its referenced cells light up and then edited on both screens, and the formatting / conditional-formatting sheets opened without being used |
| `presence-peritext.gif` | Two peers holding **overlapping** selections in one document: Alice types over hers, destroying the two words the selections shared, and Bob is left holding the words that survived — then Bob types and replaces exactly those |
| `presence-source.gif` | A grid on the left, the same document as JSON on the right: the dot tracks the selected cell, and editing an empty one makes the key appear |
| `validation.gif` | A task list beside its JSON: deleting an optional field regroups the task, and an invalid enum raises a schema error in both panes |
| `device-permissions.gif` | One user's two devices on the same counters document; the second device is walked admin → edit → read → edit → admin from Settings → Devices, and its write affordances vanish and return live |

And the two diagrams, from `npm run docs:diagrams` rather than `docs:capture`:

| Asset | Shows |
|---|---|
| `add-device.png` | The device-link rendezvous as a sequence: QR → both sides subscribe → the sealed bundles cross in both directions → the laptop adds the phone to the user group |
| `after-link.png` | The same two devices afterwards: relay watch → introduction → keyhive ops → `reachableDocs()` → document content |

Every asset above is on a slide — the deck references all of them, so a stale capture is
always visible somewhere. Keep it that way when adding one: an asset nothing embeds is an
asset nobody notices has rotted, and an asset the deck outgrows should go rather than
linger. To check:

```bash
cd docs && for f in *.png *.gif; do grep -q "$f" slides.md || echo "UNREFERENCED: $f"; done
```

Two of the GIFs adjust their fixture before recording, and both tweaks are about the
430px frame rather than cosmetics: `presence-datagrid.gif` narrows the label column so
more than one estimate column fits on screen, and `device-permissions.gif` hand-writes
its counters document because the bundled example's completion keys are
`{{today-6d@…}}` templates that only the importer expands. `presence-datagrid.gif` used
to unfreeze a column here too — the examples themselves no longer freeze one, precisely
because at 430px a frozen column is a sticky pane sitting on top of every tap target to
its right.

## Layout

| File | Role |
|---|---|
| `playwright.config.ts` | Phone viewport (430×932), video on, its own `testMatch` |
| `cursor.ts` | The injected pointer overlay, plus `tap` / `glide` / `type` / `scanFlash` / `selectPhrase` / `hideCursor` |
| `gif.ts` | ffmpeg wrappers: `toGif`, `hstackGif`, the shared `LEAD_IN` hold, and the palette/decimation defaults |
| `support.ts` | `capturePeer`, `take` / `takePair`, `seedExamples`, `still`, `befriend`, `share`, `setDisplayName` / `setDeviceName` |
| `assets.capture.ts` | One test per asset |

Tests are named `*.capture.ts`, and this directory is outside the root config's
`testDir` — so `npm run test:pw` never runs them, and a capture run never drags the
test suite along.

## Adding a diagram

Write a `docs/<name>.mmd` and run `npm run docs:diagrams`; `render-mermaid.mjs` globs
`docs/*.mmd` and writes a same-named transparent PNG, so there is nothing to register.
It drives the same system Chromium the capture config resolves, with mermaid's
self-contained `dist/mermaid.min.js` injected into a blank page — deliberately not
`@mermaid-js/mermaid-cli`, whose `puppeteer` peer dependency downloads a Chromium that
will not run on NixOS. A parse error exits non-zero rather than leaving the old PNG in
place; three ways to get one:

- **`;` is a statement separator** and cannot appear in label text at all.
- **`#` must be written `#35;`.** A bare `#` reads as the start of an entity code and
  mermaid *silently drops the rest of the label* — `QR — #/link-device/…` rendered as
  `QR —` and still exited zero.
- Put the slide's own title in the `## ` heading, not a mermaid `title:` — the deck's
  headings are styled by `slides-theme.css` and a diagram title would compete.

Height is the only thing that governs legibility. A diagram scaled onto a 16:9 slide is
always height-bound, never width-bound, so apparent text size is roughly
`slideHeight / rowCount` no matter what font size the SVG uses — widening it or bumping
`fontSize` changes nothing. About 13 rows is the ceiling for a slide someone reads from
the back of a room, which is why `add-device.mmd` and `after-link.mmd` are two files:
as one 22-row diagram it rendered at 7px.

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
  slides render it in a ~512px column, so `width` looks like free savings. It is not;
  see *Things that bite* below before reaching for either knob.
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
  its `<id>-row` has been tapped. A *new* item opens straight in its title pane.
  Escape pops detail→list rather than closing, so a flow that used Escape to
  dismiss now needs a Close click.
- **A single-field pane commits on Save, not on Back.** Those panes have no `Back`
  button at all — tap `<id>-save` (or `<id>-cancel` to discard). Only the
  multi-control panes (an event's *When*, an RRULE) still auto-save and keep
  `Back`. This is a *silent* failure mode in a capture: a flow that leaves such a
  pane any other way still records, but the value never lands, so the clip shows
  dots moving over values that never change.
- **Presence dedupe hides your own devices**, and collapses one user's devices into a
  single dot. Two distinct identities are required or `presence-updates.gif` shows
  nothing.
- **A row/column header selection is broadcast to nobody.** `handleRowHeaderClick`
  clears the selected *cell*, and the grid's presence payload is a cell path — so
  while a header band is up that peer announces nothing and their tag disappears
  from the other pane. `presence-datagrid.gif` films the band anyway (it is a real
  selection with real commands behind it) and takes a cell again straight after to
  get the tag back. Do not write a beat that expects the far side to show the band.
  And a body row header is a **`td`**, not a `th` — only the corner one is a `th`,
  and it shares the `datagrid-row-header` class, so address rows by
  `td.datagrid-row-header[data-row-index="N"]` rather than counting.
- **Getting a group of cells into one frame is its own problem.** `panToCell` stops
  as soon as *its* cell is inside the viewport, and it treats `x >= 0` as visible —
  but the row header is `position: sticky; left: 0`, so a cell at x=0 is behind it.
  The formula beat needs three cells at once, which is what `panToShow` is for, and
  it only fits because the fixture narrows C and D: at their shipped widths
  C+D+E is 390px against 382px of grid, and one reference sat just off the edge
  every time. That was only caught by pulling a frame out of the finished GIF —
  the count assertion passed, because both refs were in the DOM.
- **Formula reference highlights only exist while a cell is being edited.**
  `refHighlightMap` returns empty unless `editingCell` is set, so the coloured
  dashed borders appear when the bottom bar's editor takes focus and vanish on
  commit — the hold has to sit between the two. CodeMirror is also lazy-loaded and
  the bar only mounts in focus mode, so wait for `.bottom-editor-cm .cm-content`
  rather than tapping where it is about to be. Walking the caret across the formula
  moves the *active* ref, which fills its cell instead of only outlining it.
- **A phrase's own edges are a dice roll too.** `selectPhrase` shift-clicks the
  character boundary at the phrase's right edge, and when the next character is a
  space Chromium rounds to either side of it: the same `and pitch` came back
  `"and pitch"` on one run and `"and pitch "` on the next, failing an exact
  assertion. Insetting the click is the cure that causes the worse disease (a
  character short — see `phraseGrips`), so `selectAndRead` asserts the phrase
  `trim()`ed, which still fails a selection a whole word out, and hands back the
  real string so `padLike` can type that boundary space back.
- **A rebased selection's exact extent is measured, not assumed.**
  `presence-peritext.gif` films two *overlapping* selections and then destroys the
  shared words, and where the surviving anchor lands relative to the space in front
  of the next word is the editor's business. `sentences-local-caret.spec.ts` owns
  that assertion ("a selection overlapping a peer edit keeps the words that
  survive") and prints the survivor; the capture asserts it `trim()`ed and carries
  whatever leading space it actually found into the text it types over it.
- **A caret at the end of a non-final block types into the *next* block.** Live bug, so
  do not film adding text that way: clicking at the end of a list item and typing put the
  sentence in the following bullet, and Enter-then-type left an empty block behind and did
  the same ("AAA"/"BBB" → Enter after AAA → typing X gives "AAA"/""/"XBBB"). Filming an
  edit mid-block — select a phrase and type over it — is the path that works, and it is
  what `tour.gif` and `presence-peritext.gif` both do.
- **Taps on list rows need the scroll to settle first.** `tap()` measures the target's box
  and presses ~450ms later, which is fine for a button and not for a row that had to be
  scrolled into view: it is often still gliding, so the press lands on whatever slid into
  that spot. Recorded exactly that — a tap aimed at *Tahoe trip* opened *Birthday Gifts*.
  `openRow()` settles the scroll and then asserts the title that opened.
- **Do not film a text selection as a press-and-drag.** It is the obvious way to show
  one and it does not survive a collaborator: there is no consistent selection while
  the button is down, so a remote cursor push arriving mid-sweep makes the editor's
  caret-restore effect re-apply the half-finished selection it last recorded, which
  re-anchors the drag. Measured in `presence-peritext.gif`: an anchor at offset 41
  became 22 mid-move and the clip selected 19 characters that were never swept. Use
  `selectPhrase()` — double-click then shift-click, each atomic, with a real
  selection in between — and assert what the gesture caught, because a selection one
  word off still records a perfectly plausible-looking clip.
- **Peer colours are a dice roll.** A peer's colour is hashed from their keyhive
  identity, which is minted fresh every run, so a two-peer clip draws two of the
  eight `MATERIAL_CATEGORICAL` hues at random: both peers land on the same one about
  one run in eight, and indigo is a poor draw whatever the other peer got — at the
  25% opacity the selection overlay uses it is nearly the editor's own selection
  tint. `presence-peritext.gif` warns on both and keeps going (the name tips still
  disambiguate); re-run for a cleaner pair before putting the asset on a slide.
- **`create-examples` only renders on an empty home page**, so anything using it must
  start from a fresh context.
- **Direct WebRTC is opportunistic.** `connections.png` prefers a `direct (P2P)` dot
  but falls back to `via relay` with a warning rather than failing.
- **The palette is the size lever; `width` and `fps` are not.** Every asset is encoded at
  64 colours (`gif.ts`), which is worth far more than either knob: `tour.gif` measured
  5.6 MB at 8fps/256 colours, 3.9 MB at 128 and 3.0 MB at 64, with no visible loss on
  text, spreadsheet fills, or the 25%-opacity peer tints. It roughly halved the whole
  deck. Raise `maxColors` per asset if something ever bands — and it goes the other way
  too: `presence-peritext.gif` passes 32, measured on one pair of recordings at 3068 KB
  (64), 2815 (48) and 2432 (32), with the frame it exists for — two stacked tints and a
  10px name tip — unchanged. Trimming holds is not an alternative lever: a held frame is
  nearly free, so the bytes live in the typed runs and the gestures.
- **Do not decimate frames.** `mpdecimate` + `-fps_mode vfr` collapses a run of identical
  frames into one long frame and saves a further ~11%, and it was tried and reverted:
  "identical" is a count of changed 8x8 blocks, and a frame where only the 26px pointer
  ring moved is a fraction of a percent of the frame. Every threshold that collapses the
  real pauses also eats the pointer travel, so the clips play as a jumpy slideshow with
  the beats gone.
- **Neither `width` nor `fps` is a reliable size lever, so measure before believing
  either.** Downscaling usually *costs* bytes — lanczos turns crisp UI text into
  anti-aliased gradients and a GIF cannot compress those; `add-and-share-with-friend.gif`
  went 1.3 MB → 2.7 MB at `width: 720`. But "usually" is doing real work in that
  sentence: re-encoding the *peritext* pair at 48 colours came out 1875 KB at
  `width: 720` against 2733 KB native — a 31% saving in the opposite direction. Which
  way it goes is a property of the clip, so measure the pair you have rather than
  reasoning from this list. Dropping `fps` is no safer on a busy clip, where
  fewer frames each carry a bigger delta: `device-permissions.gif` at 6fps came out
  *bigger* than at 8. Three assets still pass `width: 720`
  (`presence-datagrid`, `validation`, `presence-source`) from before that measurement and
  have never been re-checked — if you regenerate one, try it without and compare.
- **`video.path()` is a trap.** Playwright only guarantees a recording is on disk
  once the whole *context* closes, and a capture still has work to do in that
  context. `finishRecording` uses `saveAs()`, which waits; encoding from `path()`
  intermittently fails with "No such file or directory".
- **Device names must be set before linking.** The link rendezvous carries each side's
  `resolveDeviceName()` to the other, so `setDeviceName` after the handshake labels the
  device locally and the *other* device never learns it. Only the second device needs a
  name (`📱 iOS`) — the first keeps its browser-derived one and is already marked by the
  `This device` badge — but it has to be set up front. And a *friend's* name never travels
  at all, so `connections.png` relabels Bob's row locally on Alice's own page instead.
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
