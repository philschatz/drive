/**
 * Regression: the stateless relay must never appear in the user-facing peer list.
 *
 * RELAY_PEER_ID's all-zero bytes decode to a valid keyhive Identifier, so the
 * keyhive network adapter registers the relay as a peer-candidate and it lands in
 * `repo.peers` alongside real devices (see relay-identity.ts). `visiblePeerIds`
 * is the choke point that keeps it out of the counts/dots emitted to the UI, so a
 * device connected only to the relay correctly reports zero peers.
 */

import { visiblePeerIds } from '../src/shared/drive-engine';
import { RELAY_PEER_ID } from '../src/shared/relay-identity';

describe('visiblePeerIds', () => {
  it('drops the relay peer id', () => {
    expect(visiblePeerIds([RELAY_PEER_ID])).toEqual([]);
  });

  it('reports zero visible peers when only the relay is connected', () => {
    // The exact scenario behind the old "Disconnected while sync works" bug.
    expect(visiblePeerIds([RELAY_PEER_ID]).length).toBe(0);
  });

  it('keeps real device/contact peers and preserves their order', () => {
    const peers = ['device-a-drive', RELAY_PEER_ID, 'contact-b-drive'];
    expect(visiblePeerIds(peers)).toEqual(['device-a-drive', 'contact-b-drive']);
  });

  it('is a no-op when the relay is absent', () => {
    const peers = ['device-a-drive', 'device-b-drive'];
    expect(visiblePeerIds(peers)).toEqual(peers);
  });

  it('returns an empty list for no peers', () => {
    expect(visiblePeerIds([])).toEqual([]);
  });
});
