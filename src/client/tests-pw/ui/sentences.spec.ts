import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Sentences (word-processing) editor — the parts of it that only a real browser
 * expresses. Everything else moved to Jest: block/run rendering and list
 * indentation to RichTextEditor.test.tsx, toolbar formatting and Markdown import
 * to SentencesView.test.tsx, and the editing logic itself to edit-ops.test.ts /
 * markdown.test.ts / blocks.test.ts. What is left needs a browser for a specific
 * reason, named per test.
 *
 * The document is seeded once through the app's own Markdown import rather than
 * built up across tests, so a failure can't cascade and each test starts from a
 * known document.
 */
test.describe.configure({ mode: 'serial' });

let app: App;

const editor = () => app.page.getByTestId('rt-editor');
const selectedText = () => app.page.evaluate(() => window.getSelection()?.toString() ?? '');

/** Everything the tests below need: heading, list, link, divider, trailing text. */
const SEED = [
  '# Hello world',
  '',
  '- first',
  '  - second',
  '',
  '[after](https://example.com/docs) the list',
  '',
  '---',
  '',
  'tail',
].join('\n');

/** Replace the document with `md`, through the app's own Markdown import. */
async function seed(md: string, expected: string): Promise<void> {
  // The confirm() dialog is auto-accepted by the openApp handler.
  await app.page.setInputFiles('[data-testid="import-md-input"]', {
    name: 'seed.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(md),
  });
  await expect(editor()).toContainText(expected);
  await expect(app.page.getByTestId('format-bar')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  app = await openApp(browser, 'document');
  await createDocViaUI(app, 'Sentences', 'Living Doc');
  await seed(SEED, 'tail');
});

test.afterAll(async () => {
  app.assertNoFatalErrors();
  await app.close();
});

/**
 * The one assertion in this file that cannot be made anywhere else: that the
 * worker's writes are durable across a process restart. `page.reload()` kills the
 * dedicated worker, so this covers the whole chain — automerge-repo's throttled
 * saveDoc, the flush the app performs when the page is hidden, IndexedDB, and the
 * rehydrate on boot. It is also what caught the missing flush: without it the tail
 * of the history died with the worker.
 */
test('content survives a reload', async () => {
  // What the app itself does on visibilitychange → hidden; a reload gives no such
  // warning, so ask for it explicitly rather than racing the save debounce.
  await app.page.evaluate(() => (window as any).__drive.flushStorage());

  await app.page.reload();
  await app.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });

  await expect(editor().locator('h1')).toContainText('Hello world', { timeout: 30_000 });
  await expect(editor().locator('.rt-li')).toHaveCount(2);
  await expect(editor().locator('.rt-divider hr')).toBeVisible();
  await expect(editor()).toContainText('tail');
  // Editable renders a real <a>; it only swallows the click (which places the
  // caret), and the Link sheet's Open is how an editor follows it.
  await expect(editor().locator('a.rt-link')).toHaveAttribute('href', 'https://example.com/docs');
  // And it comes back editable, with no gesture in between.
  await expect(editor()).toHaveAttribute('contenteditable', 'true');
  await expect(app.page.getByTestId('format-bar')).toBeVisible();
});

/**
 * Gestures the browser implements and jsdom does not: word-granularity selection
 * from a double click, and the undo keybinding through a real contenteditable.
 * The undo *scope* (one edit, divider intact) is pinned model-side in
 * tests/rich-text-restore.test.ts — this only proves the key reaches it.
 */
test('double-click selects a word, and Ctrl+Z takes back the edit that replaced it', async () => {
  // The h1 is full-width, so its geometric centre is empty space past the
  // word — dblclick the start of the first run to land on "Hello".
  const run = editor().locator('h1 span[data-from]').first();
  const box = (await run.boundingBox())!;
  await app.page.mouse.dblclick(box.x + 6, box.y + box.height / 2);
  expect(await selectedText()).toBe('Hello');

  // One character, not a word: every keystroke is its own change, so typing
  // "Howdy" would take five undos to revert. Replacing a selection is one
  // splice, so a single typed character is one change and one Ctrl+Z undoes it.
  await app.page.keyboard.type('X');
  await expect(editor().locator('h1')).toContainText('X world');

  // The undo computes its target from a cursor advanced by the 'X' write's heads
  // push. Under load a Ctrl+Z fired while the write is still in flight can target
  // a stale version (restore throws "Version not found" and the doc keeps the X).
  // Drain the worker — FIFO behind the pending write — so the write is applied
  // and its push delivered before the undo.
  await app.page.evaluate(() => (window as any).__drive.flushStorage());

  await app.page.keyboard.press('ControlOrMeta+z');
  await expect(editor().locator('h1')).toContainText('Hello world');
  // The undo took back one edit, not the document: the divider is still here.
  await expect(editor().locator('.rt-divider hr')).toBeVisible();
});

