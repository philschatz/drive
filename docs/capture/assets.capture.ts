import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import {
  beat,
  glide,
  hideCursor,
  scanFlash,
  selectPhrase,
  tap,
  tapAndReplace,
  tapAndType,
  type as typeText,
  type Pt,
} from './cursor';
import { hstackGif, toGif } from './gif';
import {
  befriend,
  capturePeer,
  EXAMPLE_COUNT,
  nameContact,
  openDocNamed,
  seedExamples,
  setDeviceName,
  setDisplayName,
  share,
  still,
  take,
  takePair,
  waitFor,
  warmDoc,
} from './support';

/**
 * Regenerates every image in docs/ from the real app.
 *
 * One test per asset, so a single stale image can be refreshed with
 * `npm run docs:capture -- -g homepage.png` instead of rerunning everything.
 * Assets are written straight into docs/ (where `npm run slides` picks them up);
 * raw recordings stay in the gitignored .work/ scratch directory.
 *
 * See README.md for the full list and how to add one.
 */

/**
 * The name given to the *second* device in a two-device shot.
 *
 * Only the second one needs naming. A device names itself after the browser it is
 * running in ("💻 Chrome"), and DeviceList already badges the local row
 * "This device" — so 💻-plus-badge against 📱 iOS is unambiguous without
 * relabelling the first. Same 📱-plus-name shape the app's own generator uses
 * (src/client/ui/lib/device-name.ts).
 */
const IOS = '📱 iOS';

/** A TaskList with enough content to look real in a two-peer capture. */
const SHARED_TASKS = {
  '@type': 'TaskList',
  name: 'Camping trip',
  tasks: {
    t1: { '@type': 'Task', title: 'Book the campsite', progress: 'completed' },
    t2: { '@type': 'Task', title: 'Borrow a second tent', progress: 'needs-action' },
    t3: { '@type': 'Task', title: 'Plan the meals', progress: 'needs-action' },
    t4: { '@type': 'Task', title: 'Check the weather', progress: 'needs-action' },
  },
};

/**
 * The prose the cursor capture edits, and the two phrases each peer selects.
 *
 * The two selections deliberately **overlap** — they share `and pitch` — because
 * that is the case worth filming. Disjoint ranges only show offsets shifting: a
 * naive index would break, but nothing of the second selection is ever destroyed.
 * Here Alice types over a range that includes the front of Bob's, so those
 * characters are genuinely gone, and what Bob is left holding has to be the
 * *remaining words* rather than a range that collapsed or slid.
 *
 * Alice's replacement is also ten characters longer than what it replaces, so
 * every index past it moves as well.
 *
 *   We hike in on Friday and pitch the tents by the lake before dark.
 *      [--------- Alice --------]
 *                       [--- Bob ---]
 *
 * `BOB_SURVIVES` is the surviving selection with any leading space trimmed off:
 * whether the rebased anchor lands before or after the space in front of `the`
 * is the editor's business, so the flow reads what actually survived and keeps
 * that leading space when typing over it (asserted either way by PROSE_FINAL).
 */
const PROSE = 'We hike in on Friday and pitch the tents by the lake before dark.';
const ALICE_PHRASE = 'hike in on Friday and pitch';
const ALICE_TYPES = 'drive up on Thursday night and set up';
const BOB_PHRASE = 'and pitch the tents';
const BOB_SURVIVES = 'the tents';
const BOB_TYPES = 'the big tent';
const PROSE_FINAL = 'We drive up on Thursday night and set up the big tent by the lake before dark.';

/**
 * The document both peers open, as Markdown — the paragraph above plus enough
 * around it to fill a 932px frame.
 *
 * The length is the point: one sentence in a phone-tall word processor leaves two
 * thirds of the pane empty, which on a slide reads as a bug rather than a
 * document. Both edited phrases stay in the *first* paragraph so the two panes can
 * be compared at a glance, and each phrase appears exactly once in the whole
 * document — `phraseGrips` finds them by text, so a second occurrence would be
 * measured instead.
 *
 * Each paragraph is one long line: a single newline inside one is a Markdown soft
 * break, and whether that becomes one block or two is the parser's business, not
 * something this capture should depend on.
 */
const PROSE_DOC = [
  PROSE,
  'Bob is bringing the big tent and the stove. I have the tarp, the water filter and both sleeping mats, so nobody carries two of anything.',
  '## Packing',
  'Warm layers for the evening — it drops below freezing once the sun is off the water. Boots, not trainers: the last mile up is loose rock the whole way.',
  'Breakfast is oats and coffee, and we can eat the rest cold on the walk out. Rain is forecast for Sunday morning, so we should be packed and moving by eight.',
].join('\n\n');

/**
 * The two points `selectPhrase` needs to select `needle` in the rich-text editor:
 * the middle of its first word (to double-click) and its far end (to shift-click).
 *
 * A paragraph renders as a single `<span data-from>` run, so a word inside it has
 * no element and no Locator — the only way to point at one is to measure it. Walk
 * the editor's text nodes, find the phrase in the concatenated text, and take
 * client rects of Ranges over it.
 *
 * `end` is the *last* rect's right edge, so a phrase that wraps across lines still
 * yields its true end, and it is used exactly rather than inset: a rect edge
 * already sits on the character boundary Chromium's hit-test snaps to. Inset it by
 * a pixel and the selection can come up one character short — which here would
 * mean typing over "by the lak" and leaving a stray "e" behind.
 */
async function phraseGrips(page: Page, needle: string): Promise<{ word: Pt; end: Pt }> {
  return page.evaluate((needle) => {
    const root = document.querySelector('[data-testid="rt-editor"]');
    if (!root) throw new Error('phraseGrips: no rt-editor');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      all += (n as Text).data;
    }
    const at = all.indexOf(needle);
    if (at < 0) throw new Error(`phraseGrips: ${JSON.stringify(needle)} not in ${JSON.stringify(all)}`);

    /** Global text offset → (text node, offset within it). */
    const point = (off: number): [Text, number] => {
      let seen = 0;
      for (const n of nodes) {
        if (off <= seen + n.data.length) return [n, off - seen];
        seen += n.data.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.data.length];
    };
    const rectsFor = (from: number, to: number) => {
      const range = document.createRange();
      const [sn, so] = point(from);
      const [en, eo] = point(to);
      range.setStart(sn, so);
      range.setEnd(en, eo);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) throw new Error(`phraseGrips: no rects for ${from}..${to}`);
      return rects;
    };

    const firstWordLen = (needle.split(' ')[0] ?? needle).length;
    const word = rectsFor(at, at + firstWordLen)[0];
    const phrase = rectsFor(at, at + needle.length);
    const last = phrase[phrase.length - 1];
    return {
      word: { x: word.left + word.width / 2, y: word.top + word.height / 2 },
      end: { x: last.right, y: last.top + last.height / 2 },
    };
  }, needle);
}

/**
 * Select `needle` in the rich-text editor and return exactly what the gesture caught.
 *
 * The shift-click aims at the character boundary on the phrase's right edge, and
 * when the next character is a space Chromium's hit-test rounds to either side of
 * it: measured on `and pitch`, one run came back `"and pitch "` and the next
 * `"and pitch"`. Both are the same *words*, and insetting the click instead is the
 * cure that causes the worse disease — a pixel in and the selection can come up a
 * character short (see `phraseGrips`), leaving a stray letter behind when it is
 * typed over.
 *
 * So the phrase is asserted `trim()`ed — a selection a whole word out still fails,
 * which is the mistake that matters — and the real string is handed back so the
 * caller can put that boundary space back into what it types (`padLike`), landing
 * on the same sentence either way.
 */
async function selectAndRead(page: Page, needle: string): Promise<string> {
  const grip = await phraseGrips(page, needle);
  await selectPhrase(page, grip.word, grip.end);
  const got = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(got.trim()).toBe(needle);
  return got;
}

/** Wrap `text` in whatever leading/trailing space `selection` turned out to hold. */
const padLike = (selection: string, text: string) =>
  (selection.startsWith(' ') ? ' ' : '') + text + (selection.endsWith(' ') ? ' ' : '');

/**
 * The *Where My Hours Help Most* example, read from the bundled examples rather
 * than copied in here: its TRIANGULAR/PERT/UNIFORM/BETA cells are what raise the
 * Monte Carlo panel, so the capture follows the app's own example if it changes.
 * Read from disk rather than imported so the harness needs no
 * `resolveJsonModule`.
 */
const IMPACT_OF_HOURS = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../src/client/ui/home/examples/datagrid-impact-of-hours.json'),
    'utf8'
  )
);

