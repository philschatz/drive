import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Sentences selection behaviour that only a real browser expresses: native mouse
 * drags, shift-arrow extension, and where a click actually leaves the caret.
 *
 * Every test here shares one hazard. Moving the caret mints Automerge cursor
 * tokens; registering them makes the worker re-push the subscription (that push
 * is how peer carets arrive), and the push re-runs the editor's caret-restore
 * effect. So a *background round trip* lands a beat after any selection change —
 * including in the middle of a mouse drag — and what the restore does to the
 * selection at that moment is the whole subject of these tests. Hence the
 * deliberate waits: without them the assertions run before the push and pass
 * regardless.
 *
 * The pure offset arithmetic is covered in blocks.test.ts / edit-ops.test.ts, and
 * the restore's skip-if-unchanged contract in RichTextEditor.test.tsx.
 */
// Not `serial`: each test seeds its own document, so one failure must not skip
// the rest (they cover different bugs). The global config already pins one
// worker, so they still share the one page in order.
test.describe.configure({ mode: 'default' });

let app: App;

const editor = () => app.page.getByTestId('rt-editor');

/** Long enough for mint → subscribe-cursors → spans push to land. */
const ROUND_TRIP_MS = 900;

/** Replace the document with `md`, through the app's own Markdown import. */
async function seed(md: string, expected: string): Promise<void> {
  await app.page.setInputFiles('[data-testid="import-md-input"]', {
    name: 'seed.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md),
  });
  await expect(editor()).toContainText(expected);
  // Holding the edit role opens the document editable, bar and all.
  await expect(app.page.getByTestId('format-bar')).toBeVisible();
}

/** Which block the caret sits in, by its `data-bi`. */
function caretBlockIndex(): Promise<string | null> {
  return app.page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    return (el?.closest('[data-bi]') as HTMLElement | null)?.dataset.bi ?? null;
  });
}

const selectedText = () => app.page.evaluate(() => window.getSelection()?.toString() ?? '');

test.beforeAll(async ({ browser }) => {
  app = await openApp(browser, 'sentences-selection');
  await createDocViaUI(app, 'Sentences', 'Selection Doc');
});

test.afterAll(async () => {
  app.assertNoFatalErrors();
  await app.close();
});

test('a caret at the end of a paragraph stays there', async () => {
  await seed('alpha\n\nbeta\n\ngamma', 'gamma');
  await editor().locator('p', { hasText: 'alpha' }).click();
  await app.page.keyboard.press('End');
  await app.page.waitForTimeout(ROUND_TRIP_MS);

  // That offset is also the next paragraph's block marker, so the restore used to
  // resolve it to the following block and drop the caret in front of "beta".
  expect(await caretBlockIndex()).toBe('0');
  await app.page.keyboard.type('!');
  await expect(editor().locator('p').nth(0)).toHaveText('alpha!');
  await expect(editor().locator('p').nth(1)).toHaveText('beta');
});

test('an empty paragraph holds the caret instead of cascading past it', async () => {
  await seed('alpha\n\nbeta\n\ngamma', 'gamma');
  await editor().locator('p', { hasText: 'alpha' }).click();
  await app.page.keyboard.press('End');
  // Enter opens an empty paragraph and leaves the caret in it. An empty block's
  // only offset is ALSO the next block's marker, which is what made the caret
  // walk on through every blank line until it reached text.
  await app.page.keyboard.press('Enter');
  await app.page.waitForTimeout(ROUND_TRIP_MS);
  expect(await caretBlockIndex()).toBe('1');

  await app.page.keyboard.type('mid');
  await expect(editor().locator('p').nth(1)).toHaveText('mid');
  await expect(editor().locator('p').nth(2)).toHaveText('beta');
});

test('Shift+ArrowLeft keeps extending across a cursor round trip', async () => {
  await seed('alpha beta gamma', 'gamma');
  await editor().locator('p').first().click();
  await app.page.keyboard.press('End');

  await app.page.keyboard.press('Shift+ArrowLeft');
  // Restoring this backward selection as a forward one moves the anchor to the
  // other end, so the next two presses shrink it instead of extending it.
  await app.page.waitForTimeout(ROUND_TRIP_MS);
  await app.page.keyboard.press('Shift+ArrowLeft');
  await app.page.keyboard.press('Shift+ArrowLeft');

  expect(await selectedText()).toBe('mma');
});

test('dragging a selection upward keeps growing the highlight', async () => {
  await seed('alpha\n\nbeta\n\ngamma', 'gamma');
  // Collapse whatever the previous test left selected: a mousedown that lands
  // inside an existing selection starts a drag-and-drop, not a new selection.
  await editor().locator('p').nth(1).click();
  const first = (await editor().locator('p').nth(0).boundingBox())!;
  const last = (await editor().locator('p').nth(2).boundingBox())!;

  // From the end of the last paragraph up to the start of the first. Every step
  // moves earlier in document order, so the selection can only grow — unless a
  // mid-drag restore resets the browser's drag anchor, which is what collapsed
  // the highlight on the way up while downward drags looked fine.
  const from = { x: last.x + last.width - 2, y: last.y + last.height / 2 };
  const to = { x: first.x + 2, y: first.y + first.height / 2 };
  await app.page.mouse.move(from.x, from.y);
  await app.page.mouse.down();

  const lengths: number[] = [];
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await app.page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await app.page.waitForTimeout(200); // let a push land mid-drag
    lengths.push((await selectedText()).length);
  }
  await app.page.mouse.up();

  for (let i = 1; i < lengths.length; i++) {
    expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
  }
  const text = await selectedText();
  expect(text).toContain('gamma');
  expect(text).toContain('alpha');
});

test('Enter at the end of a list item followed by a paragraph makes another item', async () => {
  await seed('- alpha\n\ntail', 'tail');
  await editor().locator('.rt-li').click();
  await app.page.keyboard.press('End');
  await app.page.waitForTimeout(ROUND_TRIP_MS);

  // The new block continues the type of the block being split. Resolving the
  // item's end offset to the FOLLOWING block made Enter produce a paragraph and
  // then leave the caret in "tail".
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.type('beta');

  const items = editor().locator('.rt-li');
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText('beta');
  await expect(editor().locator('p')).toHaveText('tail');
});