/**
 * Backspacing an empty list item outdents it — and at depth 0 turns it into a
 * paragraph, which is a change of ELEMENT (`<div class="rt-li">` → `<p>`). Preact
 * rebuilds a subtree whose type changed rather than patching it, so the element
 * holding the collapsed caret is torn out and the browser lifts the selection to
 * the editor root. Only a real engine does that: jsdom leaves the selection on the
 * detached node instead, which the offset mapping rejects outright, so the restore
 * fires there and the bug is invisible.
 *
 * The restore's "the selection is already right" check compares INDICES, and a
 * root point resolves to a block edge — which for a leading block is exactly the
 * index being restored. So it wrote nothing and the caret was left in no block at
 * all: it vanished. RichTextEditor.test.tsx pins the guard itself by parking a
 * selection on the root; this pins that the browser really produces that state.
 */
test('the caret survives an empty leading list item outdenting to a paragraph', async () => {
  await seed('- alpha\n\n- beta', 'beta');
  await editor().locator('.rt-li').first().click();
  await app.page.keyboard.press('Home');
  await app.page.keyboard.press('Enter');     // an empty item is now block 0
  await app.page.keyboard.press('ArrowLeft'); // ...with the caret back inside it
  await app.page.keyboard.press('Backspace'); // depth 0 → paragraph

  await expect(editor().locator('.rt-li')).toHaveCount(2);
  const caret = await app.page.evaluate(() => {
    const root = document.querySelector('[data-testid="rt-editor"]') as HTMLElement;
    const n = window.getSelection()?.anchorNode ?? null;
    const el = n?.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element | null);
    return { onRoot: n === root, bi: (el?.closest('[data-bi]') as HTMLElement | null)?.dataset.bi ?? null };
  });
  expect(caret).toEqual({ onRoot: false, bi: '0' });
});

/**
 * A native mouse drag, upward. Moving the caret mints Automerge cursor tokens;
 * registering them makes the worker re-push the subscription, and that push
 * re-runs the editor's caret-restore effect — so a background round trip lands
 * mid-drag. Every step here moves earlier in document order, so the selection can
 * only grow, unless that restore resets the browser's drag anchor. It did, which
 * collapsed the highlight on the way up while downward drags looked fine. The
 * waits are deliberate: without them the assertions run before the push.
 */
test('dragging a selection upward keeps growing the highlight', async () => {
  await seed('alpha\n\nbeta\n\ngamma', 'gamma');
  // Collapse anything already selected: a mousedown inside an existing selection
  // starts a drag-and-drop, not a new selection.
  await editor().locator('p').nth(1).click();
  const first = (await editor().locator('p').nth(0).boundingBox())!;
  const last = (await editor().locator('p').nth(2).boundingBox())!;

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

/**
 * A REAL IME composition, driven through CDP.
 *
 * This is the only test in the suite that can catch the bug it guards: the
 * editor's composition handlers were registered as JSX props, and Preact only
 * lowercases an `onFoo` prop into a DOM event name when the lowercase form is an
 * IDL property of the element. `oncompositionstart` is not one, so
 * `onCompositionStart` became a listener for the literal event name
 * 'CompositionStart' — which nothing fires. The handlers had never run, in any
 * browser, and because Android's GBoard composes ordinary Latin typing, every
 * word typed on a phone went into the DOM and never into the document.
 *
 * jsdom pins the registration (RichTextEditor.test.tsx), but only a real engine
 * proves the whole chain: a genuine composition, the non-cancelable
 * `insertCompositionText` the editor must not fight, the browser writing the DOM
 * itself, and the reconcile at compositionend putting it in the CRDT.
 *
 * Chromium-only by nature — Input.imeSetComposition is a CDP command.
 */
test('a real IME composition reaches the document', async () => {
  await seed('start\n\nend', 'end');
  const para = editor().locator('p').first();
  await para.click();
  await app.page.keyboard.press('End');

  const cdp = await app.page.context().newCDPSession(app.page);
  // Composing, one keystroke at a time, exactly as a soft keyboard does.
  await cdp.send('Input.imeSetComposition', { text: 'i', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'in', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.imeSetComposition', { text: 'ing', selectionStart: 3, selectionEnd: 3 });
  // Committing the composition fires compositionend, which is what reconciles.
  await cdp.send('Input.insertText', { text: 'ing' });

  await expect(editor().locator('p').first()).toHaveText('starting');
  // In the DOCUMENT, not merely on screen — the whole point. A reload reads it
  // back out of the worker's storage.
  await app.page.evaluate(() => (window as any).__drive.flushStorage());
  await app.page.reload();
  await app.page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await expect(editor().locator('p').first()).toHaveText('starting', { timeout: 30_000 });
});