// Two fixture tweaks, both about phone width rather than looks. Narrowing the
// `Way of helping` labels is what puts more than one estimate column on screen at
// a time. This used to also set `frozenCols = 0` — the examples no longer freeze a
// column at all, precisely because at 430px a frozen one is a sticky pane sitting
// on top of wherever a tap lands, and cells to its right cannot be selected.
IMPACT_OF_HOURS.sheets.compare.columns.c1.width = 150;
// And C/D come in from 130/140, because the formula beat needs `Hours per year`
// *and* the two cells it references in one frame: at their shipped widths
// C+D+E is 390px against the 382px of grid beside the row header, so one
// reference was always just off the left edge — measured, on camera.
IMPACT_OF_HOURS.sheets.compare.columns.c3.width = 110;
IMPACT_OF_HOURS.sheets.compare.columns.c4.width = 110;

/**
 * How many conditional-format rules the example already ships with.
 *
 * `presence-datagrid.gif` opens that sheet and closes it again without touching
 * anything, and this is what "without touching anything" is asserted against: the
 * list must show exactly the rules the fixture brought, so an accidental tap that
 * created a fifth one fails the capture instead of quietly filming itself. Read
 * from the fixture rather than hard-coded, so the example can grow a rule.
 */
const CF_RULE_COUNT = Object.keys(IMPACT_OF_HOURS.sheets.compare.conditionalFormats).length;

/**
 * Cells on the *Compare* sheet as `[col, row]` grid indices.
 *
 * Both peers' cells sit in the same column (`People reached per hour`) on
 * purpose: these columns are 150–160px against ~280px of grid beside the (now
 * unfrozen, narrowed) label column, so two of them never share the screen — and a
 * peer's highlight is only worth capturing if the *other* pane is looking at it.
 */
const BOB_CELL: [number, number] = [5, 1]; // =TRIANGULAR(0.8,1.5,1)
const ALICE_CELL: [number, number] = [5, 3]; // =TRIANGULAR(2,6,3)
const HOURS_PER_SESSION: [number, number] = [2, 1]; // a plain 1.5 — the edit target

/**
 * `Hours per year` on the first row — `=C2*D2*12`, the formula-reference beat,
 * with `SESSIONS_PER_MONTH` and `HOURS_PER_SESSION` being the two cells it
 * references.
 *
 * Picked because both references are the cells immediately to its left, so one pan
 * can hold the edited cell and everything it depends on in the same 430px frame
 * (which is what the C/D width tweak above buys). The stored form is id-based
 * (`{R[r2]C[c3]}`); the editor shows and edits A1, and that is what produces the
 * coloured dashed borders.
 */
const SESSIONS_PER_MONTH: [number, number] = [3, 1];
const HOURS_PER_YEAR: [number, number] = [4, 1];

/**
 * The rows Bob highlights from the row headers, as visible-row indices.
 *
 * Below ALICE_CELL's row (3) on purpose: a header selection paints the whole band,
 * and running it over the cell Alice has selected would bury her tag under it.
 */
const ROW_BAND_FROM = 5;
const ROW_BAND_TO = 7;

const cellAt = (page: Page, [col, row]: [number, number]) =>
  page.locator(`td[data-cell-col="${col}"][data-cell-row="${row}"]`);

/**
 * A row header by visible-row index.
 *
 * Addressed by `data-row-index` rather than position, which also sidesteps the
 * two traps here: a body row header is a `td` (only the corner one is a `th`),
 * and the corner shares the `datagrid-row-header` class, so counting them would
 * be off by one.
 */
const rowHeaderAt = (page: Page, row: number) =>
  page.locator(`td.datagrid-row-header[data-row-index="${row}"]`);

/**
 * Cells on *Home Spending*'s Summary sheet, for the tour's spreadsheet beat.
 *
 * Column B is the money column, and all of these are on screen at 430px without
 * panning — the summary's own labels are column A. The range is the category block
 * (Housing … Fun), chosen because a multi-cell selection is what swaps the bottom
 * bar over to aggregates.
 */
/**
 * Open a document from the home list by name, and confirm it is the one that opened.
 *
 * `tap()` measures the target's box and presses ~450ms later, which is fine for a
 * button and not fine for a row in a scrollable list: a row that had to be scrolled
 * into view is often still gliding when the box is read, so the press lands on
 * whichever row slid into that spot. Recorded exactly that — a tap aimed at *Tahoe
 * trip* opened *Birthday Gifts*. Settling the scroll first fixes it; asserting the
 * title makes any recurrence a failure rather than a clip of the wrong document.
 */
async function openRow(page: Page, name: string): Promise<void> {
  const row = page.getByTestId('doc-row').filter({ hasText: name });
  await row.scrollIntoViewIfNeeded();
  await beat(page, 500);
  await tap(page, row);
  await expect(page.getByTestId('doc-title')).toContainText(name, { timeout: 30_000 });
}

const TOTAL_SPENT: [number, number] = [1, 2]; // B3, "$ 6,042.51"
const CATEGORIES_FROM: [number, number] = [1, 10]; // B11, Housing
const CATEGORIES_TO: [number, number] = [1, 19]; // B20, Fun

/**
 * A Counters document for the permissions capture.
 *
 * Hand-written rather than taken from `counters-habits.json`, whose completion
 * keys are `{{today-6d@12:41}}` templates that only the importer expands — passed
 * straight to `createDoc` they would land as literal keys and the streak counts
 * would read as nonsense on camera.
 */
const SHARED_COUNTERS = {
  '@type': 'Calendar+Counters',
  name: 'Habit Tracker',
  events: {
    // `startTime` is a time of day, not a date-time; completion keys are the full
    // local date-times. Getting either wrong shows up as a validation badge rather
    // than a counter.
    water: {
      '@type': 'Event',
      title: 'Two litres of water',
      startTime: '08:00',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      completions: {
        '2026-07-24T08:12:00': '',
        '2026-07-25T08:40:00': '',
        '2026-07-26T09:05:00': '',
      },
    },
    veg: {
      '@type': 'Event',
      title: 'Vegetables at lunch',
      startTime: '12:30',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      completions: { '2026-07-25T12:35:00': '', '2026-07-26T12:41:00': '' },
    },
    walk: {
      '@type': 'Event',
      title: 'Walk before dark',
      startTime: '18:00',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      completions: { '2026-07-25T18:20:00': '' },
    },
    // No recurrence, so this one is a free tally: schedule-less counters sort
    // last (STATUS_ORDER in occurrences.ts), which makes it *the* bottom row, and
    // its badge is a running `N×` count. That matters because recording again on
    // an already-done daily counter changes nothing on screen, whereas this
    // number visibly ticks up — which is the whole point of the click.
    pushups: {
      '@type': 'Event',
      title: 'Push-ups, whenever',
      completions: {
        '2026-07-24T07:10:00': '',
        '2026-07-25T07:30:00': '',
        '2026-07-26T07:05:00': '',
      },
    },
  },
};

/**
 * The Vacation Trip Planner example — used for the source-editor pairing because
 * its sheet, row and column ids are hand-written (`plan`, `r5`, `c2`), so cell
 * keys read as `r5:c2` in the JSON tree instead of the base-36 ids a
 * user-created grid gets.
 */
const TRIP_PLANNER = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../src/client/ui/home/examples/datagrid-trip-planner.json'),
    'utf8'
  )
);

/** Cells on the trip planner's `plan` sheet: [col, row] indices → cell key. */
const LODGING: [number, number] = [1, 4]; // r5:c2, =PERT(105,140,215)
const FOOD_AND_FUN: [number, number] = [1, 6]; // r7:c2, =TRIANGULAR(38,115,62)
const EMPTY_CELL: [number, number] = [1, 13]; // r14:c2 — no key in the document yet

/**
 * A row of the source editor's JSON tree, addressed by its key.
 *
 * The tree carries no testids, so rows are found by the quoted key text in
 * `.source-key`. Keys are unique within a parent but not across the tree, so
 * every call is scoped to `.first()`.
 */
const sourceRow = (page: Page, key: string) =>
  page
    .locator('.source-row')
    .filter({ has: page.locator('.source-key', { hasText: `"${key}"` }) })
    .first();

/** Expand a collapsed container row (depth ≥ 2 starts closed). */
async function expandRow(page: Page, key: string): Promise<void> {
  const row = sourceRow(page, key);
  await tap(page, row.locator('.source-toggle'));
  await beat(page, 400);
}

/**
 * Pan the grid horizontally until `target` sits fully inside the frame.
 *
 * Wheeled in small steps rather than jumped, so the movement reads as a pan
 * rather than a cut. The stop condition is measured rather than a fixed
 * distance, because column widths differ and `scrollIntoViewIfNeeded` is content
 * to leave a cell flush against an edge — which is exactly where a tap is least
 * reliable.
 *
 * Both panes pan to the same target, since a peer's highlighted cell can only be
 * seen on the other screen if that screen is looking at the same columns.
 */
