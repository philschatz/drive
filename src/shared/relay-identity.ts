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
 * `join` and re-sent whenever the socket reopens or what it declares changes
 * (each frame fully replaces the previous one). The relay introduces two
 * sockets to each other only when their declarations match — it never
 * announces peers beyond that, so strangers sharing a relay stay invisible to
 * each other. A device with nothing to declare sends no frame.
 *
 * Two forms share the frame type:
 * - **Tokens** (`RelayTokenFrame`, `v: 2`): opaque daily tokens derived from
 *   secrets the relay never sees (discovery-tokens.ts). Two sockets match when
 *   they present a token in common. This is what current clients send.
 * - **Group ids** (`RelayWatchFrame`): the sender's user-group id and the group
 *   ids it knows, in the clear. What clients sent before tokens; the relay
 *   still matches two such sockets with each other, for one release, so that
 *   devices not yet updated keep finding one another. It never matches one
 *   form with the other.
 */
export const RELAY_WATCH = 'watch';

/** Upper bounds the relay enforces on a token declaration. */
export const RELAY_MAX_TOKENS = 4096;
export const RELAY_MAX_TOKEN_LENGTH = 64;

export interface RelayTokenFrame {
  type: typeof RELAY_WATCH;
  v: 2;
  /** Today's and yesterday's discovery tokens (discovery-tokens.ts), sorted. */
  tokens: string[];
}

export function isRelayTokenFrame(decoded: any): decoded is RelayTokenFrame {
  return decoded?.type === RELAY_WATCH && decoded.v === 2 && Array.isArray(decoded.tokens);
}

/** The declaration for a set of tokens: deduplicated and sorted, so the same set is the same frame. */
export function buildRelayTokenFrame(tokens: Iterable<string>): RelayTokenFrame {
  return { type: RELAY_WATCH, v: 2, tokens: [...new Set(tokens)].sort() };
}

/** The group-id declaration of clients from before tokens. Current clients never send it. */
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
 * Build the group-id declaration an older client sends: dedupe, drop self and
 * empties, and sort. Kept for the relay's tests of that form.
 */
export function buildRelayWatchFrame(group: string, knownGroupIds: Iterable<string>): RelayWatchFrame {
  const watch = [...new Set(knownGroupIds)].filter((g) => !!g && g !== group).sort();
  return { type: RELAY_WATCH, group, watch };
}
