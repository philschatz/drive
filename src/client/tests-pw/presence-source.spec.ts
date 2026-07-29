import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor, type Peer } from './support/peer';

/**
 * Presence in the source viewer, between two REAL peers (separate browser
 * contexts = separate devices). Guards the report "the presence icons of peers
 * do not show up in the source viewer" (originally observed between two tabs of
 * one device — an unsupported setup: only one tab per device connects).
 *
 * Presence values are re-set on each poll, mirroring presence.spec.ts /
 * presence-liveness.spec.ts: presence setup is async and a freshly-synced peer
 * may miss the first broadcast before its key material arrives.
 */
// Previously fixme'd for a keyhive WASM panic (`unreachable executed`) on a late
// joiner's first presence encrypt: beekem's Cgka::new_app_secret_for expected the
// current root's PcsKey in pcs_key_ops, but that map was only populated on LOCAL
// update or on decrypt, so encrypting after ingesting a remote CGKA rekey panicked.
// Fixed in beekem (new_app_secret_for now repairs the mapping from the single
// ops-graph head that has_pcs_key() guarantees).
test('source viewer shows peer dots for a real remote peer', async ({ browser }) => {
  test.setTimeout(180_000);
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');

  const dotAppears = async (sender: Peer, watcher: Peer, label: string) => {
    await waitFor(
      async () => {
        await sender.page.evaluate(
          (d) => (window as any).__drive.setPresence(d, { viewing: true }),
          docId,
        );
        return watcher.page.locator('[data-testid="peer-dot"]').count();
      },
      (n) => n >= 1,
      { label, timeout: 60_000, interval: 1_000 },
    );
  };

  try {
    // Alice sits in the task editor (broadcasts viewing:true on mount)...
    await alice.page.goto(`/#/d/${docId}`);
    // ...while bob inspects the same doc in the source viewer.
    await bob.page.goto(`/#/source/${docId}`);

    // Deliberately NO worker warm-up (unlike presence-liveness.spec.ts): bob's
    // first find may race the keyhive announce and reject as unavailable — the
    // source viewer must retry its way to the doc on its own.
    await dotAppears(alice, bob, "alice's dot renders in bob's source viewer");
    await dotAppears(bob, alice, "bob's (source viewer) dot renders in alice's editor");
  } finally {
    await alice.close();
    await bob.close();
  }
});