async function panToCell(page: Page, target: [number, number]): Promise<void> {
  const cell = cellAt(page, target);
  const { width } = page.viewportSize()!;
  await page.mouse.move(width - 50, 430);
  for (let i = 0; i < 20; i++) {
    const box = await cell.boundingBox();
    if (box && box.x >= 0 && box.x + box.width <= width) break;
    // Pan whichever way the cell actually lies: right when it is off the right
    // edge or not yet rendered, back left when it has gone off the left.
    await page.mouse.wheel(box && box.x < 0 ? -110 : 110, 0);
    await page.waitForTimeout(80);
  }
  await beat(page, 400);
}

/**
 * Pan horizontally until every one of `targets` is clear of the sticky row header
 * and inside the right edge.
 *
 * `panToCell` gets one cell on screen, and its "x >= 0" is not enough for the
 * leftmost of a group: the row header is `position: sticky; left: 0`, so a cell at
 * x=0 is *behind* it. The formula beat needs the edited cell and both cells it
 * references visible at once — with only one of them on screen the coloured borders
 * do not read as "these are what it depends on" — so this pans until all of them
 * are, and fails loudly rather than filming a frame that is missing one.
 *
 * `targets` must be given left to right.
 */
async function panToShow(page: Page, targets: [number, number][]): Promise<void> {
  const { width } = page.viewportSize()!;
  /** The 48px row header, plus air so the leftmost cell is not flush against it. */
  const GUTTER = 56;
  await page.mouse.move(width - 50, 430);
  const boxes = () => Promise.all(targets.map((t) => cellAt(page, t).boundingBox()));
  for (let i = 0; i < 30; i++) {
    const bs = await boxes();
    const first = bs[0];
    const last = bs[bs.length - 1];
    if (bs.every((b) => b) && first!.x >= GUTTER && last!.x + last!.width <= width) break;
    // Pan whichever way the group hangs off: left when the first target is under
    // the header (or not rendered yet), right when the last one is past the edge.
    await page.mouse.wheel(!first || first.x < GUTTER ? -110 : 110, 0);
    await page.waitForTimeout(80);
  }
  const bs = await boxes();
  const first = bs[0];
  const last = bs[bs.length - 1];
  if (!bs.every((b) => b) || first!.x < GUTTER || last!.x + last!.width > width) {
    throw new Error(
      `panToShow: could not fit ${JSON.stringify(targets)} in one frame — widen the` +
        ` viewport or narrow the columns (got ${JSON.stringify(bs)})`
    );
  }
  await beat(page, 400);
}

/**
 * Wait until each pane has actually *seen* the other peer, not merely loaded the
 * document — for `settle`, before the clip window opens.
 *
 * Presence is ephemeral and has no replay, so a broadcast sent before the other
 * side's worker has joined the document is gone for good. `warmDoc` does not cover
 * this: it warms the *setup* page's worker, and `takePair` then records on a fresh
 * page with a fresh worker. Cost of not waiting, measured twice in six runs of
 * `presence-peritext.gif`: Alice selects a phrase, the broadcast lands nowhere,
 * nothing on her side changes again while she holds it — and the capture waits 60s
 * for a `peer-tip` that is never coming.
 *
 * The title bar's ConnectionStatus renders one `peer-dot` per peer it has heard
 * from, which is exactly the signal wanted: not "the relay is up" but "this pane
 * knows that peer exists".
 */
async function bothSeeEachOther(l: Page, r: Page): Promise<void> {
  for (const p of [l, r]) {
    await expect(p.getByTestId('peer-dot').first()).toBeVisible({ timeout: 90_000 });
  }
}

/** Tap a cell and confirm it actually took the selection. */
async function tapCell(page: Page, target: [number, number]): Promise<void> {
  await tap(page, cellAt(page, target));
  await expect(cellAt(page, target)).toHaveClass(/\bselected\b/, { timeout: 15_000 });
}

/** Drag from one cell to another to highlight the range between them. */
async function dragSelect(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await glide(page, cellAt(page, from));
  await beat(page, 200);
  await page.mouse.down();
  const box = await cellAt(page, to).boundingBox();
  if (!box) throw new Error('dragSelect: target cell is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
  await beat(page, 250);
  await page.mouse.up();
}

// ---------------------------------------------------------------- stills, one peer

test('homepage.png', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice');
  await setDisplayName(alice.page, 'Alice');
  await seedExamples(alice.page);
  await still(alice.page, 'homepage.png');
  await alice.close();
});

test('settings.png', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice');
  await setDisplayName(alice.page, 'Alice');
  await alice.page.goto('/#/settings');
  await expect(alice.page.locator('md-list-item').filter({ hasText: 'Devices' })).toBeVisible();
  await still(alice.page, 'settings.png');
  await alice.close();
});

// ---------------------------------------------------------------- stills, two peers

test('connections.png', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice');
  const bob = await capturePeer(browser, 'bob');
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  // Only Bob's id is needed here, not a name set on Bob's own device: a friend's
  // device name never travels (see the relabel below), and this shot is taken on
  // Alice's page — so naming Bob's device from Bob would change nothing.
  const { agentId: bobAgentId } = await bob.call('getIdentity');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', SHARED_TASKS);
  await share(alice, bob, bGroup, docId);

  // Both sitting on the doc is what makes them peers on the wire.
  await alice.page.goto(`/#/d/${docId}`);
  await bob.page.goto(`/#/d/${docId}`);

  // The direct-WebRTC upgrade is opportunistic. Prefer it — a filled dot and
  // "direct (P2P)" is the whole point of the slide — but do not fail the run if
  // the upgrade doesn't land; the relay fallback is a truthful screenshot too.
  const direct = await waitFor(
    () => alice.call('getDirectPeers'),
    (peers) => Array.isArray(peers) && peers.length > 0,
    { label: 'direct P2P channel', timeout: 45_000, interval: 1000 }
  ).catch(() => null);
  if (!direct) console.warn('  ! no direct WebRTC channel — connections.png will show "via relay"');

  await alice.page.goto('/#/settings/debugging');
  await expect(alice.page.getByText(/Peer devices \([1-9]/)).toBeVisible({ timeout: 60_000 });
  // Bob is a friend, not a linked device, so their device name never travelled to
  // Alice — the peer row would read as a truncated agent id. The row is renamable
  // for exactly this reason (a local label): tap it to open the rename sheet.
  const bobRow = alice.page.getByTestId('peer-row').filter({ hasText: bobAgentId.slice(0, 16) });
  await expect(bobRow).toBeVisible({ timeout: 30_000 });
  await bobRow.click();
  // The real md-outlined-text-field wraps a native input in its shadow root.
  await alice.page.locator('#rename-input input').fill(IOS);
  await alice.page.getByTestId('rename-save').click();
  await beat(alice.page, 800);
  await still(alice.page, 'connections.png');
  await Promise.all([alice.close(), bob.close()]);
});

// ---------------------------------------------------------------- screencasts, one peer

test('new-doc.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await seedExamples(alice.page);

  const clip = await take(alice, async (page) => {
    await beat(page, 900);
    await tap(page, page.getByRole('button', { name: 'New document' }));
    const sheet = page.getByTestId('create-doc-sheet');
    await expect(sheet).toBeVisible();
    await beat(page, 700);

    // Substring match: shadow-DOM innerText carries a trailing newline.
    await tap(page, sheet.locator('md-list-item', { hasText: 'Task list' }));
    await expect(page.getByTestId('doc-title')).toBeVisible({ timeout: 30_000 });
    await beat(page, 600);

    // Renaming opens a Material sheet, reached from the kebab or by tapping the
    // title. The kebab is filmed because it shows where the action lives. (This
    // is why the beat still reads on camera — the old window.prompt was an OS
    // dialog the recorder couldn't see.)
    await tap(page, page.getByRole('button', { name: 'More actions' }));
    await beat(page, 500);
    await tap(page, page.getByTitle('Rename', { exact: true }));
    await expect(page.getByTestId('doc-rename-sheet')).toBeVisible({ timeout: 30_000 });
    await beat(page, 400);
    await tapAndReplace(page, page.locator('[data-testid="rename-input"] input'), 'Camping trip');
    await tap(page, page.getByTestId('rename-save'));
    await expect(page.getByTestId('doc-title')).toHaveText('Camping trip', { timeout: 30_000 });
    await beat(page, 700);

    // A new task opens straight in its Title pane (the editor is a property
    // list once the item exists).
    await tap(page, page.getByRole('button', { name: 'New task' }));
    const taskTitle = page.locator('[data-testid="ted-title"] input');
    await expect(taskTitle).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    await tapAndType(page, taskTitle, 'Book the campsite');
    // Tasks auto-save; Enter commits and offers the next blank one.
    await taskTitle.press('Enter');
    await expect(page.getByTestId('task-row')).toHaveCount(1, { timeout: 30_000 });
    await beat(page, 500);
    await tap(page, page.getByRole('button', { name: 'Close' }));
  }, { url: '/#/' });

  await toGif('new-doc.gif', clip);
  await alice.close();
});

