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
 * Phil's phrase sits before Sam's, and his replacement is *nine characters
 * longer* than what it replaces — deliberately, because that shift is the whole
 * claim. An equal-length replacement would leave every index after it unchanged
 * and a caret that had not been rebased would look perfectly fine.
 */
const PROSE = 'We hike in on Friday and pitch the tents by the lake before dark.';
const PHIL_PHRASE = 'hike in on Friday';
const PHIL_TYPES = 'drive up on Thursday night';
const SAM_PHRASE = 'by the lake';
const SAM_TYPES = 'at the ridge';
const PROSE_FINAL = 'We drive up on Thursday night and pitch the tents at the ridge before dark.';

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
  'Sam is bringing the big tent and the stove. I have the tarp, the water filter and both sleeping mats, so nobody carries two of anything.',
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

// One fixture tweak, about phone width: narrowing the `Way of helping` labels is
// what puts more than one estimate column on screen at a time. This used to also
// set `frozenCols = 0` — the examples no longer freeze a column at all, precisely
// because at 430px a frozen one is a sticky pane sitting on top of wherever a tap
// lands, and cells to its right cannot be selected.
IMPACT_OF_HOURS.sheets.compare.columns.c1.width = 150;

/**
 * Cells on the *Compare* sheet as `[col, row]` grid indices.
 *
 * Both peers' cells sit in the same column (`People reached per hour`) on
 * purpose: these columns are 150–160px against ~280px of grid beside the (now
 * unfrozen, narrowed) label column, so two of them never share the screen — and a
 * peer's highlight is only worth capturing if the *other* pane is looking at it.
 */
const SAM_CELL: [number, number] = [5, 1]; // =TRIANGULAR(0.8,1.5,1)
const PHIL_CELL: [number, number] = [5, 3]; // =TRIANGULAR(2,6,3)
const RANGE_FROM: [number, number] = [5, 5];
const RANGE_TO: [number, number] = [5, 8];
const HOURS_PER_SESSION: [number, number] = [2, 1]; // a plain 1.5 — the edit target

const cellAt = (page: Page, [col, row]: [number, number]) =>
  page.locator(`td[data-cell-col="${col}"][data-cell-row="${row}"]`);

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
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await seedExamples(phil.page);
  await still(phil.page, 'homepage.png');
  await phil.close();
});

test('settings.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await phil.page.goto('/#/settings');
  await expect(phil.page.locator('md-list-item').filter({ hasText: 'Devices' })).toBeVisible();
  await still(phil.page, 'settings.png');
  await phil.close();
});

// ---------------------------------------------------------------- stills, two peers

test('connections.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  const sam = await capturePeer(browser, 'sam');
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  // Only Sam's id is needed here, not a name set on Sam's own device: a friend's
  // device name never travels (see the relabel below), and this shot is taken on
  // Phil's page — so naming Sam's device from Sam would change nothing.
  const { agentId: samAgentId } = await sam.call('getIdentity');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  await share(phil, sam, bGroup, docId);

  // Both sitting on the doc is what makes them peers on the wire.
  await phil.page.goto(`/#/d/${docId}`);
  await sam.page.goto(`/#/d/${docId}`);

  // The direct-WebRTC upgrade is opportunistic. Prefer it — a filled dot and
  // "direct (P2P)" is the whole point of the slide — but do not fail the run if
  // the upgrade doesn't land; the relay fallback is a truthful screenshot too.
  const direct = await waitFor(
    () => phil.call('getDirectPeers'),
    (peers) => Array.isArray(peers) && peers.length > 0,
    { label: 'direct P2P channel', timeout: 45_000, interval: 1000 }
  ).catch(() => null);
  if (!direct) console.warn('  ! no direct WebRTC channel — connections.png will show "via relay"');

  await phil.page.goto('/#/settings/debugging');
  await expect(phil.page.getByText(/Peer devices connected: [1-9]/)).toBeVisible({ timeout: 60_000 });
  // Sam is a friend, not a linked device, so their device name never travelled
  // to Phil — the peer row would read as a truncated agent id. The row's field
  // is editable for exactly this reason (a local label), so set it here.
  const samRow = phil.page.getByTitle(samAgentId);
  await expect(samRow).toBeVisible({ timeout: 30_000 });
  await samRow.fill(IOS);
  await samRow.press('Enter');
  await beat(phil.page, 800);
  await still(phil.page, 'connections.png');
  await Promise.all([phil.close(), sam.close()]);
});

