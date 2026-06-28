import { test, expect } from '@playwright/test';
import { waitFor, type Peer } from './support/peer';
import { setupSharedDoc } from './support/scenarios';

/**
 * Two peers that have discovered each other through the relay should upgrade to a
 * direct WebRTC data channel (real loopback ICE candidates connect locally with
 * no TURN), and document sync should continue to work for edits made afterwards.
 *
 * This exercises the full path: relay peer discovery → WRTC_SIGNAL exchange over
 * the relay → RTCPeerConnection on the main thread → open data channel →
 * `p2p-status: direct` → sync messages routed off the relay.
 */

/** Latch every peerId that ever reaches the 'direct' transport (survives flaps). */
async function latchDirectPeers(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => {
    const seen = new Set<string>((window as any).__drive.getDirectPeers());
    (window as any).__directSeen = seen;
    (window as any).__drive.onP2pStatus((peerId: string, transport: string) => {
      if (transport === 'direct') seen.add(peerId);
    });
  });
}
const directSeen = (peer: Peer) =>
  peer.page.evaluate(() => [...((window as any).__directSeen ?? [])] as string[]);

test('peers upgrade to a direct WebRTC channel and keep syncing', async ({ browser }) => {
  const { alice, bob, docId } = await setupSharedDoc(browser, 'edit');
  try {
    await latchDirectPeers(alice);
    await latchDirectPeers(bob);

    const alicePeerId = await alice.call('getWorkerPeerId');
    const bobPeerId = await bob.call('getWorkerPeerId');

    // Each peer should open a direct channel to the other identity.
    await waitFor(() => directSeen(alice), (s) => s.includes(bobPeerId), {
      label: 'alice opens a direct channel to bob', timeout: 45_000,
    });
    await waitFor(() => directSeen(bob), (s) => s.includes(alicePeerId), {
      label: 'bob opens a direct channel to alice', timeout: 45_000,
    });

    // An edit made after the upgrade must still converge (over the data channel,
    // or the relay if the channel later flaps — correctness is transport-agnostic).
    await alice.page.evaluate(
      (id) => (window as any).__drive.updateDoc(id, (d: any) => { d.name = 'Edited over WebRTC'; }),
      docId
    );
    await waitFor(
      () => bob.call('queryDoc', docId, '.name').then((r) => r.result).catch(() => null),
      (result) => Array.isArray(result) && result.includes('Edited over WebRTC'),
      { label: 'bob receives the post-upgrade edit' }
    );
  } finally {
    await alice.close();
    await bob.close();
  }
});