test('tour.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  await setDisplayName(alice.page, 'Alice');
  // Deliberately no seedExamples: the offer only renders on an empty home page, and
  // tapping it is the first beat of this clip rather than setup for it.

  const clip = await take(
    alice,
    async (page) => {
      // A brand new install offers to fill itself with the bundled examples.
      const offer = page.getByTestId('create-examples');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await beat(page, 800);
      await tap(page, offer);
      await expect(page.getByTestId('doc-row')).toHaveCount(EXAMPLE_COUNT, { timeout: 120_000 });
      await beat(page, 900);
      // Dismiss the "Created 11 example documents" banner by hand. Elsewhere that
      // is a seeding artifact to be cleaned up off camera; here it is the reply to
      // the tap that just happened, so it is worth a beat and a real dismissal.
      const dismiss = page.locator('button').filter({ hasText: /^×$/ });
      if (await dismiss.count()) await tap(page, dismiss.first());
      await beat(page, 700);

      // A spreadsheet, opened from the list. Wait for a *value*, not for the first
      // `td`: the grid mounts empty while HyperFormula spins up, so anything that
      // merely counts cells (an absent `#REF!` included) is satisfied by a blank
      // screen and the hold lands on one.
      await openRow(page, 'Home Spending');
      await expect(cellAt(page, TOTAL_SPENT)).toContainText('$', { timeout: 60_000 });
      // And a painted grid is not an evaluated one — cross-sheet references read
      // `#REF!` for a beat, which reads as a broken app.
      await expect
        .poll(() => page.locator('td', { hasText: '#REF!' }).count(), {
          timeout: 30_000,
          intervals: [250],
        })
        .toBe(0);
      await beat(page, 900);

      // Tap one figure, then sweep the category column: selecting a range swaps the
      // bottom bar from the cell's own value to the range's aggregates.
      await tapCell(page, TOTAL_SPENT);
      await beat(page, 1100);
      await dragSelect(page, CATEGORIES_FROM, CATEGORIES_TO);
      await beat(page, 1600);
      // Selecting a cell puts the grid in focus mode, which swaps the whole title
      // bar for its own (a Done checkmark where Back was) — so leaving takes two
      // taps, not one. DataGrid is the only editor with a mode like this.
      await tap(page, page.getByLabel('Done'));
      await beat(page, 300);
      await tap(page, page.getByLabel('Back'));

      // Then a prose document, and an edit in it: a phrase selected and typed over.
      //
      // Both ends of the phrase are deliberately mid-block. A caret at the *end* of
      // a block that is not the document's last one currently inserts into the
      // FOLLOWING block, so the two obvious ways to film adding text both record a
      // bug: clicking at the end of this list item and typing put the sentence in
      // the next bullet, and Enter-then-type left an empty block behind and did the
      // same ("AAA"/"BBB" → Enter after AAA → typing X gives "AAA"/""/"XBBB").
      // Mid-block replacement is the path presence-peritext.gif already asserts.
      await openRow(page, 'Tahoe trip');
      await expect(page.getByTestId('rt-editor')).toContainText('Pinecrest', { timeout: 60_000 });
      // A document you can edit opens editable — the formatting bar is already
      // docked, so there is no Edit tap to film here, just the edit itself.
      await expect(page.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(page, 1600);
      const grip = await phraseGrips(page, 'the downstairs room');
      await selectPhrase(page, grip.word, grip.end);
      await hideCursor(page);
      await typeText(page, 'the loft', 80);
      // Assert across both edges of the replacement, so a selection one word out is
      // a failure rather than a clip with a mangled sentence in it.
      await expect(page.getByTestId('rt-editor')).toContainText(
        'Grandma has the loft when she arrives',
        { timeout: 30_000 }
      );
      await beat(page, 1500);

      // Straight back to the list — one tap, since there is no mode to leave.
      await tap(page, page.getByLabel('Back'));
      await expect(page.getByTestId('doc-row').first()).toBeVisible({ timeout: 30_000 });
      await beat(page, 700);

      // And the tour stops where the deck picks up: a QR waiting to be scanned by
      // a second device. Routed to rather than walked to through the overflow menu —
      // the menu and the settings index are two more full screens on the deck's
      // longest clip, and the button being tapped is the part worth filming.
      await page.goto('/#/settings/devices');
      await expect(page.getByRole('button', { name: 'Link Device' })).toBeVisible({
        timeout: 30_000,
      });
      await beat(page, 700);
      await tap(page, page.getByRole('button', { name: 'Link Device' }));
      const qr = page.locator('div[title="Click to copy link"] svg');
      await expect(qr).toBeVisible({ timeout: 60_000 });
      await glide(page, qr);
      await beat(page, 1000);
    },
    { url: '/#/', tail: 1500 }
  );

  // The deck's longest clip by a distance — eleven documents being created plus four
  // different screens — and the one that established that fps is not the size lever
  // here (8fps 5.6 MB against 6fps 5.0): the palette is, and it is now every asset's
  // default. 8fps like the other long clips, because this one has a typed edit and two
  // cell gestures in it and 6 makes those jerky.
  await toGif('tour.gif', clip, { fps: 8 });
  await alice.close();
});

test('timeline.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  await seedExamples(alice.page);
  const docId = await openDocNamed(alice.page, 'Family Groceries');

  const clip = await take(alice, async (page) => {
    await expect(page.getByTestId('task-row').first()).toBeVisible({ timeout: 30_000 });
    await beat(page, 700);

    // A few edits so the version history has something to scrub through.
    for (const i of [0, 1, 2]) {
      await tap(page, page.getByTestId('task-row').nth(i).locator('md-checkbox'));
      await beat(page, 450);
    }

    await tap(page, page.getByRole('button', { name: 'More actions' }));
    await beat(page, 500);
    await tap(page, page.locator('md-menu-item[title="History"]'));
    await expect(page.getByText(/Version history \(\d+\)/)).toBeVisible({ timeout: 30_000 });
    await beat(page, 800);

    // Scrub the slider back through the versions, then forward again.
    const slider = page.locator('input[type="range"]');
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 4, y, { steps: 10 });
    await page.mouse.down();
    await page.mouse.move(box.x + 4, y, { steps: 34 });
    await beat(page, 900);
    await page.mouse.move(box.x + box.width - 4, y, { steps: 26 });
    await page.mouse.up();
    await beat(page, 600);
  }, { url: `/#/d/${docId}` });

  await toGif('timeline.gif', clip);
  await alice.close();
});

// ---------------------------------------------------------------- screencasts, two peers

