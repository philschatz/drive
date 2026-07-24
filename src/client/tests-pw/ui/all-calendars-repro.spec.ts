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

  const allCalBtn = (app: App) => app.page.getByRole('button', { name: /All calendars/i });

  test('renders calendars + counters, and gates the Home button on 2+', async ({ browser }) => {
    app = await openApp(browser, 'all-cal');
    const page = app.page;

    // One calendar → Home button hidden.
    await createDocViaUI(app, 'Calendar', 'Repro Cal');
    await expect(page).toHaveURL(/#\/d\//, { timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '#/'; });
    await expect(page.getByText('Repro Cal')).toBeVisible({ timeout: 15_000 });
    await expect(allCalBtn(app)).toHaveCount(0);

    // Add a Counters (Habit Tracker) doc → two calendar-ish docs → button appears.
    await createDocViaUI(app, 'Habit Tracker', 'Repro Habits');
    await expect(page).toHaveURL(/#\/d\//, { timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '#/'; });
    await expect(allCalBtn(app)).toBeVisible({ timeout: 15_000 });

    // The aggregate view discovers both and renders without "No calendars found".
    await allCalBtn(app).click();
    await expect(page).toHaveURL(/#\/calendars\//, { timeout: 15_000 });
    await expect(page.locator('#sx-cal > *').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No calendars found')).toHaveCount(0);
  });
});
