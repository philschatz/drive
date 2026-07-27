import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import { beat, glide, scanFlash, tap, tapAndReplace, tapAndType, type as typeText } from './cursor';
import { hstackGif, toGif } from './gif';
import {
  befriend,
  capturePeer,
  EXAMPLE_COUNT,
  nameContact,
  openDocNamed,
  seedExamples,
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
 * The *Where My Hours Help Most* example, read from the bundled examples rather
 * than copied in here: its TRIANGULAR/PERT/UNIFORM/BETA cells are what raise the
 * Monte Carlo panel, so the capture follows the app's own example if it changes.
 * Read from disk rather than imported so the harness needs no
 * `resolveJsonModule`.
 */
const IMPACT_OF_HOURS = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../src/client/home/examples/datagrid-impact-of-hours.json'),
    'utf8'
  )
);

// Two fixture tweaks for the capture, both about phone width. The example freezes
// the `Way of helping` column, which at 430px means a 300px sticky pane sitting on
// top of wherever a tap lands — cells to its right cannot be selected at all. With
// the freeze off, the labels simply pan away like any other column. Narrowing them
// as well is what puts more than one estimate column on screen at a time.
IMPACT_OF_HOURS.sheets.compare.frozenCols = 0;
IMPACT_OF_HOURS.sheets.compare.columns.c1.width = 150;

/**
 * Cells on the *Compare* sheet as `[col, row]` grid indices.
 *
 * Column 0 (`Way of helping`) is frozen, so it stays put while the rest of the
 * sheet pans under it — which is why the interesting columns are off-screen
 * until the grid is scrolled right.
 */
/**
 * Both peers' cells sit in the same column (`People reached per hour`) on
 * purpose: these columns are 150–160px against ~280px of grid beside the frozen
 * labels, so two of them never share the screen — and a peer's highlight is only
 * worth capturing if the *other* pane is looking at it.
 */
const SAM_CELL: [number, number] = [5, 1]; // =TRIANGULAR(0.8,1.5,1)
const PHIL_CELL: [number, number] = [5, 3]; // =TRIANGULAR(2,6,3)
const RANGE_FROM: [number, number] = [5, 5];
const RANGE_TO: [number, number] = [5, 8];
const HOURS_PER_SESSION: [number, number] = [2, 1]; // a plain 1.5 — the edit target

const cellAt = (page: Page, [col, row]: [number, number]) =>
  page.locator(`td[data-cell-col="${col}"][data-cell-row="${row}"]`);

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
    water: {
      '@type': 'Event',
      title: 'Two litres of water',
      startTime: '2026-07-20T08:00:00',
      recurrenceRule: { frequency: 'daily' },
      completions: {
        '2026-07-23T08:12:00': '',
        '2026-07-24T08:40:00': '',
        '2026-07-25T09:05:00': '',
      },
    },
    veg: {
      '@type': 'Event',
      title: 'Vegetables at lunch',
      startTime: '2026-07-20T12:30:00',
      recurrenceRule: { frequency: 'daily' },
      completions: { '2026-07-24T12:35:00': '', '2026-07-25T12:41:00': '' },
    },
    walk: {
      '@type': 'Event',
      title: 'Walk before dark',
      startTime: '2026-07-20T18:00:00',
      recurrenceRule: { frequency: 'daily' },
      completions: { '2026-07-25T18:20:00': '' },
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
    path.resolve(__dirname, '../../src/client/home/examples/datagrid-trip-planner.json'),
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

test('todo.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await seedExamples(phil.page);
  await openDocNamed(phil.page, 'Family Groceries');
  await expect(phil.page.getByTestId('task-row').first()).toBeVisible();
  await still(phil.page, 'todo.png');
  await phil.close();
});

test('link-device.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await phil.page.goto('/#/settings/devices');
  // Opening the sheet fires a native confirm() about syncing settings to the
  // new device; the peer's dialog handler accepts it.
  await phil.page.getByRole('button', { name: 'Link Device' }).click();
  await expect(phil.page.locator('div[title="Click to copy link"] svg')).toBeVisible({ timeout: 60_000 });
  await beat(phil.page, 600);
  await still(phil.page, 'link-device.png');
  await phil.close();
});

// ---------------------------------------------------------------- stills, two peers