test('linking-a-device.gif', async ({ browser }) => {
  const android = await capturePeer(browser, 'android', { video: true });
  const ios = await capturePeer(browser, 'ios', { video: true });
  await setDisplayName(android.page, 'Alice');
  // Name the new device before linking: the rendezvous carries its name to the
  // first one, so the Devices list at the end of the clip reads 📱 iOS beside the
  // first device's own row. Naming that first row too would be redundant — it
  // already carries the "This device" badge.
  const iosAgentId = await setDeviceName(ios, IOS);
  // The point of linking is that the new device inherits the user's documents,
  // so the first device needs a library worth inheriting.
  await seedExamples(android.page);

  const clips = await takePair(
    android,
    ios,
    async (l, r) => {
      // Open on the first device's documents, and the second device's empty one.
      await expect(l.getByTestId('doc-row')).toHaveCount(EXAMPLE_COUNT);
      await beat(l, 1600);

      await l.goto('/#/settings/devices');
      await beat(l, 600);
      await tap(l, l.getByRole('button', { name: 'Link Device' }));
      const qr = l.locator('div[title="Click to copy link"] svg');
      await expect(qr).toBeVisible({ timeout: 60_000 });
      // Rest on the QR, then flash the frame: the other device is scanning it.
      await scanFlash(l, qr);

      const url = await l.locator('input[readonly]').inputValue();
      expect(url).toMatch(/#\/link-device\/r\./);

      // The new device opens the link; both sides then show the same five-step
      // rendezvous ladder, which is the part worth watching.
      await r.goto(url);
      await expect(r.getByText('Link Device')).toBeVisible({ timeout: 30_000 });
      await expect(r.getByText('Linking complete')).toBeVisible({ timeout: 120_000 });
      await beat(r, 900);

      // The payoff: the same documents arrive on the new device's home page.
      await tap(r, r.getByRole('button', { name: 'Done' }));
      await r.goto('/#/');
      const arrived = r.getByTestId('doc-row');
      // The first document arriving is the claim being illustrated, so that is
      // what the capture insists on. Waiting for the full set as a hard
      // assertion made the run flaky — eleven documents over the relay is a lot
      // of syncing, and a short tail left the whole asset unbuilt.
      await expect(arrived.first()).toBeVisible({ timeout: 180_000 });
      await expect
        .poll(() => arrived.count(), { timeout: 90_000, intervals: [500] })
        .toBe(EXAMPLE_COUNT)
        .catch(() => {});
      const landed = await arrived.count();
      if (landed < EXAMPLE_COUNT) {
        console.warn(`  ! only ${landed}/${EXAMPLE_COUNT} documents synced before the clip ended`);
      }
      await beat(r, 1500);

      // Back on the first device, dismiss the invite by hand rather than by
      // navigating away: the QR has done its job, and a pane still showing one
      // reads as "waiting" next to a device that has already finished. The new
      // device is then listed as Online, under the name it announced.
      await tap(l, l.getByRole('button', { name: 'Close' }).first());
      await expect(l.getByText(/^Online/).first()).toBeVisible({ timeout: 60_000 });
      await expect(l.getByTitle(iosAgentId)).toHaveValue(IOS, { timeout: 30_000 });
      await beat(l, 1000);

      // Then back to the documents, so the clip closes on the claim it is making —
      // one library, two devices — rather than on a settings screen.
      await l.goto('/#/');
      await expect(l.getByTestId('doc-row').first()).toBeVisible({ timeout: 30_000 });
      await beat(l, 1200);
    },
    // A long tail: the payoff is eleven documents sitting on a device that had none
    // a moment ago, and that takes a beat to read on both sides at once.
    { leftUrl: '/#/', rightUrl: '/#/', tail: 2800 }
  );

  // The longest of the pair clips, and mostly static screens waiting on a
  // handshake — 8fps costs nothing here and keeps it near the others in size.
  await hstackGif('linking-a-device.gif', clips.left, clips.right, { fps: 8 });
  await Promise.all([android.close(), ios.close()]);
});

test('presence-updates.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', SHARED_TASKS);
  await share(alice, bob, bGroup, docId, 'edit');
  await nameContact(alice, 0, 'Bob');
  await nameContact(bob, 0, 'Alice');
  // Both workers must hold the doc before either editor mounts, or the first
  // presence broadcast races a cold worker and no dots appear.
  await warmDoc(alice, docId, 'Camping trip');
  await warmDoc(bob, docId, 'Camping trip');

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      // Staggered opens, as tests-pw/presence.spec.ts does: Alice is already in the
      // document when Bob arrives, so the capture shows a peer *joining*.
      await l.goto(`/#/d/${docId}`);
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 2500);

      await r.goto(`/#/d/${docId}`);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await expect(l.getByTestId('peer-dot').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1200);

      // Both open the *same* task. The editor is a property list, so Alice sees
      // Bob's dot walk down labelled rows — Title, then Priority, then
      // Description — and the occupied row greys out. That reads far better at
      // 430px than dots pinned to a flat form's labels.
      const TASK = 'Plan the meals';
      await tap(l, l.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(l.getByTestId('ted-title-row')).toBeVisible({ timeout: 30_000 });
      await beat(l, 900);

      await tap(r, r.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(r.getByTestId('ted-title-row')).toBeVisible({ timeout: 30_000 });
      await beat(r, 900);

      // Bob edits one property at a time, tapping Save to return to the list; on
      // Alice's side the dot follows while Bob types, because presence is a path
      // into the document rather than a cursor position, and then the value lands
      // on Save. These panes are transactional, so Save is the *only* thing that
      // writes — leaving one any other way records a clip in which the dots move
      // over values that never change.
      const save = (p: typeof r, id: string) => tap(p, p.getByTestId(`${id}-save`));

      await tap(r, r.getByTestId('ted-title-row'));
      const title = r.locator('[data-testid="ted-title"] input');
      await expect(title).toBeVisible({ timeout: 30_000 });
      await beat(r, 500);
      await title.press('End');
      await typeText(r, ' — burgers + salad', 85);
      await beat(l, 1400);
      await save(r, 'ted-title');
      await beat(l, 600);

      await tap(r, r.getByTestId('ted-priority-row'));
      const priority = r.locator('[data-testid="ted-priority"] input');
      await expect(priority).toBeVisible({ timeout: 30_000 });
      await beat(r, 400);
      await r.keyboard.press('ControlOrMeta+a');
      await typeText(r, '2', 120);
      await beat(l, 1400);
      await save(r, 'ted-priority');
      await beat(l, 600);

      await tap(r, r.getByTestId('ted-desc-row'));
      const desc = r.locator('[data-testid="ted-desc"] textarea');
      await expect(desc).toBeVisible({ timeout: 30_000 });
      await beat(r, 400);
      await typeText(r, 'Two dinners, one packed lunch.', 70);
      await beat(l, 1200);
      // Save this one too, so the clip ends on Alice's list showing all three
      // values rather than on a description that never arrived.
      await save(r, 'ted-desc');
      // Save sat where the list's Delete row lands once the pane pops, so park
      // the cursor back on Title for the final hold — a closing frame with the
      // pointer resting on a red Delete reads as a warning, not a summary.
      await glide(r, r.getByTestId('ted-title-row'));
      await beat(l, 1200);
    },
    // Both start on Home; the flow navigates them into the document, staggered.
    { leftUrl: '/#/', rightUrl: '/#/' }
  );

  // fps 8, as the other long two-peer clips use: three Save round-trips make this
  // flow longer than it was under auto-save, and `width` is the wrong lever (see
  // the note in gif.ts — downscaling costs bytes here rather than saving them).
  await hstackGif('presence-updates.gif', clips.left, clips.right);
  await Promise.all([alice.close(), bob.close()]);
});

test('presence-peritext.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', {
    '@type': 'Sentences',
    name: 'Trip notes',
    content: '',
  });
  await share(alice, bob, bGroup, docId, 'edit');
  // Both sides, or the name tip above a caret renders a truncated agent id.
  await nameContact(alice, 0, 'Bob');
  await nameContact(bob, 0, 'Alice');

  // Seed the document off camera through the app's own Markdown import — the
  // hidden picker behind the "Import Markdown" overflow action, driven directly
  // because the menu itself is not what is being documented. Handing `content` to
  // createDoc would be cheaper, but the asset is entirely about cursors *into*
  // Peritext spans, so the text is built by the same `updateSpans` op a real
  // import uses. (The confirm() guard only fires on a document that already has
  // content; this one is empty.)
  await alice.page.goto(`/#/d/${docId}`);
  await expect(alice.page.getByTestId('rt-editor')).toBeVisible({ timeout: 60_000 });
  await alice.page.setInputFiles('[data-testid="import-md-input"]', {
    name: 'trip-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(PROSE_DOC, 'utf8'),
  });
  await expect(alice.page.getByTestId('rt-editor')).toContainText(PROSE, { timeout: 30_000 });

  // Both workers must hold the document before either editor mounts, and Bob must
  // actually have the text — a cold worker races the first presence broadcast and
  // no carets appear at all.
  await warmDoc(alice, docId, 'Trip notes');
  await warmDoc(bob, docId, 'Trip notes');
  await bob.page.goto(`/#/d/${docId}`);
  await expect(bob.page.getByTestId('rt-editor')).toContainText(PROSE, { timeout: 60_000 });

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      // Alice selects a phrase near the start. Both panes open editable (both
      // peers hold the edit role), so the clip starts on the text itself.
      await expect(l.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(l, 700);
      const aliceSel = await selectAndRead(l, ALICE_PHRASE);

      // It reaches Bob as a coloured block with Alice's name above it.
      await expect(r.getByTestId('peer-tip')).toHaveText('Alice', { timeout: 60_000 });
      await expect(r.getByTestId('peer-highlight').first()).toBeVisible();
      await beat(r, 650);

      // Bob selects a phrase that OVERLAPS Alice's by two words, and Alice sees
      // that one the same way. Both panes now show the two tints stacked over
      // `and pitch` — the overlap is the whole setup for what follows.
      await expect(r.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(r, 700);
      await selectAndRead(r, BOB_PHRASE);
      await expect(l.getByTestId('peer-tip')).toHaveText('Bob', { timeout: 60_000 });
      await expect(l.getByTestId('peer-highlight').first()).toBeVisible();

      // A peer's colour is hashed from their keyhive identity, which is minted
      // fresh for every run, so which two of the eight the clip draws is a dice
      // roll: both peers can land on the same one (1 in 8), and indigo is a poor
      // draw whatever the other peer got, because a 25%-opacity indigo highlight
      // is nearly the editor's own selection tint. Neither is wrong — the name
      // tips still tell the peers apart — so this warns rather than fails. Re-run
      // for a cleaner pair before putting the asset on a slide.
      const INDIGO = 'rgb(63, 81, 181)';
      const tipColour = (p: Page) =>
        p.getByTestId('peer-tip').evaluate((el) => getComputedStyle(el).backgroundColor);
      const [bobColour, aliceColour] = [await tipColour(l), await tipColour(r)];
      if (bobColour === aliceColour) {
        console.warn(`  ! both peers hashed to ${bobColour} — re-run for two distinct colours`);
      } else if (bobColour === INDIGO || aliceColour === INDIGO) {
        console.warn('  ! a peer hashed to indigo, which reads as the local selection — re-run');
      }
      // Hold with both selections up on both panes: the "before" frame the payoff
      // is read against. Both hands come off the mouse first — from here on every
      // frame that matters is a frame of text, and a 26px ring parked on the words
      // covers the ones being edited.
      await hideCursor(r);
      await hideCursor(l);
      await beat(l, 1100);

      // Alice types over their selection — ten characters longer than what it
      // replaced, so every index past it moves, and the two words shared with
      // Bob's selection are destroyed outright.
      await typeText(l, padLike(aliceSel, ALICE_TYPES), 85);
      await expect(r.getByTestId('rt-editor')).toContainText(ALICE_TYPES, { timeout: 60_000 });
      // The claim: Bob has not touched their selection, and it is still a selection
      // over the words that survived — not a collapsed caret, and not a range that
      // slid along to cover somebody else's text. This is
      // sentences-local-caret.spec.ts's overlap assertion made through what is on
      // screen instead of through the next keystroke.
      await expect
        .poll(() => r.evaluate(() => window.getSelection()?.toString().trim() ?? ''), {
          timeout: 30_000,
        })
        .toBe(BOB_SURVIVES);
      await beat(r, 1200);

      // And because it is still a live selection, typing replaces exactly it. The
      // boundary spaces are carried over from what actually survived rather than
      // assumed: where the rebased anchor lands relative to the space in front of
      // `the` is the editor's business, and either answer has to end on
      // PROSE_FINAL.
      const survived = await r.evaluate(() => window.getSelection()?.toString() ?? '');
      await typeText(r, padLike(survived, BOB_TYPES), 85);
      await expect(l.getByTestId('rt-editor')).toContainText(PROSE_FINAL, { timeout: 60_000 });
      await beat(l, 800);
    },
    {
      leftUrl: `/#/d/${docId}`,
      rightUrl: `/#/d/${docId}`,
      // The opening frame is frozen for LEAD_IN, so both panes must already show
      // the paragraph — an empty editor is what a viewer would otherwise stare at.
      settle: async (l, r) => {
        for (const p of [l, r]) {
          await expect(p.getByTestId('rt-editor')).toContainText(PROSE, { timeout: 90_000 });
        }
        await bothSeeEachOther(l, r);
      },
    }
  );

  // fps 8, as the other long two-peer clips use, and measured rather than assumed:
  // a pane full of prose costs real bytes, and 10fps came out at 3.2 MB against
  // 2.7 at 8 (the same ~15% the raw clips showed). `width` is the wrong lever here
  // for the reason gif.ts records — downscaling body text costs more than it saves.
  // The typing cadence is 85ms to suit it: at 8fps a faster one lands two
  // characters per frame and reads as a paste rather than as typing.
  //
  // 32 colours rather than the house 64, which is the only knob that moved the
  // needle once the overlap beat made this clip longer: re-encoded from one pair of
  // recordings, 64 came out 3068 KB, 48 2815 and 32 2432, and the frame this asset
  // exists for — two 25%-opacity tints stacked over `and pitch`, with a 10px name
  // tip above them — is pixel-for-pixel unchanged at 32. Trimming the holds is not
  // an alternative: a held frame is nearly free, so the bytes are all in the two
  // typed runs and the selection gestures.
  await hstackGif('presence-peritext.gif', clips.left, clips.right, { fps: 8, maxColors: 32 });
  await Promise.all([alice.close(), bob.close()]);
});

