import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, openProperty, saveProperty, cancelProperty, mdFieldTid, type App } from './support';

/**
 * The task editor's transactional panes, in a real browser.
 *
 * Playwright rather than jsdom for one reason: `MdTextField` renders a
 * `md-outlined-text-field` whose real `<input>` lives in a shadow root that Lit
 * populates *asynchronously*. Under jsdom the md elements never upgrade at all, so
 * the focus behaviour these tests pin down simply doesn't exist there.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Task editor', () => {
  let app: App;

  /** activeElement, described well enough to tell a field from the body. */
  const activeDesc = (app: App) =>
    app.page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return 'null';
      const id = a.getAttribute('data-testid');
      return a.tagName.toLowerCase() + (id ? `[${id}]` : '');
    });

  test.beforeAll(async ({ browser }) => {
    app = await openApp(browser, 'task-editor');
    await createDocViaUI(app, 'Task list', 'Editor tests');

    // One task to edit, added through the FAB sheet (which opens in the title
    // pane, where Enter is Save and chains to a fresh blank task).
    await app.page.locator('md-fab').click();
    await expect(app.page.getByTestId('ted-title')).toBeVisible({ timeout: 15_000 });
    await mdFieldTid(app.page, 'ted-title').fill('Plan the meals');
    await app.page.getByTestId('ted-title-save').click();
    await app.page.getByRole('button', { name: 'Close' }).click();
    await expect(app.page.getByText('Plan the meals')).toBeVisible();
  });

  test.afterAll(async () => {
    app.assertNoFatalErrors();
    await app.close();
  });

  const openEditor = async () => {
    await app.page.getByRole('button', { name: /^Edit / }).click();
    await expect(app.page.getByTestId('ted-title-row')).toBeVisible({ timeout: 15_000 });
  };

  test('a detail pane focuses its field, so typing lands in it', async () => {
    const page = app.page;
    await openEditor();

    // Lit renders the shadow <input> a microtask after the pane mounts, so a
    // focus() in the same layout pass has nothing to delegate to. Regression
    // guard: without the updateComplete retry, activeElement stays on <body>
    // and every keystroke goes to the document — which is how a capture ends up
    // select-all'ing the page on Ctrl+A instead of clearing the field.
    for (const row of ['ted-title', 'ted-due', 'ted-priority', 'ted-desc']) {
      await openProperty(page, row);
      await expect
        .poll(() => activeDesc(app), { timeout: 5_000, message: `${row} pane focuses its field` })
        .toBe(`md-outlined-text-field[${row}]`);
      await cancelProperty(page, row);
    }

    // And with the field focused, bare keyboard input reaches it.
    await openProperty(page, 'ted-priority');
    await expect.poll(() => activeDesc(app), { timeout: 5_000 }).toBe('md-outlined-text-field[ted-priority]');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('3');
    await expect(mdFieldTid(app.page, 'ted-priority')).toHaveValue('3');
    // Nothing outside the field got selected.
    expect(await page.evaluate(() => String(window.getSelection() ?? ''))).toBe('');
    await cancelProperty(page, 'ted-priority');
  });

  test('Save commits, Cancel discards, and neither is a blur', async () => {
    const page = app.page;

    // Cancel: the summary row keeps the old value and the pane pops back.
    await openProperty(page, 'ted-priority');
    await mdFieldTid(app.page, 'ted-priority').fill('7');
    await cancelProperty(page, 'ted-priority');
    await expect(page.getByTestId('ted-priority-row')).toContainText('Add priority');

    // Save: the summary row updates.
    await openProperty(page, 'ted-priority');
    await mdFieldTid(app.page, 'ted-priority').fill('2');
    await saveProperty(page, 'ted-priority');
    await expect(page.getByTestId('ted-priority-row')).toContainText('2');

    // Blurring a transactional field must NOT commit — that is the whole point.
    await openProperty(page, 'ted-desc');
    await mdFieldTid(app.page, 'ted-desc').fill('Two dinners, one packed lunch.');
    await page.getByTestId('ted-desc-row').isVisible().catch(() => {});
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await cancelProperty(page, 'ted-desc');
    await expect(page.getByTestId('ted-desc-row')).toContainText('Add description');

    // …and a transactional pane has no Back arrow; Cancel is the way out.
    await openProperty(page, 'ted-title');
    await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0);
    await cancelProperty(page, 'ted-title');
    await page.getByRole('button', { name: 'Close' }).click();
  });
});
