import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * The home page's "new changes since last viewed" dot.
 *
 * Viewing is inferred from non-peek query subscriptions (the editor route);
 * the home page's summary queries are peek and must neither set nor clear the
 * dot. The mutation below deliberately does NOT change the home summary
 * projection (a completed task is excluded from taskCount), proving the dot
 * rides the worker's dedicated unseen-changes push rather than the query-result
 * path, which skips posting when the jq result is unchanged.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Unseen-changes dot', () => {
  let app: App;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'unseen-dot');
    await createDocViaUI(app, 'Task list', 'Unseen Dot');
    docId = new URL(app.page.url()).hash.replace(/^#\/d\//, '').replace(/\/.*$/, '');
    expect(docId).not.toEqual('');
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('dot appears on unviewed changes and clears on view', async () => {
    const page = app.page;
    const dot = page.locator('[data-testid="unseen-dot"]');

    // Created + viewed in the editor → no dot on the home list.
    await page.evaluate(() => { location.hash = '#/'; });
    await expect(page.locator('a', { hasText: 'Unseen Dot' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(dot).toHaveCount(0);

    // Mutate while only the home page (peek) is watching, with a change that is
    // INVISIBLE to the summary query: completed tasks don't count toward
    // taskCount, so the summary jq result is unchanged and the old query-result
    // path would never have told the home page.
    await page.evaluate(
      (id) => (window as any).__drive.updateDoc(id, (d: any) => {
        d.tasks['pw-unseen'] = { '@type': 'Task', title: 'invisible to summary', progress: 'completed' };
      }),
      docId
    );
    await expect(dot).toBeVisible({ timeout: 10_000 });

    // Opening the doc (non-peek editor subscriptions) marks it viewed.
    await page.locator('a', { hasText: 'Unseen Dot' }).first().click();
    await expect(page).toHaveURL(/#\/d\//, { timeout: 15_000 });
    await expect(page.locator('[placeholder="Add a task..."]')).toBeVisible({ timeout: 10_000 });

    // Back home: the dot is gone.
    await page.evaluate(() => { location.hash = '#/'; });
    await expect(page.locator('a', { hasText: 'Unseen Dot' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(dot).toHaveCount(0);
  });
});