test('presence-datagrid.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', IMPACT_OF_HOURS);
  await share(alice, bob, bGroup, docId, 'edit');
  await nameContact(alice, 0, 'Bob');
  await nameContact(bob, 0, 'Alice');
  await warmDoc(alice, docId, 'Where My Hours Help Most');
  await warmDoc(bob, docId, 'Where My Hours Help Most');

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      await beat(l, 900);

      // Pan both sheets right, to the same estimate column.
      await Promise.all([panToCell(l, BOB_CELL), panToCell(r, BOB_CELL)]);

      // Bob selects a TRIANGULAR cell. His pane raises the Monte Carlo panel —
      // histogram plus μ/σ/percentiles for a cell whose value is a distribution
      // rather than a number. Alice's pane outlines that same cell and tags it
      // with Bob's name, because presence is the path to the cell.
      await tapCell(r, BOB_CELL);
      await expect(r.locator('.dist-panel')).toBeVisible({ timeout: 60_000 });
      await expect(l.locator('td.peer-focused')).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      // Alice selects two rows down, so the tag appears on Bob's side too — both
      // directions at once, each peer with its own selection and its own panel.
      await tapCell(l, ALICE_CELL);
      await expect(l.locator('.dist-panel')).toBeVisible({ timeout: 30_000 });
      await expect(r.locator('td.peer-focused')).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);

      // Bob highlights three whole rows from the row headers: one tap, then a
      // shift-tap two rows down, which extends from the last one clicked.
      //
      // This one is local to Bob's pane by construction, and that is not an
      // oversight in the capture. A header selection clears the selected *cell*
      // (DataGrid's handleRowHeaderClick), and presence broadcasts a cell path —
      // so while the band is up Bob has nothing to announce and his tag drops off
      // Alice's grid. Filming it anyway because the band is a real selection with
      // real commands behind it; Bob takes a cell again afterwards to get the tag
      // back. (The dragged range and its aggregates strip used to sit here; that
      // beat is still in tour.gif.)
      await tap(r, rowHeaderAt(r, ROW_BAND_FROM));
      await r.keyboard.down('Shift');
      await tap(r, rowHeaderAt(r, ROW_BAND_TO));
      await r.keyboard.up('Shift');
      await expect(r.locator('td.datagrid-row-header.selected')).toHaveCount(
        ROW_BAND_TO - ROW_BAND_FROM + 1
      );
      await beat(r, 1600);
      await tapCell(r, BOB_CELL);
      await beat(r, 600);

      // Alice pans back until the formula cell and both cells it references are in
      // one frame, and opens it. Focusing the bottom bar's editor is what starts the
      // edit, and while an edit is live every reference outlines its cell in the same
      // colour its token has — `=C2*D2*12`, so the two cells immediately left of this
      // one. The refs only render while a cell is being edited, so the hold has to
      // happen before anything is committed.
      await panToShow(l, [HOURS_PER_SESSION, SESSIONS_PER_MONTH, HOURS_PER_YEAR]);
      await tapCell(l, HOURS_PER_YEAR);
      await beat(l, 500);
      // CodeMirror is loaded lazily (and the bar only mounts in focus mode), so
      // wait for the editable rather than assuming it is there to be tapped.
      const formulaBar = l.locator('.bottom-editor-cm .cm-content');
      await expect(formulaBar).toBeVisible({ timeout: 30_000 });
      await tap(l, formulaBar);
      await expect(l.locator('td.formula-ref-highlight')).toHaveCount(2, { timeout: 30_000 });
      await beat(l, 1500);

      // Walking the caret back across the formula moves the *active* ref, which
      // fills the matching cell instead of only outlining it — so each dependency
      // lights up in turn, D2 then C2.
      for (const _ of [0, 1, 2, 3, 4, 5]) {
        await l.keyboard.press('ArrowLeft');
        await beat(l, 320);
      }
      await beat(l, 900);

      // Then a real edit to it — twelve months becomes eleven, the one everybody
      // takes off — and Bob's copy of every figure derived from it moves too.
      await l.keyboard.press('End');
      await l.keyboard.press('Backspace');
      await l.keyboard.press('Backspace');
      await typeText(l, '11', 140);
      await l.keyboard.press('Enter');
      await expect(cellAt(l, HOURS_PER_YEAR)).toContainText('66', { timeout: 30_000 });
      await expect(cellAt(r, HOURS_PER_YEAR)).toContainText('66', { timeout: 60_000 });
      await beat(r, 1800);

      // And the two panels that decide how a sheet looks, opened and closed
      // without touching anything: the text-formatting sheet from the focus-mode
      // top bar, and conditional formatting from inside it.
      await tap(l, l.getByLabel('Text formatting'));
      await expect(l.getByTestId('format-sheet')).toBeVisible({ timeout: 30_000 });
      await beat(l, 1800);
      await tap(l, l.locator('md-list-item', { hasText: 'Conditional formatting' }));
      await expect(l.getByTestId('cond-format-sheet')).toBeVisible({ timeout: 30_000 });
      // Shown, not used: the list holds exactly the rules the example shipped with
      // — asserted here, while it is on screen, because once the sheet closes the
      // rows are gone and "nothing was added" is true of any grid at all.
      await expect(l.locator('[data-testid^="cf-rule-"]')).toHaveCount(CF_RULE_COUNT);
      await beat(l, 2000);
      await tap(l, l.getByRole('button', { name: 'Close' }).first());
      await expect(l.getByTestId('cond-format-sheet')).toHaveCount(0, { timeout: 30_000 });
      await beat(l, 900);
    },
    {
      // Both start inside the sheet, and the clip only opens once each grid has
      // painted *and* the Monte Carlo pass has landed — the ± values and the
      // `dist-source` tint are the proof of that, and the opening frame is the
      // one held longest.
      leftUrl: `/#/d/${docId}`,
      rightUrl: `/#/d/${docId}`,
      settle: async (l, r) => {
        for (const page of [l, r]) {
          await expect(cellAt(page, HOURS_PER_SESSION)).toBeVisible({ timeout: 60_000 });
          await expect(page.locator('td.dist-source').first()).toBeVisible({ timeout: 60_000 });
        }
        await bothSeeEachOther(l, r);
      },
    }
  );

  // The heaviest asset in the deck: two dense sheets of numbers, where every
  // Monte Carlo re-sample nudges most cells. 8fps and a 720px cap bring it into
  // line with the other two-peer GIFs; the flow is taps and settling figures, so
  // neither is visible at slide size.
  //
  // Still the house 64 colours, unlike presence-peritext's 32: the row band, the
  // formula-reference beat and the two sheets made this clip half again as long
  // (2842 KB), and 48 was tried — but this frame carries conditional-format fills, a
  // Monte Carlo histogram and italic ± values, which is far more distinct colour
  // than a page of prose, and the run that would have measured it could not be
  // completed. Left at 64 so the encode here matches the asset in docs/; measure
  // and lower it on a quiet tree if the size matters.
  await hstackGif('presence-datagrid.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([alice.close(), bob.close()]);
});

