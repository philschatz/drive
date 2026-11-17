/**
 * Shared identity for the stateless WebSocket relay.
 *
 * The relay is a message router, not a keyhive participant, but it must still
 * present a peerId to complete the automerge-repo handshake. On every client the
 * keyhive network adapter parses each peerId into a 32-byte ed25519 `Identifier`
 * (`keyhiveIdentifierFromPeerId` → `atob(peerId.split('-')[0])` → `new Identifier`).
 *
 * That requires the peerId to be valid base64 decoding to exactly 32 bytes that
 * form a curve point keyhive accepts. Two earlier ids failed that:
 *   - `relay-<rand>` decoded as `atob('relay')`, which throws (invalid base64);
 *   - 32 zero bytes is a SMALL-ORDER point, which keyhive >= 0.6 rejects in
 *     `new Identifier`. The bridge derives an Identifier from every connected
 *     peer inside one un-guarded loop, so a rejected relay id aborts keyhive
 *     sync to every peer after it.
 *
 * So the id is a nothing-up-my-sleeve prime-order point:
 *   SHA-256(RELAY_PEER_ID_LABEL || counter byte), first hash that decodes as a
 *   curve point (counter 1), multiplied by the cofactor 8.
 * Nobody knows its discrete log, so nobody can sign as the relay; it is not any
 * agent's key, so `accessForDoc` returns undefined and the relay is never sent
 * documents. relay-identity.test.ts recomputes the derivation.
 *
 * Changing this value is a wire change: relay and clients must agree on it (a
 * client only recognises the relay — and keeps it out of peer lists and the
 * share gate — by this exact string). Deploy the relay first.
 */
export const RELAY_PEER_ID_LABEL = 'automerge-drive/relay-peer-id/v1';
export const RELAY_PEER_ID = 's5wZayFg34B25mCcL0EwAMS1+y17j7hVTMH37RzTRLg=';

/**
 * The hosted production relay. Used by the browser worker (over `wss:`) and as the
 * CLI's default relay. Override the CLI with --relay / DRIVE_RELAY_URL.
 */
export const PRODUCTION_RELAY_URL = 'wss://drive-relay-ebe030e3546f.herokuapp.com';

/**
 * Relay-protocol extension: broadcast by the relay when a peer's socket closes.
 * The stock automerge-repo websocket protocol has no departure message (its
 * client adapter only knows `peer`/`error`), so each client's receiveMessage
 * intercept must translate this frame into a `peer-disconnected` emit —
 * otherwise departed peers stay in `repo.peers` forever.
 */
export const RELAY_LEAVE = 'leave';

export function isRelayLeaveFrame(decoded: any): decoded is { type: 'leave'; senderId: string } {
  return decoded?.type === RELAY_LEAVE && typeof decoded.senderId === 'string';
}

/**
 * Relay-protocol extension: a client's discovery declaration, sent right after
 * `join` and re-sent whenever the socket reopens or the roster changes (each
 * frame fully replaces the previous one). The relay introduces two sockets to
 * each other only when they announce the same `group` (one user's devices) or
 * when each one's `watch` names the other's `group` (mutual friends) — it
 * never announces peers beyond that, so strangers sharing a relay stay
 * invisible to each other. A device with no user group yet has nothing to
 * announce and simply doesn't send the frame (it can never pair anyway).
 * See the WebSocketRelay doc comment for the discovery rules and the known
 * limits of self-asserted group ids.
 */
export const RELAY_WATCH = 'watch';

export interface RelayWatchFrame {
  type: typeof RELAY_WATCH;
  /** Sender's own keyhive user-group id (base64). */
  group: string;
  /** User-group ids of known users: friends plus every group sharing a doc. */
  watch: string[];
}

export function isRelayWatchFrame(decoded: any): decoded is RelayWatchFrame {
  return decoded?.type === RELAY_WATCH
    && typeof decoded.group === 'string'
    && Array.isArray(decoded.watch);
}

/**
 * Build the discovery declaration from the group ids the engine knows: dedupe,
 * drop self and empties, and sort — a stable serialization is what makes the
 * engine's sent-frame diff guard meaningful.
 */
export function buildRelayWatchFrame(group: string, knownGroupIds: Iterable<string>): RelayWatchFrame {
  const watch = [...new Set(knownGroupIds)].filter((g) => !!g && g !== group).sort();
  return { type: RELAY_WATCH, group, watch };
}
