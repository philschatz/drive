import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Regression + feature coverage for the aggregate "All Calendars" view:
 *  - it must discover a calendar the user owns (two prior bugs hid every one:
 *    calendarQuery dropped `@type`, and the worker's one-shot query returned the
 *    raw jq output-stream array instead of the first result);
 *  - it also renders "Calendar+Counters" (Habit Tracker) docs;
 *  - Home only shows the "All calendars" button with 2+ calendar-ish docs.
 */
test.describe('AllCalendars discovery', () => {
  let app: App;

  test.afterAll(async () => {
    await app?.close();
  });

  // "All calendars" now lives in the Home top-bar overflow menu (aria-label
  // "Menu"); the menu item only renders with 2+ calendar-ish docs.
  const allCalItem = (app: App) => app.page.locator('md-menu-item', { hasText: 'All calendars' });

  test('renders calendars + counters, and gates the Home menu item on 2+', async ({ browser }) => {
    app = await openApp(browser, 'all-cal');
    const page = app.page;

    // One calendar → the menu item isn't rendered at all.
    await createDocViaUI(app, 'Calendar', 'Repro Cal');
    await expect(page).toHaveURL(/#\/d\//, { timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '#/'; });
    await expect(page.getByText('Repro Cal')).toBeVisible({ timeout: 15_000 });
    await expect(allCalItem(app)).toHaveCount(0);

    // Add a Counters (Habit Tracker) doc → two calendar-ish docs → item appears.
    await createDocViaUI(app, 'Habit Tracker', 'Repro Habits');
    await expect(page).toHaveURL(/#\/d\//, { timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '#/'; });
    await expect(allCalItem(app)).toHaveCount(1, { timeout: 15_000 });

    // The aggregate view discovers both and renders without "No calendars found".
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(allCalItem(app)).toBeVisible();
    await allCalItem(app).click();
    await expect(page).toHaveURL(/#\/calendars\//, { timeout: 15_000 });
    await expect(page.locator('#sx-cal > *').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No calendars found')).toHaveCount(0);
  });
});