// ---------------------------------------------------------------- screencasts, one peer

test('new-doc.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await seedExamples(phil.page);

  const clip = await take(phil, async (page) => {
    await beat(page, 900);
    await tap(page, page.getByRole('button', { name: 'New document' }));
    const sheet = page.getByTestId('create-doc-sheet');
    await expect(sheet).toBeVisible();
    await beat(page, 700);

    // Substring match: shadow-DOM innerText carries a trailing newline.
    await tap(page, sheet.locator('md-list-item', { hasText: 'Task list' }));
    await expect(page.getByTestId('doc-title')).toBeVisible({ timeout: 30_000 });
    await beat(page, 600);

    // Renaming is deliberate now: kebab -> Rename -> a Material sheet. (This is
    // why the beat still reads on camera — the old window.prompt was an OS
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
  await phil.close();
});

test('tour.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  await setDisplayName(phil.page, 'Phil');
  // Deliberately no seedExamples: the offer only renders on an empty home page, and
  // tapping it is the first beat of this clip rather than setup for it.

  const clip = await take(
    phil,
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
      // Selecting a cell puts the grid in focus mode, and that swaps the title
      // bar's Back link for a Done checkmark (the same affordance the sentences
      // editor uses in edit mode) — so leaving takes two taps, not one.
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
      // Mid-block replacement is the path peritext-presence.gif already asserts.
      await openRow(page, 'Tahoe trip');
      await expect(page.getByTestId('rt-editor')).toContainText('Pinecrest', { timeout: 60_000 });
      await beat(page, 1300);
      await tap(page, page.getByLabel('Edit sentences'));
      await expect(page.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(page, 400);
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
      await beat(page, 1200);

      // Out of edit mode (the checkmark), back to the list.
      await tap(page, page.getByLabel('Done'));
      await beat(page, 400);
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
  // different screens — and the one that established that fps is not the lever that
  // matters here: 8fps came out at 5.6 MB, and it is the palette and the decimation
  // (now every asset's default, see gif.ts) that take it under three. 6fps on top,
  // because this clip is mostly held screens.
  await toGif('tour.gif', clip, { fps: 6 });
  await phil.close();
});

test('timeline.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  await seedExamples(phil.page);
  const docId = await openDocNamed(phil.page, 'Family Groceries');

  const clip = await take(phil, async (page) => {
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
  await phil.close();
});

// ---------------------------------------------------------------- screencasts, two peers

test('linking-a-device.gif', async ({ browser }) => {
  const android = await capturePeer(browser, 'android', { video: true });
  const ios = await capturePeer(browser, 'ios', { video: true });
  await setDisplayName(android.page, 'Phil');
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
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  await share(phil, sam, bGroup, docId, 'edit');
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');
  // Both workers must hold the doc before either editor mounts, or the first
  // presence broadcast races a cold worker and no dots appear.
  await warmDoc(phil, docId, 'Camping trip');
  await warmDoc(sam, docId, 'Camping trip');

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      // Staggered opens, as editor-presence.spec.ts does: Phil is already in the
      // document when Sam arrives, so the capture shows a peer *joining*.
      await l.goto(`/#/d/${docId}`);
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 2500);

      await r.goto(`/#/d/${docId}`);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await expect(l.getByTestId('peer-dot').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1200);

      // Both open the *same* task. The editor is a property list, so Phil sees
      // Sam's dot walk down labelled rows — Title, then Priority, then
      // Description — and the occupied row greys out. That reads far better at
      // 430px than dots pinned to a flat form's labels.
      const TASK = 'Plan the meals';
      await tap(l, l.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(l.getByTestId('ted-title-row')).toBeVisible({ timeout: 30_000 });
      await beat(l, 900);

      await tap(r, r.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(r.getByTestId('ted-title-row')).toBeVisible({ timeout: 30_000 });
      await beat(r, 900);

      // Sam edits one property at a time, tapping Save to return to the list; on
      // Phil's side the dot follows while Sam types, because presence is a path
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
      // Save this one too, so the clip ends on Phil's list showing all three
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
  await Promise.all([phil.close(), sam.close()]);
});

test('peritext-presence.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', {
    '@type': 'Sentences',
    name: 'Trip notes',
    content: '',
  });
  await share(phil, sam, bGroup, docId, 'edit');
  // Both sides, or the name tip above a caret renders a truncated agent id.
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');

  // Seed the document off camera through the app's own Markdown import — the
  // hidden picker behind the "Import Markdown" overflow action, driven directly
  // because the menu itself is not what is being documented. Handing `content` to
  // createDoc would be cheaper, but the asset is entirely about cursors *into*
  // Peritext spans, so the text is built by the same `updateSpans` op a real
  // import uses. (The confirm() guard only fires on a document that already has
  // content; this one is empty.)
  await phil.page.goto(`/#/d/${docId}`);
  await expect(phil.page.getByTestId('rt-editor')).toBeVisible({ timeout: 60_000 });
  await phil.page.setInputFiles('[data-testid="import-md-input"]', {
    name: 'trip-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(PROSE_DOC, 'utf8'),
  });
  await expect(phil.page.getByTestId('rt-editor')).toContainText(PROSE, { timeout: 30_000 });

  // Both workers must hold the document before either editor mounts, and Sam must
  // actually have the text — a cold worker races the first presence broadcast and
  // no carets appear at all.
  await warmDoc(phil, docId, 'Trip notes');
  await warmDoc(sam, docId, 'Trip notes');
  await sam.page.goto(`/#/d/${docId}`);
  await expect(sam.page.getByTestId('rt-editor')).toContainText(PROSE, { timeout: 60_000 });

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      // Phil enters edit mode and selects a phrase near the start.
      await tap(l, l.getByLabel('Edit sentences'));
      await expect(l.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(l, 450);
      const philSel = await phraseGrips(l, PHIL_PHRASE);
      await selectPhrase(l, philSel.word, philSel.end);
      // Assert what the gesture actually caught. A selection one character short
      // would still record a perfectly plausible-looking clip — and then leave a
      // stray letter behind when it is typed over.
      expect(await l.evaluate(() => window.getSelection()?.toString())).toBe(PHIL_PHRASE);

      // It reaches Sam as a coloured block with Phil's name above it.
      await expect(r.getByTestId('peer-tip')).toHaveText('Phil', { timeout: 60_000 });
      await expect(r.getByTestId('peer-highlight').first()).toBeVisible();
      await beat(r, 800);

      // Sam selects a phrase further along, and Phil sees that one the same way.
      await tap(r, r.getByLabel('Edit sentences'));
      await expect(r.getByTestId('format-bar')).toBeVisible({ timeout: 30_000 });
      await beat(r, 450);
      const samSel = await phraseGrips(r, SAM_PHRASE);
      await selectPhrase(r, samSel.word, samSel.end);
      expect(await r.evaluate(() => window.getSelection()?.toString())).toBe(SAM_PHRASE);
      await expect(l.getByTestId('peer-tip')).toHaveText('Sam', { timeout: 60_000 });
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
      const [samColour, philColour] = [await tipColour(l), await tipColour(r)];
      if (samColour === philColour) {
        console.warn(`  ! both peers hashed to ${samColour} — re-run for two distinct colours`);
      } else if (samColour === INDIGO || philColour === INDIGO) {
        console.warn('  ! a peer hashed to indigo, which reads as the local selection — re-run');
      }
      // Hold with both selections up on both panes: the "before" frame the payoff
      // is read against. Both hands come off the mouse first — from here on every
      // frame that matters is a frame of text, and a 26px ring parked on the words
      // covers the ones being edited.
      await hideCursor(r);
      await hideCursor(l);
      await beat(l, 1300);

      // Phil types over his selection, nine characters longer than what it
      // replaced, so every index past it moves.
      await typeText(l, PHIL_TYPES, 85);
      await expect(r.getByTestId('rt-editor')).toContainText(PHIL_TYPES, { timeout: 60_000 });
      // The claim: Sam has not touched his selection, and after the text in front
      // of it grew it still holds the same words — not the same offsets. This is
      // sentences-local-caret.spec.ts's assertion made through what is on screen
      // instead of through the next keystroke.
      await expect
        .poll(() => r.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 30_000 })
        .toBe(SAM_PHRASE);
      await beat(r, 1500);

      // And because it is still his selection, typing replaces exactly it.
      await typeText(r, SAM_TYPES, 85);
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
      },
    }
  );

  // fps 8, as the other long two-peer clips use, and measured rather than assumed:
  // a pane full of prose costs real bytes, and 10fps came out at 3.2 MB against
  // 2.7 at 8 (the same ~15% the raw clips showed). `width` is the wrong lever here
  // for the reason gif.ts records — downscaling body text costs more than it saves.
  // The typing cadence is 85ms to suit it: at 8fps a faster one lands two
  // characters per frame and reads as a paste rather than as typing.
  await hstackGif('peritext-presence.gif', clips.left, clips.right, { fps: 8 });
  await Promise.all([phil.close(), sam.close()]);
});

