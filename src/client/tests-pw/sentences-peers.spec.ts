import { test, expect, type Page } from '@playwright/test';
import { setupFriendPair, shareNewDoc, waitForDocName, type FriendPair } from './support/scenarios';
import { bothSeeEachOther } from './support/peer';

/**
 * Two real browsers editing one Sentences document: everything about the Peritext
 * caret that only a cross-peer run can express.
 *
 * The caret is held as an Automerge Cursor registered with the worker
 * (subscribe-cursors), and its resolved position rides the same push as the spans,
 * so the editor can place it before rendering the merged text. Only a real
 * two-browser run exercises the worker's FIFO ordering between the mint, the
 * write, and the incoming change — and only a real layout can say where a peer's
 * caret was drawn.
 *
 * One friend pair, shared by every test (two contexts + two keyhive inits + a
 * contact exchange is the expensive part), with a fresh shared document per test
 * so no test inherits another's content.
 */
test.describe.configure({ mode: 'serial' });

let pair: FriendPair;

test.beforeAll(async ({ browser }) => {
  pair = await setupFriendPair(browser);
});

test.afterAll(async () => {
  await Promise.all([pair?.alice.close(), pair?.bob.close()]);
});

/** A fresh empty Sentences doc both peers hold, with `alice` on it and editable. */
async function openSharedDoc(name: string): Promise<string> {
  const docId = await shareNewDoc(pair, 'edit', { '@type': 'Sentences', name, content: '' });
  await waitForDocName(pair.alice, docId, name);
  await waitForDocName(pair.bob, docId, name);
  return docId;
}

const editor = (page: Page) => page.getByTestId('rt-editor');

/** Global caret offset inside the editor, from the real DOM selection. */
const caretOffset = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('[data-testid="rt-editor"]');
  const sel = window.getSelection();
  if (!root || !sel || sel.rangeCount === 0 || !sel.anchorNode) return -1;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === sel.anchorNode) return seen + sel.anchorOffset;
    seen += (n as Text).data.length;
  }
  return -1;
});

/**
 * Park the caret at a verified offset, re-correcting if it drifts.
 *
 * A caret-restore can fire LATE: the editor restores the last keystroke's
 * pending caret on the next spans re-render, and if that re-render lands after
 * we pressed an arrow, the selection is yanked back to end-of-text — and the
 * rebase guard then refuses to move a caret it believes has "moved on" (see
 * RichTextEditor's rebaseCaret). Each press is also a worker round-trip, so
 * presses are the wrong unit of measurement. Drive by the DOM offset instead:
 * press toward `target`, and require it to hold across a quiet window (long
 * enough for the last keystroke's re-push + restore to fire and be corrected).
 */
async function parkCaretAt(page: Page, target: number, timeout = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const off = await caretOffset(page);
    if (off === target) {
      await page.waitForTimeout(800);
      if ((await caretOffset(page)) === target) return;
      continue;
    }
    if (off < 0) {
      await editor(page).click();
    } else {
      await page.keyboard.press(off > target ? 'ArrowLeft' : 'ArrowRight');
    }
  }
  throw new Error(`caret did not settle at ${target}; last=${await caretOffset(page)}`);
}

