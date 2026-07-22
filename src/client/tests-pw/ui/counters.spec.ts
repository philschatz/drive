import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/** Calendar+Counters editor UI test. Same single-page serial pattern as
 * tasks.spec.ts to keep Chromium renderer memory in check. */
test.describe.configure({ mode: 'serial' });

test.describe('Counters', () => {
  let app: App;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'counters');
    await createDocViaUI(app, 'Habit Tracker', 'Test Counters');
    await expect(app.page.locator('[placeholder="Add a daily counter..."]')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('counter list: add, click to record, sections, chart', async () => {
    const page = app.page;
    const input = page.locator('[placeholder="Add a daily counter..."]');

    // The met/missed chart renders even when empty.
    await expect(page.locator('svg[aria-label="Met vs missed occurrences per week"]')).toBeVisible();

    // Quick-add creates a daily counter that is expected today -> "To do".
    await input.fill('Stretch');
    await expect(input).toHaveValue('Stretch');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const row = page.locator('[data-testid="counter-list"] div', { hasText: 'Stretch' }).first();
    await expect(row).toBeVisible();
    await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'pending');

    // Clicking the row records a completion: it moves to "Done" with a 1× badge.
    await row.click();
    await expect(row).toHaveAttribute('data-status', 'done');
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
    await expect(row.getByText('1×')).toBeVisible();

    // A counter without a schedule lands in "No schedule" and every click counts.
    await page.getByRole('button', { name: 'New…' }).click();
    await expect(page.getByText('New Counter')).toBeVisible();
    const titleInput = page.locator('label', { hasText: 'Title' }).locator('xpath=..').locator('input');
    await titleInput.fill('Pushups');
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'No repeat' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    const tally = page.locator('[data-testid="counter-list"] div', { hasText: 'Pushups' }).first();
    await expect(tally).toHaveAttribute('data-status', 'tally');
    await expect(page.getByRole('heading', { name: 'No schedule' })).toBeVisible();
    await tally.click();
    await tally.click();
    await expect(tally.getByText('2×')).toBeVisible();

    // Edit via the pencil: retitle and save.
    await tally.getByRole('button', { name: 'Edit counter' }).click();
    await expect(page.getByText('Edit Counter')).toBeVisible();
    await titleInput.fill('Daily pushups');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-testid="counter-list"]').getByText('Daily pushups')).toBeVisible();
  });
});
