import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * Cross-browser presence through the real editor UI, with NO presence re-set
 * loops: each editor broadcasts its state once on mount, so the peer that opens
 * the doc LATER must still learn the earlier peer's state. That direction is
 * covered by usePresence's newcomer re-flush (re-announce the full local state
 * when an unseen peerId appears) — without it, alice's dot never reaches bob.
 *
 * Both workers are warmed (doc loaded) before any UI navigation, like
 * presence-liveness.spec.ts — the open-a-fresh-doc unavailable/WASM path is a
 * separate known engine issue (see source-presence.spec.ts).
 */
// KNOWN KEYHIVE BUG (fixme = deliberately skipped): the late joiner's first
// presence encrypt hits the beekem pcs_key_ops panic (`unreachable executed`,
// see source-presence.spec.ts) and kills his worker. The usePresence newcomer
// re-flush this spec also covers is app-side and stays. Un-fixme when the
// keyhive fix lands.
test.fixme('editors opened at different times see each other without re-broadcast loops', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
    for (const p of [alice, bob]) {
      await waitFor(
        () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
        (r) => Array.isArray(r) && r.includes('Shared list'),
        { label: `${p.name} loads doc`, timeout: 45_000 }
      );
    }

    // Alice opens the editor first; her viewing:true broadcast fires now,
    // while bob has no editor mounted.
    await alice.page.goto(`/#/d/${docId}`);
    await expect(alice.page.locator('.datagrid-cell, input, h1').first()).toBeVisible({ timeout: 15_000 });
    await alice.page.waitForTimeout(3_000); // ensure her broadcast is long gone

    // Bob joins later. He must see alice (via her newcomer re-flush), and she
    // must see him (his own mount broadcast).
    await bob.page.goto(`/#/d/${docId}`);
    await expect(
      bob.page.locator('[data-testid="peer-dot"]'),
      "alice's dot renders for the late joiner",
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      alice.page.locator('[data-testid="peer-dot"]'),
      "bob's dot renders for the early joiner",
    ).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await alice.close();
    await bob.close();
  }
});