test('validation.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', SHARED_TASKS);
  await share(alice, bob, bGroup, docId, 'edit');
  await nameContact(alice, 0, 'Bob');
  await nameContact(bob, 0, 'Alice');
  await warmDoc(alice, docId, 'Camping trip');
  await warmDoc(bob, docId, 'Camping trip');

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      await beat(l, 900);

      // `t1` is the completed task. Its `progress` is an optional enum, so
      // deleting it raises no error — what it does is drop the task out of the
      // Done group on Alice's side, one document away.
      await expandRow(r, 't1');
      await tap(r, sourceRow(r, 'progress').locator('.source-btn.delete'));
      await expect(sourceRow(r, 'progress')).toHaveCount(0, { timeout: 30_000 });
      await beat(l, 2000);

      // Now something the schema does reject: `progress` is a five-value enum, so
      // typing a plausible-but-wrong word raises a schema error — listed in the
      // source editor's panel, badged inline on the offending key, and flagged by
      // the warning icon on the document's own title bar.
      await expandRow(r, 't3');
      const progress = sourceRow(r, 'progress').locator('.source-string');
      await tap(r, progress);
      await beat(r, 400);
      await r.keyboard.press('ControlOrMeta+a');
      await typeText(r, 'done', 110);
      await r.keyboard.press('Enter');

      await expect(r.locator('.validation-panel-dark')).toBeVisible({ timeout: 30_000 });
      await expect(r.locator('.source-error-icon.schema').first()).toBeVisible({ timeout: 30_000 });
      await expect(l.locator('[aria-label="Validation errors"]')).toBeVisible({ timeout: 30_000 });
      await beat(l, 1200);

      // Bring the error panel itself on screen — that is where the message reads.
      // The tree's own auto-scroll leaves the panel above the frame, and neither
      // `window.scrollTo` nor Playwright's `scrollIntoViewIfNeeded` shifts it (the
      // viewer scrolls an inner container, and Playwright judges the panel already
      // in view). The DOM's own scrollIntoView walks every scrollable ancestor.
      await r.evaluate(() =>
        document.querySelector('.validation-panel-dark')
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      );
      await beat(r, 2600);
    },
    {
      // Left is the task list, right is the same document as JSON.
      leftUrl: `/#/d/${docId}`,
      rightUrl: `/#/source/${docId}`,
      settle: async (l, r) => {
        await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
        await expect(r.locator('.source-tree')).toBeVisible({ timeout: 60_000 });
        await expect(sourceRow(r, 'tasks')).toBeVisible({ timeout: 60_000 });
      },
    }
  );

  await hstackGif('validation.gif', clips.left, clips.right, { width: 720 });
  await Promise.all([alice.close(), bob.close()]);
});

test('presence-source.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  const { bGroup } = await befriend(alice, bob);

  const { docId } = await alice.call('createDoc', TRIP_PLANNER);
  await share(alice, bob, bGroup, docId, 'edit');
  await nameContact(alice, 0, 'Bob');
  await nameContact(bob, 0, 'Alice');
  await warmDoc(alice, docId, 'Vacation Trip Planner');
  await warmDoc(bob, docId, 'Vacation Trip Planner');

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      await beat(l, 1200);

      // Deliberately slow: each of Alice's selections has to travel, land as a
      // presence path, expand the matching branch of Bob's tree and scroll it
      // into view before the next one starts.
      await tapCell(l, LODGING);
      await expect(sourceRow(r, 'r5:c2').getByTestId('peer-dot')).toBeVisible({ timeout: 60_000 });
      await beat(r, 2200);

      await tapCell(l, FOOD_AND_FUN);
      await expect(sourceRow(r, 'r7:c2').getByTestId('peer-dot')).toBeVisible({ timeout: 60_000 });
      await beat(r, 2200);

      // The payoff: cells are sparse, so typing into an empty one *creates* the
      // key. It arrives in Bob's tree mid-list, flashes, and takes the dot.
      await tapCell(l, EMPTY_CELL);
      await beat(l, 800);
      await typeText(l, '1250', 150);
      await l.keyboard.press('Enter');
      await expect(sourceRow(r, 'r14:c2')).toBeVisible({ timeout: 60_000 });
      await beat(r, 900);

      // Enter drops the selection a row down, and the tree only scrolls itself to
      // a peer's *exact* focus — so step back onto the cell just created. That is
      // what puts the dot on the new key instead of leaving it off-screen.
      await tapCell(l, EMPTY_CELL);
      await expect(sourceRow(r, 'r14:c2').getByTestId('peer-dot')).toBeVisible({ timeout: 60_000 });
      await sourceRow(r, 'r14:c2').scrollIntoViewIfNeeded();
      await beat(r, 2600);
    },
    {
      leftUrl: `/#/d/${docId}`,
      // Deep-link the tree at a *cell*, not at `cells`: reveal expands a node's
      // ancestors and leaves the node itself as it was, so aiming at the
      // container opens everything above it and still shows `{ 83 keys }`.
      // Aiming one level deeper is what unfolds the keys.
      rightUrl: `/#/source/${docId}/sheets/plan/cells/${encodeURIComponent('r1:c1')}`,
      settle: async (l, r) => {
        await expect(cellAt(l, LODGING)).toBeVisible({ timeout: 60_000 });
        await expect(sourceRow(r, 'r1:c1')).toBeVisible({ timeout: 60_000 });
        // Wait for HyperFormula to actually finish. A painted grid is not an
        // evaluated one: cross-sheet references read `#REF!` for a beat, and the
        // opening frame is the one held longest. A `±` in this cell means the
        // Monte Carlo pass has landed too.
        await expect(cellAt(l, LODGING)).toContainText('±', { timeout: 60_000 });
        await expect(cellAt(l, [1, 3])).not.toContainText('#REF', { timeout: 60_000 });
      },
    }
  );

  await hstackGif('presence-source.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([alice.close(), bob.close()]);
});

/**
 * One user, two of their own devices — and an access change that lands on the
 * other one while you watch.
 *
 * Two devices rather than two people because a role is not a property of a
 * document share here: the Sharing page is group-only (adding a friend adds all
 * of their devices), so the only per-device control in the app is Settings →
 * Devices. It is not a lesser demonstration — keyhive caps access at the minimum
 * along the delegation path, so a device demoted inside its own user-group is
 * demoted on every document that group can reach, and `getMyAccess` resolves the
 * *device*, not the group. Hence: change the role of 📱 iOS on the left, and the
 * Habit Tracker open on 📱 iOS re-renders on the right with no reload.
 *
 * The demoted device is always the linked one. A founding device's root
 * delegation is permanent in keyhive, so demoting the first device would change
 * the Select and nothing else.
 */
