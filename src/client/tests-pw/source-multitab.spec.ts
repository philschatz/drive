import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Same-device multi-tab sync. One browser context = one device identity
 * (tabs share IndexedDB and therefore the keyhive device key / repo peerId),
 * but each tab runs its OWN dedicated worker — live updates must flow
 * worker↔worker. Repro for: "the source editor does not update when the
 * document is updated by another tab".
 *
 * Both the tasks editor and the source editor set document.title from their
 * live doc subscription, so the title is a faithful "subscription reached the
 * UI" signal that needs no tree expansion or selector guesswork.
 */
test.describe('same-device multi-tab updates', () => {
  // KNOWN LIMITATION (fixme = deliberately skipped): same-device tabs never
  // live-sync today. Every tab runs its own worker but shares the device
  // verifying key, so all tabs present the SAME repo peerId: the relay's
  // Map<peerId, socket> lets the newest tab steal the routing (relay.ts), and
  // the keyhive sync protocol compares peers by verifying key alone, so sibling
  // tabs are indistinguishable from self. Presence across own tabs is equally
  // impossible. Changes converge only via shared IndexedDB on reload.
  // Un-fixme once a fix direction lands (per-tab peer suffix / SharedWorker /
  // BroadcastChannel storage merge).
  test.fixme('tasks editor and source editor tabs see an update made in another tab', async ({ browser }) => {
    test.setTimeout(180_000);
    const context: BrowserContext = await browser.newContext();

    const openTab = async (path: string, name: string): Promise<Page> => {
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`[${name}] console.error: ${m.text()}`);
      });
      page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));
      await page.goto(path);
      await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
      await page.evaluate(() =>
        Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
      );
      return page;
    };

    // Tab A creates the doc (worker API — no UI needed on this tab).
    const tabA = await openTab('/', 'tabA');
    const { docId } = await tabA.evaluate(() =>
      (window as any).__drive.createDoc(
        { '@type': 'TaskList', name: 'Multitab', tasks: {} },
        { type: 'TaskList', name: 'Multitab' },
      ),
    );

    // Tab B: tasks editor; Tab C: source editor. Both load the doc (shared IDB).
    const tabB = await openTab(`/#/d/${docId}`, 'tabB');
    const tabC = await openTab(`/#/source/${docId}`, 'tabC');
    await expect(tabB, 'tasks editor loads the doc').toHaveTitle(/Multitab/, { timeout: 30_000 });
    await expect(tabC, 'source editor loads the doc').toHaveTitle(/Multitab/, { timeout: 30_000 });

    // Tab A renames the doc; the other tabs' live subscriptions must see it.
    await tabA.evaluate(
      (d) => (window as any).__drive.updateDoc(d, (doc: any) => { doc.name = 'Renamed by tab A'; }),
      docId,
    );

    await expect(tabB, 'tasks editor sees the rename from tab A').toHaveTitle(/Renamed by tab A/, {
      timeout: 30_000,
    });
    await expect(tabC, 'source editor sees the rename from tab A').toHaveTitle(/Renamed by tab A/, {
      timeout: 30_000,
    });

    await context.close();
  });
});
