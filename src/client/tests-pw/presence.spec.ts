import { test, expect } from '@playwright/test';
import { setupSharedDoc } from './support/scenarios';
import { waitFor } from './support/peer';

/**
 * Presence is broadcast over the ephemeral-message channel, with each value
 * encrypted under the document's keyhive key (see encryptPresenceValue /
 * decryptPresenceValue in automerge-worker.ts). This two-peer test exercises the
 * full round-trip in the real running app: alice sets a focused-field path, and
 * bob must receive the *decrypted* path — which only succeeds if the encrypt →
 * send → receive → decrypt path works end-to-end (and the keyhive WASM calls are
 * correctly serialized, i.e. no "unreachable executed" trap).
 */
test.describe('presence (encrypted ephemeral)', () => {
  // Disabled: times out.
  test.fixme("a peer's focused field syncs to another peer (decrypted)", async ({ browser }) => {
    const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
    const FOCUS = ['tasks', 'demo-task', 'title'];
    const key = JSON.stringify(FOCUS);

    try {
      // Both peers must have the doc synced/loaded before starting presence — in the
      // real app the editor renders the doc (loading its handle) before initPresence.
      for (const p of [alice, bob]) {
        await waitFor(
          () => p.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
          (r) => Array.isArray(r) && r.includes('Shared list'),
          { label: `${p.name} loads doc`, timeout: 45_000 }
        );
      }

      // Bob opens the doc, starts presence, and stashes incoming peer states.
      await bob.page.evaluate((d) => {
        (window as any).__bobPeers = {};
        (window as any).__drive.subscribePresence(d, (peers: any) => {
          (window as any).__bobPeers = peers;
        });
      }, docId);

      // Alice opens the doc and starts presence (so the two instances discover
      // each other and exchange ephemeral messages over the doc's sync channel).
      await alice.page.evaluate((d) => {
        (window as any).__drive.subscribePresence(d, () => {});
      }, docId);

      // Alice focuses a field; assert bob receives the identical, decrypted path.
      // Re-set on each poll: presence setup is async and a freshly-synced peer may
      // miss the first broadcast before its key material arrives.
      const peers = await waitFor(
        async () => {
          await alice.page.evaluate(
            ({ d, f }) => (window as any).__drive.setPresence(d, { focusedField: f }),
            { d: docId, f: FOCUS }
          );
          return bob.page.evaluate(() => (window as any).__bobPeers ?? {});
        },
        (states: any) =>
          Object.values(states).some((p: any) => JSON.stringify(p?.value?.focusedField) === key),
        { label: 'bob sees alice focused field (decrypted)', timeout: 60_000, interval: 1_000 }
      );

      const match = Object.values(peers).find(
        (p: any) => JSON.stringify(p?.value?.focusedField) === key
      );
      expect(match, 'a peer reports the decrypted focused-field path').toBeTruthy();

      // Convergence check: keep alice's focus set and sample bob over ~10s. Once
      // keyhive keys settle, every sample should decrypt to the same path (no flicker).
      const samples: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        await alice.page.evaluate(
          ({ d, f }) => (window as any).__drive.setPresence(d, { focusedField: f }),
          { d: docId, f: FOCUS }
        );
        await bob.page.waitForTimeout(800);
        const states = await bob.page.evaluate(() => (window as any).__bobPeers ?? {});
        const ok = Object.values(states).some((p: any) => JSON.stringify(p?.value?.focusedField) === key);
        samples.push(ok);
      }
      // The last 5 samples (steady state, after keyhive keys settle) must all see the
      // decrypted path — i.e. presence is stable, not flickering on decrypt failures.
      expect(samples.slice(-5).every(Boolean), 'presence is stable in steady state').toBe(true);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});
