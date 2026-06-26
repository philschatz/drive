/**
 * Shared identity for the stateless WebSocket relay.
 *
 * The relay is a message router, not a keyhive participant, but it must still
 * present a peerId to complete the automerge-repo handshake. On every client the
 * keyhive network adapter parses each peerId into a 32-byte ed25519 `Identifier`
 * (`keyhiveIdentifierFromPeerId` → `atob(peerId.split('-')[0])` → `new Identifier`).
 *
 * That requires the peerId to be valid base64 decoding to exactly 32 bytes that
 * form a valid curve point. The previous id (`relay-<rand>`) decoded as
 * `atob('relay')`, which throws (invalid base64) and aborted the keyhive sync.
 *
 * The all-zero identifier (base64 of 32 zero bytes) satisfies all of that: it
 * decodes to a valid 32-byte Identifier, it is NOT `Identifier.publicId()`
 * (so it can't trigger keyhive's public-access path), and no agent holds it
 * (so `bestAccessForDoc` returns undefined → the relay is never sent documents).
 */
export const RELAY_PEER_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
