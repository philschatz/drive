/**
 * Regression test for the relay peerId crash.
 *
 * The keyhive network adapter registers every peer-candidate (including the
 * stateless relay) and, each sync cycle, derives a keyhive Identifier from the
 * peerId via `keyhiveIdentifierFromPeerId` → `atob(peerId.split('-')[0])` →
 * `new Identifier(bytes)`.
 *
 * The old relay id `relay-<rand>` made that decode `atob('relay')`, which throws
 * because "relay" is not valid base64 — aborting the entire keyhive sync pass.
 *
 * RELAY_PEER_ID must therefore decode to a valid 32-byte ed25519 Identifier.
 */

import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import { Identifier } from '@keyhive/keyhive/slim';
import { RELAY_PEER_ID } from './relay-identity';

initKeyhiveWasm();

const decode = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe('RELAY_PEER_ID', () => {
  it('decodes to a valid 32-byte keyhive Identifier (no crash)', () => {
    // Mirror keyhiveIdentifierFromPeerId: strip the suffix, then atob + Identifier.
    const prefix = RELAY_PEER_ID.split('-')[0];
    const bytes = decode(prefix);

    expect(bytes.length).toBe(32);
    expect(() => new Identifier(bytes)).not.toThrow();
  });

  it('reproduces the old crash: "relay" is invalid base64', () => {
    // The previous id was `relay-<rand>`; keyhive decoded split('-')[0] === "relay".
    expect(() => atob('relay')).toThrow();
  });

  it('is NOT the keyhive public identity (so the relay cannot gain public access)', () => {
    const relayBytes = decode(RELAY_PEER_ID.split('-')[0]);
    const publicBytes = Identifier.publicId().toBytes();

    expect(Array.from(relayBytes)).not.toEqual(Array.from(publicBytes));
  });
});
