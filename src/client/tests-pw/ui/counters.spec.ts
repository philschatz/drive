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
    await expect(app.page.locator('[placeholder="Add a todo/counter..."]')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('counter list: add, click to record, sections, chart', async () => {
    const page = app.page;
    const input = page.locator('[placeholder="Add a todo/counter..."]');
    // Pick a repeat option in the quick-add dropdown (the first combobox on the page).
    const pickRepeat = async (name: string) => {
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name, exact: true }).click();
    };

    // The met/missed chart renders even when empty.
    await expect(page.locator('svg[aria-label="Met vs missed occurrences per week"]')).toBeVisible();

    // Quick-add with "Daily" selected creates a habit expected today -> "To do".
    await input.fill('Stretch');
    await expect(input).toHaveValue('Stretch');
    await pickRepeat('Daily');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const row = page.locator('[data-testid="counter-list"] div', { hasText: 'Stretch' }).first();
    await expect(row).toBeVisible();
    await expect(page.getByRole('heading', { name: 'To do' })).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'pending');

    // Clicking the icon+title records a completion: it moves to "Done" with a 1× badge.
    await row.getByText('Stretch').click();
    await expect(row).toHaveAttribute('data-status', 'done');
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
    await expect(row.getByText('1×')).toBeVisible();

    // Clicking the rest of the row (here the 1× badge) opens the editor, not a
    // completion. Cancel to leave serial state untouched.
    await row.getByText('1×').click();
    await expect(page.getByText('Edit Counter')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Edit Counter')).toBeHidden();
    await expect(row.getByText('1×')).toBeVisible();

    // "No repeat" makes a schedule-less tally where every click counts.
    await pickRepeat('No repeat');
    await input.fill('Pushups');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const tally = page.locator('[data-testid="counter-list"] div', { hasText: 'Pushups' }).first();
    await expect(tally).toHaveAttribute('data-status', 'tally');
    await expect(page.getByRole('heading', { name: 'No schedule' })).toBeVisible();
    await tally.getByText('Pushups').click();
    await tally.getByText('Pushups').click();
    await expect(tally.getByText('2×')).toBeVisible();

    // "Other…" opens the editor pre-filled; saving creates the item and returns
    // focus to the quick-add input so another can be added immediately.
    const titleInput = page.locator('label', { hasText: 'Title' }).locator('xpath=..').locator('input');
    await pickRepeat('Other…');
    await input.fill('Meditate');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('New Counter')).toBeVisible();
    await expect(titleInput).toHaveValue('Meditate');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-testid="counter-list"]').getByText('Meditate')).toBeVisible();
    await expect(input).toBeFocused();

    // Edit via the pencil: retitle and save.
    await tally.getByRole('button', { name: 'Edit counter' }).click();
    await expect(page.getByText('Edit Counter')).toBeVisible();
    await titleInput.fill('Daily pushups');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-testid="counter-list"]').getByText('Daily pushups')).toBeVisible();

    // Archive the recurring "Stretch" habit: it leaves the active list and shows
    // under "Archived"; unarchiving brings it back as pending.
    const stretchRow = page.locator('[data-testid="counter-list"] div[data-status]', { hasText: 'Stretch' }).first();
    await stretchRow.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByRole('heading', { name: 'Archived' })).toBeVisible();
    await expect(page.locator('[data-testid="counter-list"] div[data-status]', { hasText: 'Stretch' })).toHaveCount(0);
    const archivedStretch = page.locator('[data-testid="counter-list"] div', { hasText: 'Stretch' }).last();
    await archivedStretch.getByRole('button', { name: 'Unarchive' }).click();
    await expect(page.getByRole('heading', { name: 'Archived' })).toHaveCount(0);
    await expect(page.locator('[data-testid="counter-list"] div[data-status]', { hasText: 'Stretch' })).toHaveCount(1);
  });
});