test('connections.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  const sam = await capturePeer(browser, 'sam');
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
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

  await phil.page.goto('/#/connection');
  await expect(phil.page.getByText(/Peer devices connected: [1-9]/)).toBeVisible({ timeout: 60_000 });
  await beat(phil.page, 800);
  await still(phil.page, 'connections.png');
  await Promise.all([phil.close(), sam.close()]);
});

test('sharing.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  const sam = await capturePeer(browser, 'sam');
  const ada = await capturePeer(browser, 'ada');
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  await setDisplayName(ada.page, 'Ada');
  const { bGroup: samGroup } = await befriend(phil, sam);
  const { bGroup: adaGroup } = await befriend(phil, ada);
  await nameContact(phil, 0, 'Sam');
  await nameContact(phil, 1, 'Ada');

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  // Two people at different roles — the page is about who can do what.
  await share(phil, sam, samGroup, docId, 'edit');
  await share(phil, ada, adaGroup, docId, 'read');
  await sam.page.goto(`/#/d/${docId}`);
  await ada.page.goto(`/#/d/${docId}`);

  await phil.page.goto(`/#/d/${docId}/share`);
  // The list is *other* members — you are not a row in your own share list.
  await expect(phil.page.getByTestId('member-row')).toHaveCount(2, { timeout: 60_000 });
  await expect(phil.page.getByTestId('member-row').filter({ hasText: 'Sam' })).toBeVisible();
  await beat(phil.page, 1200);
  await still(phil.page, 'sharing.png');
  await Promise.all([phil.close(), sam.close(), ada.close()]);
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
    const title = page.getByTestId('doc-title-input');
    await expect(title).toBeVisible({ timeout: 30_000 });
    await beat(page, 600);

    await tapAndReplace(page, title, 'Camping trip');
    await title.press('Enter');
    await beat(page, 700);

    await tap(page, page.getByRole('button', { name: 'New task' }));
    const taskTitle = page.getByTestId('ted-title');
    await expect(taskTitle).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    await tapAndType(page, taskTitle, 'Book the campsite');
    // Tasks auto-save on blur — no Save button.
    await taskTitle.press('Escape');
    await expect(page.getByTestId('task-row')).toHaveCount(1, { timeout: 30_000 });
  }, { url: '/#/' });

  await toGif('new-doc.gif', clip);
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
  const laptop = await capturePeer(browser, 'laptop', { video: true });
  const phone = await capturePeer(browser, 'phone', { video: true });
  await setDisplayName(laptop.page, 'Phil');
  // The point of linking is that the new device inherits the user's documents,
  // so the first device needs a library worth inheriting.
  await seedExamples(laptop.page);

  const clips = await takePair(
    laptop,
    phone,
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

      // And the new device shows as Online back on the first one.
      await l.goto('/#/settings/devices');
      await expect(l.getByText(/^Online/).first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 800);
    },
    { leftUrl: '/#/', rightUrl: '/#/' }
  );

  // The longest of the pair clips, and mostly static screens waiting on a
  // handshake — 8fps costs nothing here and keeps it near the others in size.
  await hstackGif('linking-a-device.gif', clips.left, clips.right, { fps: 8 });
  await Promise.all([laptop.close(), phone.close()]);
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

      // Both open the *same* task, so Phil is watching the per-field dots
      // rather than a single row marker.
      const TASK = 'Plan the meals';
      await tap(l, l.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(l.getByTestId('ted-title')).toBeVisible({ timeout: 30_000 });
      await beat(l, 900);

      await tap(r, r.getByRole('button', { name: `Edit ${TASK}` }));
      const title = r.getByTestId('ted-title');
      await expect(title).toBeVisible({ timeout: 30_000 });
      await beat(r, 900);

      // Sam moves between fields; on Phil's side the dot follows, because
      // presence is a path into the document rather than a cursor position.
      // Only the title has a testid — the rest are identified by input type.
      await tap(r, title);
      await beat(r, 500);
      await title.press('End');
      await typeText(r, ' — burgers + salad', 85);
      await beat(l, 1400);

      await tap(r, r.locator('input[type="number"]'));
      await beat(r, 400);
      await r.keyboard.press('ControlOrMeta+a');
      await typeText(r, '2', 120);
      await beat(l, 1400);

      await tap(r, r.locator('textarea'));
      await beat(r, 400);
      await typeText(r, 'Two dinners, one packed lunch.', 70);
      await beat(l, 1600);
    },
    // Both start on Home; the flow navigates them into the document, staggered.
    { leftUrl: '/#/', rightUrl: '/#/' }
  );

  await hstackGif('presence-updates.gif', clips.left, clips.right);
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
      },
    }
  );

  await hstackGif('source-presence.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([phil.close(), sam.close()]);
});

