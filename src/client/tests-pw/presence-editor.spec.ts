import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * Cross-browser presence through the real UI, with NO presence re-set loops: each
 * view broadcasts its state once on mount, so the peer that opens the doc LATER
 * must still learn the earlier peer's state. That direction is covered by
 * usePresence's newcomer re-flush (re-announce the full local state when an unseen
 * peerId appears) — without it, alice's dot never reaches bob.
 *
 * The late joiner lands on the SOURCE viewer rather than a second editor, which
 * folds in what presence-source.spec.ts used to cover alone: with no worker
 * warm-up, bob's first find can race the keyhive announce and reject as
 * unavailable, so the source viewer has to retry its way to the doc before it can
 * render a dot at all. Both peers must still see each other, so this is strictly
 * stronger than either spec was, for one two-peer boot instead of two.
 */
// Previously fixme'd for the beekem pcs_key_ops panic (`unreachable executed`) on
// the late joiner's first presence encrypt: beekem's Cgka::new_app_secret_for
// expected the current root's PcsKey in pcs_key_ops, but that map was only
// populated on LOCAL update or on decrypt, so encrypting after ingesting a remote
// CGKA rekey panicked. Fixed in beekem; the newcomer re-flush here is app-side.
test('views opened at different times see each other without re-broadcast loops', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
    // Only ALICE's worker is warmed. Bob's is deliberately left cold so his first
    // find races the announce — the source viewer must recover on its own.
    await waitFor(
      () => alice.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (r) => r === 'Shared list',
      { label: 'alice loads doc', timeout: 45_000 }
    );

    // Alice opens the editor first; her viewing:true broadcast fires now,
    // while bob has nothing mounted.
    await alice.page.goto(`/#/d/${docId}`);
    // The title bar is the one thing every editor mounts (as static text now —
    // it used to be an input, which is what this locator was matching on).
    await expect(alice.page.getByTestId('doc-title')).toBeVisible({ timeout: 15_000 });
    await alice.page.waitForTimeout(3_000); // ensure her broadcast is long gone

    // Bob joins later, in the source viewer. He must see alice (via her newcomer
    // re-flush), and she must see him (his own mount broadcast) — neither side
    // re-sets its presence to help.
    await bob.page.goto(`/#/source/${docId}`);
    await expect(
      bob.page.locator('[data-testid="peer-dot"]'),
      "alice's dot renders for the late joiner, in the source viewer",
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      alice.page.locator('[data-testid="peer-dot"]'),
      "bob's (source viewer) dot renders for the early joiner",
    ).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await alice.close();
    await bob.close();
  }
});
