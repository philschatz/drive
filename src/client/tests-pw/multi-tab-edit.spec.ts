import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { setupFriendPair, shareNewDoc, type FriendPair } from './support/scenarios';
import { waitFor } from './support/peer';
import { openApp, createDocViaUI, type App } from './ui/support';

/**
 * Several tabs of one device sharing a single engine.
 *
 * Two same-origin tabs in ONE browser context share Web Locks and IndexedDB (unlike
 * the isolated per-`newPeer` contexts), so the second tab loses the leadership lock
 * and routes its worker protocol through the first over a BroadcastChannel. This is
 * the one thing jsdom cannot check: it needs two real pages, two real Web Locks, and
 * the follower's requests crossing a real bus into the leader's real Worker.
 *
 * `tests/tab-router.test.ts` covers the routing rules in isolation. What is asserted
 * here is the end-to-end consequence: a follower tab is a fully working editor.
 */

/** Wait for a page's bridge and its worker+keyhive gates. A follower's gates only
 *  settle once the leader replays them, so this doubles as the handshake assertion. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await page.evaluate(() =>
    Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
  );
}

const call = (page: Page, fn: string, ...args: any[]) =>
  page.evaluate(
    ({ fn, args }) => Promise.resolve((window as any).__drive[fn](...args)),
    { fn, args },
  );

const readName = (page: Page, docId: string) =>
  call(page, 'queryDoc', docId, '.name').then((r: any) => r?.result).catch(() => null);

/** Rename a doc. `updateDoc`'s callback is serialized into the worker, so it takes
 *  no closure — the new name rides along as an argument. */
const setName = (page: Page, docId: string, name: string) =>
  page.evaluate(
    ({ docId, name }) =>
      (window as any).__drive.updateDoc(docId, (d: any, n: string) => { d.name = n; }, name),
    { docId, name },
  );

test.describe('multiple tabs, one engine', () => {
  test('a follower tab reads and writes the same document as the leader', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const leader = await ctx.newPage();
      await leader.goto('/');
      await ready(leader);

      // Second tab: the lock is taken, so this one has no Worker of its own. Its
      // readiness proves the leader answered its `hello` and replayed the gates.
      const follower = await ctx.newPage();
      await follower.goto('/');
      await ready(follower);

      // The banner this spec replaced is gone — extra tabs are supported now.
      await expect(follower.locator('[data-testid="multi-tab-banner"]')).toHaveCount(0);

      const { docId } = await call(leader, 'createDoc', {
        '@type': 'TaskList', name: 'Shared across tabs', tasks: {},
      }) as { docId: string };

      // The follower sees a doc the leader created — one engine, one doc list.
      await waitFor(() => readName(follower, docId), (n) => n === 'Shared across tabs',
        { label: 'follower reads the doc', timeout: 30_000 });

      // …and its writes land in that same engine, visible from the leader tab.
      await setName(follower, docId, 'Renamed by the follower');
      await waitFor(() => readName(leader, docId), (n) => n === 'Renamed by the follower',
        { label: 'leader sees the follower edit', timeout: 30_000 });
    } finally {
      await ctx.close();
    }
  });

  test('a live query in each tab gets its own results', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const leader = await ctx.newPage();
      await leader.goto('/');
      await ready(leader);
      const follower = await ctx.newPage();
      await follower.goto('/');
      await ready(follower);

      const { docId } = await call(leader, 'createDoc', {
        '@type': 'TaskList', name: 'Subscriptions', tasks: {},
      }) as { docId: string };

      // Both tabs subscribe. Their subIds both start at 1, so a router that didn't
      // namespace them would cross-deliver or drop one side entirely.
      const watch = (page: Page) => page.evaluate((d) => {
        (window as any).__seen = [];
        (window as any).__drive.subscribeQuery(d, '.name', (r: any) => (window as any).__seen.push(r));
      }, docId);
      await watch(leader);
      await watch(follower);

      await setName(follower, docId, 'Pushed to both');

      for (const [label, page] of [['leader', leader], ['follower', follower]] as const) {
        await waitFor(
          () => page.evaluate(() => (window as any).__seen as string[]),
          (seen) => seen.includes('Pushed to both'),
          { label: `${label} query result`, timeout: 30_000 },
        );
      }
    } finally {
      await ctx.close();
    }
  });

  test('closing the leader tab leaves the survivor working', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      const leader = await ctx.newPage();
      await leader.goto('/');
      await ready(leader);
      const follower = await ctx.newPage();
      await follower.goto('/');
      await ready(follower);

      const { docId } = await call(leader, 'createDoc', {
        '@type': 'TaskList', name: 'Survives handover', tasks: {},
      }) as { docId: string };
      await waitFor(() => readName(follower, docId), (n) => n === 'Survives handover',
        { label: 'follower reads before handover', timeout: 30_000 });

      // The leader's Worker dies with its tab and the lock releases. The survivor is
      // promoted, and reloads because its subscriptions lived in the dead router.
      await leader.close();

      // Reloading detaches the bridge, so wait for the new page's own boot.
      await follower.waitForFunction(() => !(window as any).__drive, undefined, { timeout: 30_000 })
        .catch(() => { /* the reload may already have completed */ });
      await ready(follower);

      // It now owns the engine: reads the existing doc and can still write.
      await waitFor(() => readName(follower, docId), (n) => n === 'Survives handover',
        { label: 'survivor reads after handover', timeout: 45_000 });
      await setName(follower, docId, 'Written by the survivor');
      await waitFor(() => readName(follower, docId), (n) => n === 'Written by the survivor',
        { label: 'survivor writes after handover', timeout: 30_000 });
    } finally {
      await ctx.close();
    }
  });

  test('a follower tab\'s edit reaches a remote peer', async ({ browser }) => {
    // The relay socket belongs to the leader tab. This is what proves a follower's
    // writes actually leave the device rather than just landing in local storage.
    let pair: FriendPair | null = null;
    let secondTab: Page | null = null;
    try {
      pair = await setupFriendPair(browser);
      const { alice, bob } = pair;

      // Via shareNewDoc rather than hand-rolled: this used to inline the same
      // create/addMember/await-access sequence, which meant it also inlined the
      // passive wait for bob's access — and so kept the flake that helper has
      // since been taught to recover from (see its relay-rejoin comment).
      const docId = await shareNewDoc(pair, 'edit', {
        '@type': 'TaskList', name: 'From a second tab', tasks: {},
      });

      // A second tab in ALICE's context — same device, same identity, no Worker.
      secondTab = await alice.context.newPage();
      await secondTab.goto('/');
      await ready(secondTab);

      await setName(secondTab, docId, 'Edited in alice tab 2');

      // Bob is a different device: this only converges if the edit went through the
      // leader tab's engine and out over its relay socket.
      await waitFor(
        () => bob.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (n) => n === 'Edited in alice tab 2',
        { label: 'bob receives the follower tab edit', timeout: 60_000 },
      );
    } finally {
      await secondTab?.close().catch(() => {});
      await pair?.alice.close();
      await pair?.bob.close();
    }
  });
});

