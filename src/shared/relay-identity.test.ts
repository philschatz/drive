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

import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import { Identifier } from '@keyhive/keyhive/slim';
import { RELAY_PEER_ID, RELAY_PEER_ID_LABEL, isRelayWatchFrame, buildRelayWatchFrame } from './relay-identity';

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

  it('the old all-zero id is rejected by this keyhive (why the id changed)', () => {
    // A small-order point. keyhive >= 0.6 refuses it, and the bridge builds an
    // Identifier for every connected peer inside one loop with no per-peer
    // catch — so with the relay on this id, keyhive sync stopped at the relay.
    expect(() => new Identifier(new Uint8Array(32))).toThrow();
  });
});

describe('RELAY_PEER_ID derivation', () => {
  const Point = ed25519.ExtendedPoint;

  it('is a prime-order point — keyhive >= 0.6 rejects small-order identifiers', () => {
    // The previous id (32 zero bytes) is one of the eight small-order points.
    // Newer keyhive throws on it in `new Identifier`, and the bridge derives an
    // Identifier from EVERY connected peer inside one un-guarded loop, so a
    // rejected relay id aborts keyhive sync to all the peers after it.
    const point = Point.fromHex(decode(RELAY_PEER_ID));
    expect(point.isSmallOrder()).toBe(false);
    expect(point.isTorsionFree()).toBe(true);
  });

  it('is the documented nothing-up-my-sleeve derivation (nobody holds its key)', () => {
    // SHA-256(label || counter) -> first hash that decodes as a curve point ->
    // multiply by the cofactor. The discrete log of the result is unknown, so
    // no one can sign as the relay.
    let derived: Uint8Array | null = null;
    for (let ctr = 0; ctr < 256 && !derived; ctr++) {
      const h = createHash('sha256').update(RELAY_PEER_ID_LABEL).update(Uint8Array.of(ctr)).digest();
      try { derived = Point.fromHex(Uint8Array.from(h)).multiplyUnsafe(8n).toRawBytes(); }
      catch { /* not a point — next counter */ }
    }
    expect(derived).not.toBeNull();
    expect(Buffer.from(derived!).toString('base64')).toBe(RELAY_PEER_ID);
  });

  it('survives the peerId suffix split (base64 with no "-")', () => {
    expect(RELAY_PEER_ID).not.toContain('-');
    expect(decode(RELAY_PEER_ID).length).toBe(32);
  });
});

describe('isRelayWatchFrame', () => {
  it('accepts a frame with a group and a watch list (possibly empty)', () => {
    expect(isRelayWatchFrame({ type: 'watch', group: 'g1', watch: ['g2', 'g3'] })).toBe(true);
    expect(isRelayWatchFrame({ type: 'watch', group: 'g1', watch: [] })).toBe(true);
  });

  it('rejects wrong types, missing group/watch, and non-string groups', () => {
    expect(isRelayWatchFrame({ type: 'join', group: 'g1', watch: [] })).toBe(false);
    expect(isRelayWatchFrame({ type: 'watch', watch: [] })).toBe(false);
    expect(isRelayWatchFrame({ type: 'watch', group: 'g1' })).toBe(false);
    expect(isRelayWatchFrame({ type: 'watch', group: 'g1', watch: 'g2' })).toBe(false);
    expect(isRelayWatchFrame({ type: 'watch', group: 7, watch: [] })).toBe(false);
    expect(isRelayWatchFrame(null)).toBe(false);
  });
});

describe('buildRelayWatchFrame', () => {
  it('dedupes, drops self and empties, and sorts for stable diffing', () => {
    const frame = buildRelayWatchFrame('gMe', ['gB', 'gA', 'gB', 'gMe', '', 'gA']);
    expect(frame).toEqual({ type: 'watch', group: 'gMe', watch: ['gA', 'gB'] });
  });

  it('produces the same frame regardless of input order (diff-guard stability)', () => {
    const a = buildRelayWatchFrame('gMe', ['gB', 'gA']);
    const b = buildRelayWatchFrame('gMe', ['gA', 'gB']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