test('datagrid-presence.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', IMPACT_OF_HOURS);
  await share(phil, sam, bGroup, docId, 'edit');
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');
  await warmDoc(phil, docId, 'Where My Hours Help Most');
  await warmDoc(sam, docId, 'Where My Hours Help Most');

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      await beat(l, 900);

      // Pan both sheets right, to the same estimate column.
      await Promise.all([panToCell(l, SAM_CELL), panToCell(r, SAM_CELL)]);

      // Sam selects a TRIANGULAR cell. His pane raises the Monte Carlo panel —
      // histogram plus μ/σ/percentiles for a cell whose value is a distribution
      // rather than a number. Phil's pane outlines that same cell and tags it
      // with Sam's name, because presence is the path to the cell.
      await tapCell(r, SAM_CELL);
      await expect(r.locator('.dist-panel')).toBeVisible({ timeout: 60_000 });
      await expect(l.locator('td.peer-focused')).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      // Phil selects two rows down, so the tag appears on Sam's side too — both
      // directions at once, each peer with its own selection and its own panel.
      await tapCell(l, PHIL_CELL);
      await expect(l.locator('.dist-panel')).toBeVisible({ timeout: 30_000 });
      await expect(r.locator('td.peer-focused')).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);

      // Sam highlights a range by dragging down the column: the bottom bar swaps
      // the cell editor for the aggregates of everything selected. Kept below
      // Phil's cell so the two selections read as separate things.
      await dragSelect(r, RANGE_FROM, RANGE_TO);
      await expect(r.getByTestId('aggregates-strip')).toBeVisible({ timeout: 30_000 });
      await beat(r, 1300);

      // Phil pans back to an input and retypes it — typing over a selected cell
      // starts the edit — and Sam's copy of every dependent figure moves with it.
      await panToCell(l, HOURS_PER_SESSION);
      await tapCell(l, HOURS_PER_SESSION);
      await beat(l, 500);
      await typeText(l, '3', 140);
      await l.keyboard.press('Enter');
      await beat(r, 2000);
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
      },
    }
  );

  // The heaviest asset in the deck: two dense sheets of numbers, where every
  // Monte Carlo re-sample nudges most cells. 8fps and a 720px cap bring it into
  // line with the other two-peer GIFs; the flow is taps and settling figures, so
  // neither is visible at slide size.
  await hstackGif('datagrid-presence.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([phil.close(), sam.close()]);
});

