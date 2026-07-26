import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Sentences (word-processing) editor — real-browser coverage for what jsdom can't
 * do: genuine contenteditable typing (beforeinput), Selection-driven toolbar
 * formatting, keyboard shortcuts, and worker/IndexedDB persistence across a
 * reload. The pure editing logic (ops, markdown, spans) is Jest-covered.
 *
 * Tests are serial and build up one document.
 */
test.describe.configure({ mode: 'serial' });

let app: App;

const editor = () => app.page.getByTestId('rt-editor');

/** Select [start, end) inside the first inline run whose text contains `text`. */
async function selectIn(text: string, start: number, end: number): Promise<void> {
  await app.page.evaluate(({ text, start, end }) => {
    const runs = Array.from(document.querySelectorAll('.rt-editor [data-from]'));
    const el = runs.find(r => (r.textContent ?? '').includes(text));
    if (!el || !el.firstChild) throw new Error(`run containing "${text}" not found`);
    const base = (el.textContent ?? '').indexOf(text);
    const range = document.createRange();
    range.setStart(el.firstChild, base + start);
    range.setEnd(el.firstChild, base + end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, { text, start, end });
}

test.beforeAll(async ({ browser }) => {
  app = await openApp(browser, 'document');
  await createDocViaUI(app, 'Sentences', 'Living Doc');
});

test.afterAll(async () => {
  app.assertNoFatalErrors();
  await app.close();
});

test('opens in view mode; the FAB enters edit mode', async () => {
  await expect(editor()).toBeVisible();
  await expect(editor()).not.toHaveAttribute('contenteditable', 'true');
  await expect(app.page.getByTestId('format-bar')).toHaveCount(0);

  await app.page.getByLabel('Edit sentences').click();
  await expect(app.page.getByTestId('format-bar')).toBeVisible();
  await expect(editor()).toHaveAttribute('contenteditable', 'true');
});

test('typing inserts text through beforeinput', async () => {
  await editor().click();
  await app.page.keyboard.type('Hello world');
  await expect(editor()).toContainText('Hello world');
});

test('bold via toolbar button and italic via Ctrl+I', async () => {
  await selectIn('Hello world', 0, 5); // "Hello"
  await app.page.getByTestId('fmt-format_bold').click();
  await expect(editor().locator('.rt-strong')).toHaveText('Hello');

  await selectIn('world', 0, 5);
  await app.page.keyboard.press('ControlOrMeta+i');
  await expect(editor().locator('.rt-em')).toHaveText('world');
});

test('heading via the text-style sheet', async () => {
  await selectIn('Hello', 1, 1);
  await app.page.getByTestId('fmt-notes').click();
  await app.page.locator('md-list-item', { hasText: 'Heading 1' }).click();
  await expect(editor().locator('h1')).toContainText('Hello world');
});

test('Enter starts a paragraph after a heading; lists nest with Tab', async () => {
  // Caret to the end of the heading, then a new block.
  await selectIn('world', 5, 5);
  await app.page.keyboard.press('End');
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.type('first');
  await expect(editor().locator('p')).toContainText('first');

  await app.page.getByTestId('fmt-format_list_bulleted').click();
  await expect(editor().locator('.rt-li')).toContainText('first');

  // Enter continues the list; Tab nests the new item.
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.type('second');
  await app.page.keyboard.press('Tab');
  const items = editor().locator('.rt-li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText('second');
  // Nested item is indented further than its parent.
  const [p0, p1] = await Promise.all([
    items.nth(0).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft)),
    items.nth(1).evaluate(el => parseFloat(getComputedStyle(el).paddingLeft)),
  ]);
  expect(p1).toBeGreaterThan(p0);

  // Enter twice on the empty next item exits the list back to a paragraph.
  await app.page.keyboard.press('End');
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.type('after the list');
  await expect(editor().locator('p', { hasText: 'after the list' })).toBeVisible();
});

test('links apply to the selection and render as anchors', async () => {
  await selectIn('after the list', 0, 5); // "after"
  await app.page.getByTestId('fmt-link').click();
  await app.page.getByTestId('link-input').fill('https://example.com/docs');
  await app.page.getByRole('button', { name: 'Apply' }).click();
  const anchor = editor().locator('a.rt-link');
  await expect(anchor).toHaveText('after');
  await expect(anchor).toHaveAttribute('href', 'https://example.com/docs');
});

test('divider inserts and undo (Ctrl+Z) restores', async () => {
  await editor().locator('p', { hasText: 'the list' }).click();
  await app.page.keyboard.press('End');
  await app.page.getByTestId('fmt-horizontal_rule').click();
  await expect(editor().locator('.rt-divider hr')).toBeVisible();

  await app.page.keyboard.type('tail');
  await expect(editor()).toContainText('tail');
  await app.page.keyboard.press('ControlOrMeta+z');
  await expect(editor()).not.toContainText('tail');
});

test('Done returns to the viewer; content survives a reload', async () => {
  await app.page.getByLabel('Done').click();
  await expect(app.page.getByTestId('format-bar')).toHaveCount(0);
  await expect(editor()).not.toHaveAttribute('contenteditable', 'true');
  // View mode keeps real links.
  await expect(editor().locator('a.rt-link')).toHaveAttribute('href', 'https://example.com/docs');

  await app.page.reload();
  await app.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await expect(editor().locator('h1')).toContainText('Hello world', { timeout: 30_000 });
  await expect(editor().locator('.rt-li')).toHaveCount(2);
  await expect(editor().locator('.rt-divider hr')).toBeVisible();
  await expect(editor()).not.toHaveAttribute('contenteditable', 'true');
});

test('double-clicking the viewed text starts editing at that word', async () => {
  // (Still in view mode after the reload test.)
  await editor().locator('h1').dblclick();
  await expect(app.page.getByTestId('format-bar')).toBeVisible();
  await expect(editor()).toHaveAttribute('contenteditable', 'true');
  // The double-clicked word is selected, so typing replaces it in place.
  await app.page.keyboard.type('Howdy');
  await expect(editor().locator('h1')).toContainText('Howdy');

  await app.page.getByLabel('Done').click();
  await expect(app.page.getByTestId('format-bar')).toHaveCount(0);
});

test('imports a Markdown file, replacing the content', async () => {
  // The confirm() dialog is auto-accepted by the openApp handler.
  await app.page.setInputFiles('[data-testid="import-md-input"]', {
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Fresh start\n\nImported **body**\n\n1. alpha\n2. beta'),
  });
  await expect(editor().locator('h1')).toHaveText('Fresh start');
  await expect(editor().locator('.rt-strong')).toHaveText('body');
  await expect(editor().locator('.rt-li')).toHaveCount(2);
  await expect(editor()).not.toContainText('Hello world');
});
