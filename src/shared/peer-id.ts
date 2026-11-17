/**
 * PeerId shape.
 *
 * A peerId is `<base64 device verifying key>-<label>` plus, from
 * automerge-repo-keyhive 0.4 on, `-<8 random chars>` minted on every engine
 * boot (the bridge adds it itself; it cannot be turned off). So a peerId names
 * one *boot* of one device's engine, not the device: the same device comes back
 * under a different peerId after a reload, and for up to a presence stale
 * window both ids can be visible at once.
 *
 * The device is the part before the first '-' — the keyhive agentId. Standard
 * base64 never contains '-', so that split is exact. Anything that means "this
 * device" (device names, online dots, presence identity) keys off the agentId;
 * anything that addresses a live connection (transport maps, WebRTC sessions,
 * sync targets) keeps using the full peerId.
 */

/** The device's keyhive agentId (base64 verifying key) of a peerId. */
export function agentIdOfPeerId(peerId: string): string {
  const cut = peerId.indexOf('-');
  return cut < 0 ? peerId : peerId.slice(0, cut);
}

/**
 * Collapse `peerIds` to one per device: the most recently seen. A rebooted
 * peer's previous peerId stops heartbeating but stays "fresh" until the stale
 * window closes; without this it would render as a second, frozen copy of the
 * same device (a ghost caret) beside the live one.
 */
export function newestPeerPerAgent(
  peerIds: Iterable<string>,
  lastSeen: ReadonlyMap<string, number>,
): Set<string> {
  const best = new Map<string, string>();
  for (const peerId of peerIds) {
    const agent = agentIdOfPeerId(peerId);
    const current = best.get(agent);
    if (current === undefined || (lastSeen.get(peerId) ?? 0) > (lastSeen.get(current) ?? 0)) {
      best.set(agent, peerId);
    }
  }
  return new Set(best.values());
}