/**
 * The DataGrid in a follower tab. Its HyperFormula worker used to be handed a
 * MessagePort straight into the engine; a port cannot cross the cross-tab bus, so
 * those reads now proxy through the main thread. A formula evaluating here is the
 * only end-to-end check of that path (the DataGrid cannot mount in jsdom — hf-bridge
 * uses import.meta).
 */
test.describe('DataGrid in a follower tab', () => {
  let app: App;
  let follower: Page;
  let ctx: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'multitab-datagrid');
    ctx = app.context;
    await createDocViaUI(app, 'Spreadsheet', 'Follower sheet');
    await expect(app.page.locator('.datagrid-table')).toBeVisible({ timeout: 10_000 });

    // Open the same sheet in a second tab of the same context — the follower.
    const url = app.page.url();
    follower = await ctx.newPage();
    await follower.goto(url);
    await ready(follower);
    await expect(follower.locator('.datagrid-table')).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('evaluates a formula through the proxied query path', async () => {
    const cell = (c: number, r: number) =>
      follower.locator(`[data-cell-col="${c}"][data-cell-row="${r}"]`);
    const editor = follower.locator('.bottom-editor-cm .cm-content');

    const setCell = async (c: number, r: number, text: string) => {
      await cell(c, r).click();
      await editor.click();
      await editor.pressSequentially(text, { delay: 20 });
      await editor.press('Enter');
      await expect(cell(c, r)).toContainText(text);
    };

    await setCell(0, 0, '42');
    await setCell(0, 1, '8');
    // Give the HF worker's subscription a round to see both values.
    await follower.waitForTimeout(500);

    await cell(0, 2).click();
    await editor.click();
    await follower.getByRole('button', { name: 'Insert =' }).click();
    await editor.pressSequentially('A1+A2', { delay: 30 });
    await editor.press('Enter');

    // The computed value proves HF's reads reached the engine in the other tab.
    await expect(cell(0, 2)).toContainText('50', { timeout: 20_000 });
  });
});
