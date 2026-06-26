import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Task-list editor UI test (ported from cypress/e2e/tasks.cy.ts). One shared
 * page across the suite — config runs workers:1, fullyParallel:false — and a
 * single consolidated test to keep Chromium renderer memory in check.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Tasks', () => {
  let app: App;

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'tasks');
    await createDocViaUI(app, 'Task list', 'Test Tasks');
    await expect(app.page.locator('[placeholder="Add a task..."]')).toBeVisible({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  test('task list CRUD', async () => {
    const page = app.page;
    const input = page.locator('[placeholder="Add a task..."]');

    // Quick-add a task via the Add button. Assert the controlled input has
    // committed its value before clicking, so the add never fires on stale state
    // (matters under the slower instrumented coverage build).
    await input.fill('Buy milk');
    await expect(input).toHaveValue('Buy milk');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('span', { hasText: 'Buy milk' })).toBeVisible();

    // Add a second task via Enter
    await input.fill('Walk the dog');
    await expect(input).toHaveValue('Walk the dog');
    await input.press('Enter');
    await expect(page.locator('span', { hasText: 'Walk the dog' })).toBeVisible();

    // Toggle completion via the checkbox -> strikethrough (opacity 0.5)
    const buyMilk = page.locator('span', { hasText: 'Buy milk' }).first();
    await buyMilk.locator('xpath=..').getByRole('checkbox').click();
    await expect(buyMilk).toHaveCSS('opacity', '0.5');

    // Open the editor sheet by clicking the task title
    await page.locator('span', { hasText: 'Walk the dog' }).first().click();
    await expect(page.getByText('Edit Task')).toBeVisible();

    // Edit the title in the sheet and save
    const titleInput = page.locator('label', { hasText: 'Title' }).locator('xpath=..').locator('input');
    await titleInput.fill('Walk the dog in the park');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('span', { hasText: 'Walk the dog in the park' })).toBeVisible();

    // Delete completed tasks
    await page.getByRole('button', { name: 'Delete Completed' }).click();
    await expect(page.locator('span', { hasText: 'Buy milk' })).toHaveCount(0);
    await expect(page.locator('span', { hasText: 'Walk the dog in the park' })).toBeVisible();
  });
});
