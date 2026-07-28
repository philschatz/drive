import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * Cross-browser cursor presence in the Sentences editor: the caret is broadcast in
 * `focusedField` as ['content', <fromCursor>, <toCursor>] with Automerge
 * Cursors (Peritext convention — stable positions across concurrent edits),
 * resolved back to indices on the receiving side by the real worker, and drawn
 * as a colored vertical line. This exercises the text-cursors minting handler
 * plus the subscribe-cursors registration whose positions ride the spans push,
 * end-to-end, which the jsdom container test only emulates.
 */
test('a collaborator\'s caret renders as a line and tracks their moves', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit', {
    '@type': 'Sentences',
    name: 'Shared sentences',
    content: '',
  });
  try {
    for (const p of [alice, bob]) {
      await waitFor(
        () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (r) => r === 'Shared sentences',
        { label: `${p.name} loads doc`, timeout: 45_000 }
      );
    }

    // Alice edits: her caret ends up after the typed text.
    await alice.page.goto(`/#/d/${docId}`);
    await alice.page.getByLabel('Edit sentences').click();
    await alice.page.getByTestId('rt-editor').click();
    await alice.page.keyboard.type('hello from alice');

    // Bob opens the doc read-only and sees the text, alice's caret line, and
    // her name tip riding above it.
    await bob.page.goto(`/#/d/${docId}`);
    await expect(bob.page.getByTestId('rt-editor')).toContainText('hello from alice', { timeout: 30_000 });
    const caret = bob.page.getByTestId('peer-caret');
    await expect(caret).toBeVisible({ timeout: 30_000 });
    await expect(bob.page.getByTestId('peer-tip')).not.toBeEmpty();

    // The line sits at the END of alice's text (well right of the margin) …
    const atEnd = await caret.evaluate(el => parseFloat((el as HTMLElement).style.left));
    expect(atEnd).toBeGreaterThan(40);

    // … and follows her caret to the start of the line.
    await alice.page.keyboard.press('Home');
    await expect
      .poll(() => caret.evaluate(el => parseFloat((el as HTMLElement).style.left)), { timeout: 30_000 })
      .toBeLessThan(atEnd / 2);

    // Selecting text renders translucent highlight boxes in alice's color.
    await alice.page.keyboard.press('Shift+End');
    const highlight = bob.page.getByTestId('peer-highlight').first();
    await expect(highlight).toBeVisible({ timeout: 30_000 });
    const width = await highlight.evaluate(el => parseFloat((el as HTMLElement).style.width));
    expect(width).toBeGreaterThan(40);
  } finally {
    await alice.close();
    await bob.close();
  }
});
