import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * The LOCAL caret must survive a concurrent remote edit. The caret is held as an
 * Automerge Cursor registered with the worker (subscribe-cursors), and its
 * resolved position rides the same push as the spans, so the editor can place it
 * before rendering the merged text.
 *
 * The assertion is deliberately made through the NEXT KEYSTROKE rather than by
 * measuring pixels: the editor feeds the restored caret index into
 * opsForInsertText, so a caret that was not rebased does not merely look wrong —
 * it splices text at the wrong offset. Only a real two-browser run exercises the
 * worker's FIFO ordering between the mint, the write, and the incoming change.
 */
test('the local caret survives a peer editing above it', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit', {
    '@type': 'Sentences',
    name: 'Caret doc',
    content: '',
  });
  try {
    for (const p of [alice, bob]) {
      await waitFor(
        () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (r) => r === 'Caret doc',
        { label: `${p.name} loads doc`, timeout: 45_000 }
      );
    }

    // Alice types a line and parks her caret in the middle of "world".
    await alice.page.goto(`/#/d/${docId}`);
    await alice.page.getByLabel('Edit sentences').click();
    await alice.page.getByTestId('rt-editor').click();
    await alice.page.keyboard.type('hello world');
    await alice.page.keyboard.press('ArrowLeft');
    await alice.page.keyboard.press('ArrowLeft');
    await alice.page.keyboard.press('ArrowLeft'); // caret now "hello wo|rld"

    // Bob edits at the very top of the document, before alice's caret.
    await bob.page.goto(`/#/d/${docId}`);
    await expect(bob.page.getByTestId('rt-editor')).toContainText('hello world', { timeout: 30_000 });
    await bob.page.getByLabel('Edit sentences').click();
    await bob.page.getByTestId('rt-editor').click();
    await bob.page.keyboard.press('ControlOrMeta+Home');
    await bob.page.keyboard.type('XY');

    // Alice sees the merge land.
    await expect(alice.page.getByTestId('rt-editor')).toContainText('XYhello world', { timeout: 30_000 });

    // Her next keystroke must still land inside "world" — an un-rebased caret
    // would put it two characters early ("XYhello !world").
    await alice.page.keyboard.type('!');
    await expect
      .poll(() => alice.page.getByTestId('rt-editor').textContent(), { timeout: 30_000 })
      .toContain('XYhello wo!rld');

    // Both peers converge on the same text.
    await expect
      .poll(() => bob.page.getByTestId('rt-editor').textContent(), { timeout: 30_000 })
      .toContain('XYhello wo!rld');
  } finally {
    await alice.close();
    await bob.close();
  }
});

/**
 * A caret at end-of-content mints a sticky `'e'` end cursor, which resolves to
 * the document's new length. Typing must still work from there after a peer has
 * appended — the caret follows the end rather than landing mid-text.
 */
test('a caret at end-of-document keeps working after a peer appends', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit', {
    '@type': 'Sentences',
    name: 'End caret doc',
    content: '',
  });
  try {
    for (const p of [alice, bob]) {
      await waitFor(
        () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (r) => r === 'End caret doc',
        { label: `${p.name} loads doc`, timeout: 45_000 }
      );
    }

    await alice.page.goto(`/#/d/${docId}`);
    await alice.page.getByLabel('Edit sentences').click();
    await alice.page.getByTestId('rt-editor').click();
    await alice.page.keyboard.type('start'); // caret at end of content

    await bob.page.goto(`/#/d/${docId}`);
    await expect(bob.page.getByTestId('rt-editor')).toContainText('start', { timeout: 30_000 });
    await bob.page.getByLabel('Edit sentences').click();
    await bob.page.getByTestId('rt-editor').click();
    await bob.page.keyboard.press('ControlOrMeta+Home');
    await bob.page.keyboard.type('TOP ');

    await expect(alice.page.getByTestId('rt-editor')).toContainText('TOP start', { timeout: 30_000 });

    // Alice's caret was at the end; it must still be at the end, not shifted
    // back into the middle by bob's prefix.
    await alice.page.keyboard.type('!');
    await expect
      .poll(() => alice.page.getByTestId('rt-editor').textContent(), { timeout: 30_000 })
      .toContain('TOP start!');
  } finally {
    await alice.close();
    await bob.close();
  }
});