test('validation.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  await share(phil, sam, bGroup, docId, 'edit');
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');
  await warmDoc(phil, docId, 'Camping trip');
  await warmDoc(sam, docId, 'Camping trip');

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      await beat(l, 900);

      // `t1` is the completed task. Its `progress` is an optional enum, so
      // deleting it raises no error — what it does is drop the task out of the
      // Done group on Phil's side, one document away.
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
  await Promise.all([phil.close(), sam.close()]);
});

test('source-presence.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', TRIP_PLANNER);
  await share(phil, sam, bGroup, docId, 'edit');
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');
  await warmDoc(phil, docId, 'Vacation Trip Planner');
  await warmDoc(sam, docId, 'Vacation Trip Planner');

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      await beat(l, 1200);

      // Deliberately slow: each of Phil's selections has to travel, land as a
      // presence path, expand the matching branch of Sam's tree and scroll it
      // into view before the next one starts.
      await tapCell(l, LODGING);
      await expect(sourceRow(r, 'r5:c2').getByTestId('peer-dot')).toBeVisible({ timeout: 60_000 });
      await beat(r, 2200);

      await tapCell(l, FOOD_AND_FUN);
      await expect(sourceRow(r, 'r7:c2').getByTestId('peer-dot')).toBeVisible({ timeout: 60_000 });
      await beat(r, 2200);

      // The payoff: cells are sparse, so typing into an empty one *creates* the
      // key. It arrives in Sam's tree mid-list, flashes, and takes the dot.
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

  await hstackGif('source-presence.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([phil.close(), sam.close()]);
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
  await setDisplayName(android.page, 'Phil');
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

  /**
   * The 📱 iOS row of the device list, found by its name field.
   *
   * DeviceList carries no testids and its role Select has no id, so the shared
   * `radixSelect` helper does not apply. The name input's `title` is the device's
   * agentId, and the row is its grandparent (input → EditableName span → row).
   */
  const iosRow = (page: Page) => page.getByTitle(iosAgentId).locator('../..');

  /** Change 📱 iOS's role from the first device. No confirm(): that guard is self-only. */
  async function setDeviceRole(page: Page, role: 'Read' | 'Edit' | 'Admin'): Promise<void> {
    const trigger = iosRow(page).getByRole('combobox');
    await tap(page, trigger);
    // The listbox is portalled to document.body, so it is not inside the row.
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    // Matched on text, not accessible name: under Preact these Radix options
    // report the *selected* value as their name, so all three answer to
    // `getByRole('option', { name: 'Admin' })` and none to `'Edit'`.
    await tap(page, page.getByRole('option').filter({ hasText: role }));
    // The Select is controlled by the fetched role, so it snaps back to the old
    // value until the change round-trips. That is the real signal — and it takes
    // a while: changeDeviceRole is a revoke plus a re-add with a key rotation.
    await expect(trigger).toHaveText(role, { timeout: 60_000 });
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
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  // Each side names the other when the rendezvous completes (native prompt).
  phil.setPromptAnswer('Sam');
  sam.setPromptAnswer('Phil');

  const { docId } = await phil.call('createDoc', SHARED_TASKS);

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      // Phil starts in the document he wants to share.
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      // The sharing page opens its QR invite by itself when a document has no
      // members and the user has no contacts — there would be nothing else to
      // show. So do NOT click "Add people" here: that click lands on the
      // sheet's own overlay and dismisses the invite instead of opening it.
      await tap(l, l.getByRole('link', { name: 'Share' }));
      const qr = l.locator('div[title="Click to copy link"] svg');
      await expect(qr).toBeVisible({ timeout: 60_000 });
      // Rest on the QR, then flash the frame: Sam is scanning it.
      await scanFlash(l, qr);

      const url = await l.locator('input[readonly]').inputValue();
      expect(url).toMatch(/#\/add-friend\/r\./);

      await r.goto(url);
      // The receiver's success path is a prompt() then a bounce to home, so the
      // contact landing on Sam's side is the observable end of the exchange.
      await expect(r).toHaveURL(/#\/$/, { timeout: 120_000 });
      await beat(r, 900);

      // Phil's QR sheet closes itself once the exchange is done, and the page
      // then asks what the new friend may do — sharing always names a role.
      await expect(l.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 60_000 });
      await beat(l, 900);
      await tap(l, l.getByTestId('role-edit'));
      // You are not a row in your own share list, so one contact is one row.
      await expect(l.getByTestId('member-row')).toHaveCount(1, { timeout: 60_000 });
      await beat(l, 900);

      // It appears on Sam's home page, and he opens it.
      await r.goto('/#/');
      const row = r.getByTestId('doc-row').filter({ hasText: 'Camping trip' });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await beat(r, 1200);
      await tap(r, row);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);
    },
    // Phil opens on the document itself; Sam on his (empty) home page.
    { leftUrl: `/#/d/${docId}`, rightUrl: '/#/' }
  );

  await hstackGif('add-and-share-with-friend.gif', clips.left, clips.right);
  await Promise.all([phil.close(), sam.close()]);
});