test('permissions.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  await befriend(phil, sam);
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');

  // Deliberately *not* shared: the clip opens with Sam holding no access at all.
  const { docId } = await phil.call('createDoc', SHARED_COUNTERS);

  /** Sam's record buttons exist only at `edit` or `admin`. */
  const recordButtons = (page: Page) => page.locator('[aria-label^="Record completion"]');
  /** The share glyph is on the title bar for admins only; others get a kebab item. */
  const shareGlyph = (page: Page) => page.locator('[aria-label="Share"]');

  /** row → options sheet → role sheet → the role. No confirm() on this path. */
  async function setRole(page: Page, role: 'read' | 'edit' | 'admin'): Promise<void> {
    await tap(page, page.getByTestId('member-row').first());
    await expect(page.getByTestId('member-options-sheet')).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    await tap(page, page.getByTestId('member-change-role'));
    await expect(page.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    // The sheets are portalled to document.body, so the role rows are not inside
    // the member row — scope them to the page.
    await tap(page, page.getByTestId(`role-${role}`));
    await expect(page.getByTestId('member-row').first().getByTestId('member-role'))
      // Rendered lowercase and capitalized in CSS; `changeRole` is a revoke plus
      // a re-add with a key rotation, so give it room.
      .toHaveText(role, { timeout: 60_000 });
  }

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      await beat(l, 1200);

      // Phil grants access. Sam's home page is empty until this lands.
      await tap(l, l.getByRole('button', { name: 'Add people' }));
      await expect(l.getByTestId('add-people-sheet')).toBeVisible({ timeout: 30_000 });
      await beat(l, 600);
      await tap(l, l.getByTestId('add-person-row').first());
      await expect(l.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 30_000 });
      await beat(l, 600);
      await tap(l, l.getByTestId('role-admin'));

      // It shows up on Sam's home page by itself, and he opens it.
      const row = r.getByTestId('doc-row').filter({ hasText: 'Habit Tracker' });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await beat(r, 1200);
      await tap(r, row);
      await expect(recordButtons(r).first()).toBeVisible({ timeout: 60_000 });
      await expect(shareGlyph(r)).toBeVisible({ timeout: 30_000 });
      await beat(r, 1600);

      // Down to edit: Sam keeps the record buttons, but the share affordance goes.
      await setRole(l, 'edit');
      await expect(shareGlyph(r)).toHaveCount(0, { timeout: 60_000 });
      await expect(recordButtons(r).first()).toBeVisible();
      await beat(r, 1800);

      // Down to read: every write affordance disappears from Sam's screen — the
      // buttons are not disabled, they are simply not rendered.
      await setRole(l, 'read');
      await expect(recordButtons(r)).toHaveCount(0, { timeout: 60_000 });
      await expect(r.getByRole('button', { name: 'New counter' })).toHaveCount(0);
      await beat(r, 1800);

      // And back up again, each step arriving without a reload.
      await setRole(l, 'edit');
      await expect(recordButtons(r).first()).toBeVisible({ timeout: 60_000 });
      await beat(r, 1600);

      await setRole(l, 'admin');
      await expect(shareGlyph(r)).toBeVisible({ timeout: 60_000 });
      await beat(r, 2000);
    },
    {
      leftUrl: `/#/d/${docId}/share`,
      rightUrl: '/#/',
      settle: async (l, r) => {
        await expect(l.getByRole('button', { name: 'Add people' })).toBeVisible({ timeout: 60_000 });
        await expect(r.getByTestId('doc-row')).toHaveCount(0, { timeout: 30_000 });
      },
    }
  );

  await hstackGif('permissions.gif', clips.left, clips.right, { fps: 8, width: 720 });
  await Promise.all([phil.close(), sam.close()]);
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
