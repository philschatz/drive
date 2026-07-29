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

/**
 * A selection that OVERLAPS a peer's edit keeps the words that survive it.
 *
 * The other cases here move a caret that sat *after* someone else's edit, where
 * nothing it names is ever destroyed. This one deletes part of the selection
 * itself: alice types over a range whose tail is bob's head, so the shared words
 * are gone. What bob must be left holding is the remaining *words* — not a
 * collapsed caret, and not a range that slid forward onto text nobody selected.
 *
 * docs/capture/assets.capture.ts films exactly this (presence-peritext.gif) and
 * takes its `BOB_SURVIVES` from here: the assertion is `trim()`ed because whether
 * the rebased anchor lands before or after the space in front of `the` is the
 * editor's business, and both answers are correct. The capture reads the real
 * survivor and preserves its leading space when typing over it.
 */
const OVERLAP_PROSE = 'We hike in on Friday and pitch the tents by the lake before dark.';
const OVERLAP_ALICE = 'hike in on Friday and pitch';
const OVERLAP_BOB = 'and pitch the tents';
const OVERLAP_ALICE_TYPES = 'drive up on Thursday night and set up';
const OVERLAP_SURVIVES = 'the tents';

/** Select `needle` inside the rich-text editor with a real DOM Range. */
async function selectText(page: import('@playwright/test').Page, needle: string): Promise<void> {
  await page.evaluate((needle) => {
    const root = document.querySelector('[data-testid="rt-editor"]');
    if (!root) throw new Error('selectText: no rt-editor');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      all += (n as Text).data;
    }
    const at = all.indexOf(needle);
    if (at < 0) throw new Error(`selectText: ${JSON.stringify(needle)} not in ${JSON.stringify(all)}`);
    const point = (off: number): [Text, number] => {
      let seen = 0;
      for (const n of nodes) {
        if (off <= seen + n.data.length) return [n, off - seen];
        seen += n.data.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.data.length];
    };
    const range = document.createRange();
    const [sn, so] = point(at);
    const [en, eo] = point(at + needle.length);
    range.setStart(sn, so);
    range.setEnd(en, eo);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, needle);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(needle);
}

test('a selection overlapping a peer edit keeps the words that survive', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit', {
    '@type': 'Sentences',
    name: 'Overlap doc',
    content: '',
  });
  try {
    for (const p of [alice, bob]) {
      await waitFor(
        () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (r) => r === 'Overlap doc',
        { label: `${p.name} loads doc`, timeout: 45_000 }
      );
    }

    await alice.page.goto(`/#/d/${docId}`);
    await alice.page.getByLabel('Edit sentences').click();
    await alice.page.getByTestId('rt-editor').click();
    await alice.page.keyboard.type(OVERLAP_PROSE);

    await bob.page.goto(`/#/d/${docId}`);
    await expect(bob.page.getByTestId('rt-editor')).toContainText(OVERLAP_PROSE, { timeout: 30_000 });
    await bob.page.getByLabel('Edit sentences').click();

    // Two overlapping selections: alice's ends inside bob's, sharing `and pitch`.
    await selectText(alice.page, OVERLAP_ALICE);
    await selectText(bob.page, OVERLAP_BOB);

    // Alice types over hers, destroying the two shared words along the way.
    await alice.page.keyboard.type(OVERLAP_ALICE_TYPES);
    await expect(bob.page.getByTestId('rt-editor')).toContainText(OVERLAP_ALICE_TYPES, {
      timeout: 30_000,
    });

    // Bob's selection is still a selection, over what is left of the phrase.
    await expect
      .poll(() => bob.page.evaluate(() => getSelection()?.toString().trim() ?? ''), {
        timeout: 30_000,
      })
      .toBe(OVERLAP_SURVIVES);
    const survived = await bob.page.evaluate(() => getSelection()?.toString() ?? '');
    console.log(`  survivor: ${JSON.stringify(survived)}`);

    // And because it is still live, typing replaces exactly it.
    await bob.page.keyboard.type((survived.startsWith(' ') ? ' ' : '') + 'the big tent');
    await expect
      .poll(() => alice.page.getByTestId('rt-editor').textContent(), { timeout: 30_000 })
      .toContain('We drive up on Thursday night and set up the big tent by the lake before dark.');
  } finally {
    await alice.close();
    await bob.close();
  }
});