test('device-permissions.gif', async ({ browser }) => {
  // A device link plus four role changes, and every one of those is a keyhive
  // revoke-and-re-add with a key rotation that has to reach the other device.
  // This does not fit the suite-wide 240s.
  test.setTimeout(600_000);
  const android = await capturePeer(browser, 'android', { video: true });
  const ios = await capturePeer(browser, 'ios', { video: true });
  await setDisplayName(android.page, 'Alice');
  const iosAgentId = await setDeviceName(ios, IOS);

  const { docId } = await android.call('createDoc', SHARED_COUNTERS);

  // Link the second device off camera — the handshake is its own asset
  // (linking-a-device.gif) and this clip is about what happens afterwards.
  await android.page.goto('/#/settings/devices');
  await android.page.getByRole('button', { name: 'Link Device' }).click();
  const link = android.page.locator('input[readonly]');
  await expect(link).toBeVisible({ timeout: 60_000 });
  await ios.page.goto(await link.inputValue());
  await expect(ios.page.getByText('Linking complete')).toBeVisible({ timeout: 120_000 });
  // A linked device joins the user-group as an admin, and the group administers
  // every document its user creates — so the doc arrives on its own.
  await warmDoc(ios, docId, 'Habit Tracker');

  /** Write affordances on the second device; present only at `edit` or `admin`. */
  const recordButtons = (page: Page) => page.locator('[aria-label^="Record completion"]');
  /** The share glyph is on the title bar for admins only; others get a kebab item. */
  const shareGlyph = (page: Page) => page.locator('[aria-label="Share"]');
  /** The bottom row is the schedule-less tally, whose badge is a `N×` count. */
  const bottomRow = (page: Page) => page.getByTestId('counter-row').last();
  const bottomCount = async (page: Page) =>
    ((await bottomRow(page).innerText()).match(/(\d+)×/) ?? [])[1];
  /**
   * A counter's title, which records a completion just like the leading icon
   * does. Aimed at rather than the icon because it is the bigger target and the
   * cursor lands somewhere a viewer is already reading — and because it is the
   * same spot in both states: with write access it is a button, without it the
   * identical text is inert, so the tap that worked visibly stops working.
   */
  const titleOf = (row: Locator) => row.locator('[slot="headline"] button, [slot="headline"]').first();

  /** Record on the bottom counter; the count ticks up on this device's screen. */
  async function recordOnBottom(page: Page): Promise<void> {
    const before = await bottomCount(page);
    await tap(page, titleOf(bottomRow(page)));
    await expect
      .poll(() => bottomCount(page), { timeout: 30_000, intervals: [300] })
      .not.toBe(before);
  }

  /** The 📱 iOS row of the device list. Its `title` is the device's agentId. */
  const iosRow = (page: Page) => page.getByTestId('device-row').filter({ has: page.locator(`[title="${iosAgentId}"]`) });

  /**
   * Change 📱 iOS's role from the first device: tap the row, tap Change access, pick
   * from the shared role picker. (The inline Radix Select this used to drive is gone
   * — device rows open an options sheet now.)
   */
  async function setDeviceRole(page: Page, role: 'Read' | 'Edit' | 'Admin'): Promise<void> {
    await tap(page, iosRow(page));
    await expect(page.getByTestId('device-options-sheet')).toBeVisible({ timeout: 30_000 });
    await tap(page, page.getByTestId('device-change-role'));
    await expect(page.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    await tap(page, page.getByTestId(`role-${role.toLowerCase()}`));
    // The row shows the fetched role, so it holds the old value until the change
    // round-trips. That is the real signal — and it takes a while: changeDeviceRole
    // is a revoke plus a re-add with a key rotation.
    await expect(iosRow(page).getByTestId('device-role')).toHaveText(role, { timeout: 60_000 });
  }

  const clips = await takePair(
    android,
    ios,
    async (l, r) => {
      // A linked device starts out as an admin of its own user-group.
      await expect(iosRow(l).getByRole('combobox')).toHaveText('Admin');
      await beat(l, 1600);

      // Admin: the second device has the share glyph, and its counters work.
      await expect(shareGlyph(r)).toBeVisible({ timeout: 30_000 });
      await recordOnBottom(r);
      await beat(r, 1400);

      // Down to edit: the share affordance goes, but the same tap still records.
      await setDeviceRole(l, 'Edit');
      await expect(shareGlyph(r)).toHaveCount(0, { timeout: 60_000 });
      await beat(r, 1000);
      await recordOnBottom(r);
      await beat(r, 1400);

      // Down to read: every write affordance disappears — the buttons are not
      // disabled, they are not rendered. So the same tap on the same title now
      // does nothing: the tally holds, and no editor sheet opens either.
      await setDeviceRole(l, 'Read');
      await expect(recordButtons(r)).toHaveCount(0, { timeout: 60_000 });
      await expect(r.getByRole('button', { name: 'New counter' })).toHaveCount(0);
      await beat(r, 900);
      const held = await bottomCount(r);
      await tap(r, titleOf(bottomRow(r)));
      // The editor opens on its property list, so "no editor" is the absence of
      // the Title *row* (the field itself only exists once that row is tapped).
      await expect(r.getByTestId('ced-title-row')).toHaveCount(0);
      await beat(r, 1200);
      expect(await bottomCount(r)).toBe(held);
      await beat(r, 1200);

      // And back up again, each step arriving without a reload.
      await setDeviceRole(l, 'Edit');
      await expect(recordButtons(r).first()).toBeVisible({ timeout: 60_000 });
      await beat(r, 1000);
      await recordOnBottom(r);
      await beat(r, 1400);

      await setDeviceRole(l, 'Admin');
      await expect(shareGlyph(r)).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);

      // Close on the second device proving it for itself: it opens Sharing and
      // finds the admin-only "Add people" control there. Nobody else is on this
      // document and this user has no friends, so the page opens its QR invite
      // by itself — dismiss that to land on the page underneath.
      await tap(r, shareGlyph(r));
      await expect(r.getByRole('heading', { name: 'Sharing' })).toBeVisible({ timeout: 30_000 });
      const closeInvite = r.getByRole('button', { name: 'Close' }).first();
      await closeInvite.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
      if (await closeInvite.isVisible()) {
        await beat(r, 1000);
        await tap(r, closeInvite);
      }
      await expect(r.getByRole('button', { name: 'Add people' })).toBeVisible({ timeout: 30_000 });
      await beat(r, 2400);
    },
    {
      // The device list on one; the document it is about to lose access to on the other.
      leftUrl: '/#/settings/devices',
      rightUrl: `/#/d/${docId}`,
      settle: async (l, r) => {
        await expect(l.getByTitle(iosAgentId)).toBeVisible({ timeout: 60_000 });
        await expect(r.getByTestId('counter-row').first()).toBeVisible({ timeout: 60_000 });
      },
    }
  );

  // The longest asset in the set — four key rotations, each of which has to reach
  // the other device. 6fps was measured and came out *bigger* than 8 (fewer frames
  // each carrying a larger delta), so this stays at the house rate.
  await hstackGif('device-permissions.gif', clips.left, clips.right, { fps: 8 });
  await Promise.all([android.close(), ios.close()]);
});

test('add-and-share-with-friend.gif', async ({ browser }) => {
  const alice = await capturePeer(browser, 'alice', { video: true });
  const bob = await capturePeer(browser, 'bob', { video: true });
  await setDisplayName(alice.page, 'Alice');
  await setDisplayName(bob.page, 'Bob');
  // Each side names the other when the rendezvous completes (native prompt).
  alice.setPromptAnswer('Bob');
  bob.setPromptAnswer('Alice');

  const { docId } = await alice.call('createDoc', SHARED_TASKS);

  const clips = await takePair(
    alice,
    bob,
    async (l, r) => {
      // Alice starts in the document they want to share.
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      // The sharing page opens its QR invite by itself when a document has no
      // members and the user has no contacts — there would be nothing else to
      // show. So do NOT click "Add people" here: that click lands on the
      // sheet's own overlay and dismisses the invite instead of opening it.
      await tap(l, l.getByRole('link', { name: 'Share' }));
      const qr = l.locator('div[title="Click to copy link"] svg');
      await expect(qr).toBeVisible({ timeout: 60_000 });
      // Rest on the QR, then flash the frame: Bob is scanning it.
      await scanFlash(l, qr);

      const url = await l.locator('input[readonly]').inputValue();
      expect(url).toMatch(/#\/add-friend\/r\./);

      await r.goto(url);
      // The receiver's success path is a prompt() then a bounce to home, so the
      // contact landing on Bob's side is the observable end of the exchange.
      await expect(r).toHaveURL(/#\/$/, { timeout: 120_000 });
      await beat(r, 900);

      // Alice's QR sheet closes itself once the exchange is done, and the page
      // then asks what the new friend may do — sharing always names a role.
      await expect(l.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 60_000 });
      await beat(l, 900);
      await tap(l, l.getByTestId('role-edit'));
      // You are not a row in your own share list, so one contact is one row.
      await expect(l.getByTestId('member-row')).toHaveCount(1, { timeout: 60_000 });
      await beat(l, 900);

      // It appears on Bob's home page, and Bob opens it.
      await r.goto('/#/');
      const row = r.getByTestId('doc-row').filter({ hasText: 'Camping trip' });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await beat(r, 1200);
      await tap(r, row);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);
    },
    // Alice opens on the document itself; Bob on their (empty) home page.
    { leftUrl: `/#/d/${docId}`, rightUrl: '/#/' }
  );

  await hstackGif('add-and-share-with-friend.gif', clips.left, clips.right);
  await Promise.all([alice.close(), bob.close()]);
});