/** Select `needle` inside the rich-text editor with a real DOM Range. */
async function selectText(page: Page, needle: string): Promise<void> {
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

/**
 * A peer's caret, drawn. `focusedField` carries ['content', <fromCursor>,
 * <toCursor>] as Automerge Cursors (Peritext convention — stable across concurrent
 * edits), the receiving worker resolves them back to indices, and the editor
 * measures a Range to place the line. So this covers the text-cursors minting
 * handler plus the subscribe-cursors registration whose positions ride the spans
 * push, and it is the only test that reads the resulting geometry.
 */
test("a collaborator's caret renders as a line and tracks their moves", async () => {
  test.setTimeout(180_000);
  const { alice, bob } = pair;
  const docId = await openSharedDoc('Shared sentences');

  // Alice edits: her caret ends up after the typed text.
  await alice.page.goto(`/#/d/${docId}`);
  await editor(alice.page).click();
  await alice.page.keyboard.type('hello from alice');

  // Bob opens the doc and, without touching it (no caret of his own), sees the text.
  await bob.page.goto(`/#/d/${docId}`);
  await expect(editor(bob.page)).toContainText('hello from alice', { timeout: 45_000 });

  // Presence is ephemeral with no replay, so alice's caret broadcast is only useful
  // once bob's worker is on the document. Wait for that, then move her caret so a
  // fresh broadcast goes out with bob listening — otherwise this test depends on
  // whether her last keystroke happened to land after bob joined.
  await bothSeeEachOther(alice.page, bob.page);
  await alice.page.keyboard.press('End');

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
});

/**
 * The assertion is deliberately made through the NEXT KEYSTROKE rather than by
 * measuring pixels: the editor feeds the restored caret index into
 * opsForInsertText, so a caret that was not rebased does not merely look wrong —
 * it splices text at the wrong offset.
 */
test('the local caret survives a peer editing above it', async () => {
  test.setTimeout(180_000);
  const { alice, bob } = pair;
  const docId = await openSharedDoc('Caret doc');

  // Alice types a line and parks her caret in the middle of "world". The offset,
  // not the press count, is the contract: a late caret-restore from the last
  // keystroke can clobber a press and leave the caret (and the cursor it mints)
  // at the wrong index — see parkCaretAt.
  await alice.page.goto(`/#/d/${docId}`);
  await editor(alice.page).click();
  await alice.page.keyboard.type('hello world');
  await parkCaretAt(alice.page, 8); // "hello wo|rld"

  // Bob edits at the very top of the document, before alice's caret.
  await bob.page.goto(`/#/d/${docId}`);
  await expect(editor(bob.page)).toContainText('hello world', { timeout: 45_000 });
  await editor(bob.page).click();
  await bob.page.keyboard.press('ControlOrMeta+Home');
  await bob.page.keyboard.type('XY');

  // Alice sees the merge land.
  await expect(editor(alice.page)).toContainText('XYhello world', { timeout: 45_000 });

  // Her caret must settle at the rebased offset (10 = "hello wo|rld" with bob's
  // "XY" prepended) before the next keystroke. The rebase rides the worker
  // re-push that follows her cursor registering, so if her last ArrowLeft's mint
  // was still in flight when bob's edit landed, the self-healing re-push is what
  // moves it. Typing before it lands splices at the stale offset.
  await expect.poll(() => caretOffset(alice.page), { timeout: 30_000 }).toBe(10);

  // Her next keystroke must still land inside "world" — an un-rebased caret
  // would put it two characters early ("XYhello !world").
  await alice.page.keyboard.type('!');
  await expect
    .poll(() => editor(alice.page).textContent(), { timeout: 30_000 })
    .toContain('XYhello wo!rld');

  // Both peers converge on the same text.
  await expect
    .poll(() => editor(bob.page).textContent(), { timeout: 30_000 })
    .toContain('XYhello wo!rld');
});

/**
 * A caret at end-of-content mints a sticky `'e'` end cursor, which resolves to
 * the document's new length. Typing must still work from there after a peer has
 * appended — the caret follows the end rather than landing mid-text.
 */
test('a caret at end-of-document keeps working after a peer appends', async () => {
  test.setTimeout(180_000);
  const { alice, bob } = pair;
  const docId = await openSharedDoc('End caret doc');

  await alice.page.goto(`/#/d/${docId}`);
  await editor(alice.page).click();
  await alice.page.keyboard.type('start'); // caret at end of content

  await bob.page.goto(`/#/d/${docId}`);
  await expect(editor(bob.page)).toContainText('start', { timeout: 30_000 });
  await editor(bob.page).click();
  await bob.page.keyboard.press('ControlOrMeta+Home');
  await bob.page.keyboard.type('TOP ');

  await expect(editor(alice.page)).toContainText('TOP start', { timeout: 30_000 });

  // Alice's caret was at the end; it must still be at the end, not shifted
  // back into the middle by bob's prefix.
  await alice.page.keyboard.type('!');
  await expect
    .poll(() => editor(alice.page).textContent(), { timeout: 30_000 })
    .toContain('TOP start!');
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

test('a selection overlapping a peer edit keeps the words that survive', async () => {
  test.setTimeout(180_000);
  const { alice, bob } = pair;
  const docId = await openSharedDoc('Overlap doc');

  await alice.page.goto(`/#/d/${docId}`);
  await editor(alice.page).click();
  await alice.page.keyboard.type(OVERLAP_PROSE);

  await bob.page.goto(`/#/d/${docId}`);
  await expect(editor(bob.page)).toContainText(OVERLAP_PROSE, { timeout: 30_000 });
  // Focus bob's editor: the rebase only touches a caret the editor owns
  // (applyRemoteSpans checks isFocused), and nothing focuses it on open.
  await editor(bob.page).click();

  // Two overlapping selections: alice's ends inside bob's, sharing `and pitch`.
  await selectText(alice.page, OVERLAP_ALICE);
  await selectText(bob.page, OVERLAP_BOB);

  // Bob's selection just triggered a cursor MINT — a worker round-trip that
  // resolves against the worker's CURRENT doc state. If alice's replacement
  // ops reach bob's worker before that mint lands, the cursors are minted
  // against a doc with part of her edit applied, and their later resolution
  // comes out shifted ("t up the t" instead of "the tents"). Drain bob's
  // worker queue twice: the first drain guarantees the selState effect has
  // dispatched the mint (FIFO behind it), the second that it has processed —
  // both strictly before alice starts typing.
  await bob.call('queryDoc', docId, '.name');
  await bob.call('queryDoc', docId, '.name');

  // Alice types over hers, destroying the two shared words along the way.
  await alice.page.keyboard.type(OVERLAP_ALICE_TYPES);
  await expect(editor(bob.page)).toContainText(OVERLAP_ALICE_TYPES, { timeout: 30_000 });

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
    .poll(() => editor(alice.page).textContent(), { timeout: 30_000 })
    .toContain('We drive up on Thursday night and set up the big tent by the lake before dark.');
});
