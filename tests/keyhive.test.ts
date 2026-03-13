/**
 * Tests for keyhive invite & key exchange infrastructure.
 *
 * Covers: PromiseQueue, Pending, peer ID utilities, invite payload
 * encoding/decoding, WASM signing & verification, and the full
 * invite generate → claim round-trip.
 */

import { Pending, PromiseQueue } from '../src/lib/automerge-repo-keyhive/network-adapter/pending';
import { peerIdFromVerifyingKey } from '../src/lib/automerge-repo-keyhive/network-adapter/messages';
import {
  isKeyhivePeerId,
  verifyingKeyPeerIdWithoutSuffix,
  uint8ArrayToHex,
  hexToUint8Array,
  peerIdFromSigner,
} from '../src/lib/automerge-repo-keyhive/utilities';
import { initKeyhiveWasm } from '../src/lib/automerge-repo-keyhive';
import type { PeerId } from '@automerge/automerge-repo/slim';

// WASM imports — available after initKeyhiveWasm()
import {
  Signer,
  Keyhive,
  CiphertextStore,
  Access,
  Archive,
  ChangeId,
  Identifier,
  Encrypted,
} from '@keyhive/keyhive/slim';
// getEventHashesForAgent used by production sync protocol — kept for reference
// import { getEventHashesForAgent } from '../src/lib/automerge-repo-keyhive/utilities';
import {
  signData,
  verifyData,
  decodeKeyhiveMessageData,
} from '../src/lib/automerge-repo-keyhive/network-adapter/messages';

beforeAll(() => {
  initKeyhiveWasm();
});

// ── PromiseQueue ────────────────────────────────────────────────────────────

describe('PromiseQueue', () => {
  it('runs tasks sequentially', async () => {
    const q = new PromiseQueue();
    const order: number[] = [];

    const p1 = q.run(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = q.run(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('propagates return values', async () => {
    const q = new PromiseQueue();
    const result = await q.run(async () => 42);
    expect(result).toBe(42);
  });

  it('continues after a rejected task', async () => {
    const q = new PromiseQueue();

    const p1 = q.run(async () => { throw new Error('boom'); });
    await expect(p1).rejects.toThrow('boom');

    const result = await q.run(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('fire-and-forget does not deadlock with subsequent await', async () => {
    const q = new PromiseQueue();
    const order: string[] = [];

    // Simulate the pattern from receiveMessage: outer queue task fires inner
    await q.run(async () => {
      order.push('outer-start');
      // Fire-and-forget inner task (queues after outer finishes)
      void q.run(async () => { order.push('inner'); });
      order.push('outer-end');
    });

    // Inner task should now be queued — run a follow-up to flush it
    await q.run(async () => { order.push('follow-up'); });

    expect(order).toEqual(['outer-start', 'outer-end', 'inner', 'follow-up']);
  });
});

// ── Pending ─────────────────────────────────────────────────────────────────

describe('Pending', () => {
  it('fires in-order callbacks immediately', () => {
    const p = new Pending();
    const results: number[] = [];

    const s1 = p.register();
    const s2 = p.register();
    p.fire(s1, () => results.push(1));
    p.fire(s2, () => results.push(2));

    expect(results).toEqual([1, 2]);
  });

  it('buffers out-of-order then drains when gap fills', () => {
    const p = new Pending();
    const results: number[] = [];

    const s1 = p.register();
    const s2 = p.register();
    const s3 = p.register();

    // Fire 3 and 2 before 1
    p.fire(s3, () => results.push(3));
    p.fire(s2, () => results.push(2));
    expect(results).toEqual([]);

    // Fire 1 — should drain all
    p.fire(s1, () => results.push(1));
    expect(results).toEqual([1, 2, 3]);
  });

  it('cancel unblocks subsequent entries', () => {
    const p = new Pending();
    const results: number[] = [];

    const s1 = p.register();
    const s2 = p.register();
    const s3 = p.register();

    p.fire(s3, () => results.push(3));
    p.cancel(s1);
    // s1 cancelled, s2 is now the gap
    p.fire(s2, () => results.push(2));

    expect(results).toEqual([2, 3]);
  });
});

// ── Peer ID utilities ───────────────────────────────────────────────────────

describe('peer ID utilities', () => {
  const key32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key32[i] = i;

  describe('peerIdFromVerifyingKey', () => {
    it('returns base64 for a 32-byte key', () => {
      const peerId = peerIdFromVerifyingKey(key32);
      // Decode and verify round-trip
      const decoded = Uint8Array.from(atob(peerId), c => c.charCodeAt(0));
      expect(decoded).toEqual(key32);
    });

    it('appends suffix with dash', () => {
      const peerId = peerIdFromVerifyingKey(key32, 'ws');
      expect(peerId).toMatch(/-ws$/);
    });

    it('no dash when suffix is empty', () => {
      const peerId = peerIdFromVerifyingKey(key32, '');
      expect(peerId).not.toContain('-');
    });
  });

  describe('isKeyhivePeerId', () => {
    it('returns true for a valid 32-byte key peer ID', () => {
      const peerId = peerIdFromVerifyingKey(key32);
      expect(isKeyhivePeerId(peerId)).toBe(true);
    });

    it('returns true with suffix', () => {
      const peerId = peerIdFromVerifyingKey(key32, 'suffix');
      expect(isKeyhivePeerId(peerId)).toBe(true);
    });

    it('returns false for short key', () => {
      const short = btoa(String.fromCharCode(...new Uint8Array(16)));
      expect(isKeyhivePeerId(short as PeerId)).toBe(false);
    });

    it('returns false for non-base64', () => {
      expect(isKeyhivePeerId('not-valid-base64!!!' as PeerId)).toBe(false);
    });
  });

  describe('verifyingKeyPeerIdWithoutSuffix', () => {
    it('strips suffix', () => {
      expect(verifyingKeyPeerIdWithoutSuffix('abc-ws' as PeerId)).toBe('abc');
    });

    it('returns identity when no suffix', () => {
      expect(verifyingKeyPeerIdWithoutSuffix('abc' as PeerId)).toBe('abc');
    });
  });

  describe('hex conversion', () => {
    it('round-trips', () => {
      const hex = uint8ArrayToHex(key32);
      expect(hexToUint8Array(hex)).toEqual(key32);
    });

    it('known vector', () => {
      expect(uint8ArrayToHex(new Uint8Array([0x00, 0xff, 0x0a]))).toBe('00ff0a');
    });
  });
});

// ── Invite payload encode / decode ──────────────────────────────────────────

describe('invite payload encode/decode', () => {
  // Inline encode (from AccessControl.tsx) and decode (from InvitePage.tsx)
  function encodePayload(seed: Uint8Array, archive: Uint8Array): string {
    const payload = new Uint8Array(4 + seed.length + archive.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, seed.length);
    payload.set(seed, 4);
    payload.set(archive, 4 + seed.length);
    let binary = '';
    for (let i = 0; i < payload.length; i++) binary += String.fromCharCode(payload[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodePayload(b64url: string): { seed: Uint8Array; archive: Uint8Array } {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const seedLen = view.getUint32(0);
    const seed = bytes.slice(4, 4 + seedLen);
    const archive = bytes.slice(4 + seedLen);
    return { seed, archive };
  }

  it('round-trips with 32-byte seed', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const archive = crypto.getRandomValues(new Uint8Array(200));
    const encoded = encodePayload(seed, archive);
    const decoded = decodePayload(encoded);
    expect(decoded.seed).toEqual(seed);
    expect(decoded.archive).toEqual(archive);
  });

  it('handles empty archive', () => {
    const seed = new Uint8Array([1, 2, 3]);
    const archive = new Uint8Array(0);
    const decoded = decodePayload(encodePayload(seed, archive));
    expect(decoded.seed).toEqual(seed);
    expect(decoded.archive).toEqual(archive);
  });

  it('handles large archive', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const archive = crypto.getRandomValues(new Uint8Array(10_000));
    const decoded = decodePayload(encodePayload(seed, archive));
    expect(decoded.seed).toEqual(seed);
    expect(decoded.archive).toEqual(archive);
  });
});

// ── Signing & verification (WASM) ──────────────────────────────────────────

describe('signing & verification', () => {
  let signer: Signer;
  let keyhive: Keyhive;
  let peerId: PeerId;

  beforeAll(async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    signer = Signer.memorySignerFromBytes(seed);
    const store = CiphertextStore.newInMemory();
    keyhive = await Keyhive.init(signer, store, () => {});
    peerId = peerIdFromSigner(signer);
  });

  it('sign then verify succeeds', async () => {
    const payload = new TextEncoder().encode('hello world');
    const signedBytes = await signData(keyhive, payload);
    const decoded = decodeKeyhiveMessageData(signedBytes);
    expect(decoded).toBeDefined();
    expect(verifyData(peerId, decoded!)).toBe(true);
  });

  it('verify fails with wrong peer ID', async () => {
    const payload = new TextEncoder().encode('test');
    const signedBytes = await signData(keyhive, payload);
    const decoded = decodeKeyhiveMessageData(signedBytes);
    expect(decoded).toBeDefined();

    const wrongKey = crypto.getRandomValues(new Uint8Array(32));
    const wrongPeerId = peerIdFromVerifyingKey(wrongKey);
    expect(verifyData(wrongPeerId, decoded!)).toBe(false);
  });

  it('peerIdFromSigner matches peerIdFromVerifyingKey', () => {
    const fromSigner = peerIdFromSigner(signer);
    const fromKey = peerIdFromVerifyingKey(signer.verifyingKey);
    expect(fromSigner).toBe(fromKey);
  });

  it('signed data includes contact card when provided', async () => {
    const contactCard = await keyhive.contactCard();
    const payload = new TextEncoder().encode('with card');
    const signedBytes = await signData(keyhive, payload, contactCard);
    const decoded = decodeKeyhiveMessageData(signedBytes);
    expect(decoded).toBeDefined();
    expect(decoded!.contactCard).toBeDefined();
  });
});

// ── Invite round-trip (WASM) ────────────────────────────────────────────────

describe('invite round-trip', () => {
  it('generates and claims an invite with write access', async () => {
    // --- Admin (A) creates keyhive and document ---
    const seedA = crypto.getRandomValues(new Uint8Array(32));
    const signerA = Signer.memorySignerFromBytes(seedA);
    const storeA = CiphertextStore.newInMemory();
    const khA = await Keyhive.init(signerA, storeA, () => {});

    const dummyChangeId = new ChangeId(new Uint8Array(32));
    const doc = await khA.generateDocument([], dummyChangeId, []);

    // --- A generates an invite ---
    const inviteSeed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(inviteSeed);
    const inviteStore = CiphertextStore.newInMemory();
    const tempKh = await Keyhive.init(inviteSigner, inviteStore, () => {});

    // Exchange contact cards: A receives tempKh's card
    const tempCard = await tempKh.contactCard();
    const tempIndividual = await khA.receiveContactCard(tempCard);
    const tempAgent = tempIndividual.toAgent();

    // Grant write access
    const writeAccess = Access.tryFromString('write');
    expect(writeAccess).toBeDefined();
    await khA.addMember(tempAgent, doc.toMembered(), writeAccess!, []);

    // Serialize A's archive (contains the delegation)
    const archiveA = await khA.toArchive();
    const archiveBytes = archiveA.toBytes();

    // --- B claims the invite ---
    const seedB = crypto.getRandomValues(new Uint8Array(32));
    const signerB = Signer.memorySignerFromBytes(seedB);

    // Reconstruct invite keyhive from archive
    const claimStore1 = CiphertextStore.newInMemory();
    const inviterArchive = new Archive(archiveBytes);
    const inviteKh = await inviterArchive.tryToKeyhive(claimStore1, inviteSigner, () => {});

    // B exchanges contact card with invite keyhive
    const storeB = CiphertextStore.newInMemory();
    const khB_temp = await Keyhive.init(signerB, storeB, () => {});
    const cardB = await khB_temp.contactCard();
    const individualB = await inviteKh.receiveContactCard(cardB);
    const agentB = individualB.toAgent();

    // Check reachable docs from invite
    const reachable = await inviteKh.reachableDocs();
    expect(reachable.length).toBeGreaterThan(0);

    const inviteDoc = reachable[0].doc;
    const inviteAccess = reachable[0].access;

    // Add B as member
    await inviteKh.addMember(agentB, inviteDoc.toMembered(), inviteAccess, []);

    // Rebuild B's keyhive from the updated archive using B's signer
    const updatedArchive = await inviteKh.toArchive();
    const claimStore2 = CiphertextStore.newInMemory();
    const khB = await updatedArchive.tryToKeyhive(claimStore2, signerB, () => {});

    // --- Verify B has access ---
    const bReachable = await khB.reachableDocs();
    expect(bReachable.length).toBeGreaterThan(0);

    // B can see the same document
    expect(bReachable[0].doc.doc_id.toString()).toBe(inviteDoc.doc_id.toString());
  });
});

// ── Cross-peer encrypt/decrypt after invite ─────────────────────────────────

// Helper: set up A and B with a write-access invite.
// Returns { khA, khB, docIdA } — both keyhives are fresh and independent.
//
// BUG FIX: The old flow used `tryToKeyhive(signerB)` which copies the CGKA
// from the archive as-is, leaving owner_id = A and owner_sks = A's old keys.
// This means B encrypts/decrypts using A's leaf position, which breaks when
// A updates its keys (A→B decrypt fails with "Key not found").
//
// The fixed flow uses `Keyhive.init(signerB)` (which has B's correct prekey
// pairs) + `ingestEventsBytes` from inviteKh. When B ingests the CGKA Add op
// for itself, `receive_cgka_op` calls `merge_cgka_invite_op`, which properly
// sets CGKA owner_id = B and includes B's secret key.
async function setupInvitePair() {
  // --- A creates keyhive and document ---
  const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
  const docA = await khA.generateDocument([], new ChangeId(crypto.getRandomValues(new Uint8Array(32))), []);
  const docIdA = docA.doc_id;

  // --- A generates a write-access invite ---
  const inviteSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
  const tempCard = await tempKh.contactCard();
  const tempIndividual = await khA.receiveContactCard(tempCard);
  const writeAccess = Access.tryFromString('write')!;
  await khA.addMember(tempIndividual.toAgent(), docA.toMembered(), writeAccess, []);

  // --- B claims the invite ---
  const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const archiveA = await khA.toArchive();
  const inviteKh = await new Archive(archiveA.toBytes()).tryToKeyhive(
    CiphertextStore.newInMemory(), inviteSigner, () => {}
  );
  // B's keyhive is created fresh (NOT via tryToKeyhive) so it has correct prekey pairs.
  // This is critical: B's CGKA ownership gets set properly when B ingests the Add op.
  const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
  const cardB = await khB.contactCard();
  const individualB = await inviteKh.receiveContactCard(cardB);
  const reachable = await inviteKh.reachableDocs();
  await inviteKh.addMember(individualB.toAgent(), reachable[0].doc.toMembered(), reachable[0].access, []);

  // B needs to know about A and temp (inviteSigner) as individuals before
  // it can process delegations that reference them.
  const cardA = await khA.contactCard();
  await khB.receiveContactCard(cardA);
  await khB.receiveContactCard(tempCard);

  // Sync events from inviteKh to B. This includes delegations + CGKA ops.
  // When B ingests the CGKA Add(B) op, receive_cgka_op calls merge_cgka_invite_op
  // which sets CGKA owner_id = B and includes B's secret prekey in owner_sks.
  const bAgent = individualB.toAgent();
  const eventsForB: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(bAgent);
  const eventsArr: Uint8Array[] = [];
  eventsForB.forEach((v: Uint8Array) => eventsArr.push(v));
  await khB.ingestEventsBytes(eventsArr);

  return { khA, khB, docIdA };
}

// Helper: old (buggy) setup using tryToKeyhive for the second step.
// Kept for comparison testing — demonstrates the CGKA ownership bug.
async function setupInvitePairBuggy() {
  const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
  const docA = await khA.generateDocument([], new ChangeId(crypto.getRandomValues(new Uint8Array(32))), []);
  const docIdA = docA.doc_id;

  const inviteSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
  const tempCard = await tempKh.contactCard();
  const tempIndividual = await khA.receiveContactCard(tempCard);
  const writeAccess = Access.tryFromString('write')!;
  await khA.addMember(tempIndividual.toAgent(), docA.toMembered(), writeAccess, []);

  const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const archiveA = await khA.toArchive();
  const inviteKh = await new Archive(archiveA.toBytes()).tryToKeyhive(
    CiphertextStore.newInMemory(), inviteSigner, () => {}
  );
  const khB_temp = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
  const cardB = await khB_temp.contactCard();
  const individualB = await inviteKh.receiveContactCard(cardB);
  const reachable = await inviteKh.reachableDocs();
  await inviteKh.addMember(individualB.toAgent(), reachable[0].doc.toMembered(), reachable[0].access, []);
  const khB = await (await inviteKh.toArchive()).tryToKeyhive(
    CiphertextStore.newInMemory(), signerB, () => {}
  );

  return { khA, khB, docIdA };
}

// Helper: production pattern using ingestArchive (keyhive-ops.ts:213-223).
// This causes identity contamination: ingestArchive merges the invite signer's
// active individual into B's active individual, corrupting B's identity.
async function setupInvitePairIngestArchive() {
  // --- A creates keyhive and document ---
  const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
  const docA = await khA.generateDocument([], new ChangeId(crypto.getRandomValues(new Uint8Array(32))), []);
  const docIdA = docA.doc_id;

  // --- A generates a write-access invite ---
  const inviteSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
  const tempCard = await tempKh.contactCard();
  const tempIndividual = await khA.receiveContactCard(tempCard);
  const writeAccess = Access.tryFromString('write')!;
  await khA.addMember(tempIndividual.toAgent(), docA.toMembered(), writeAccess, []);

  // --- B claims the invite using production pattern (ingestArchive) ---
  const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const archiveA = await khA.toArchive();
  const inviteKh = await new Archive(archiveA.toBytes()).tryToKeyhive(
    CiphertextStore.newInMemory(), inviteSigner, () => {}
  );
  const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
  const cardB = await khB.contactCard();
  const individualB = await inviteKh.receiveContactCard(cardB);
  const reachable = await inviteKh.reachableDocs();
  await inviteKh.addMember(individualB.toAgent(), reachable[0].doc.toMembered(), reachable[0].access, []);

  // Production pattern: ingestArchive + ingestEventsBytes (keyhive-ops.ts:213-223)
  // This is where the bug is — ingestArchive merges active.individual from the
  // invite archive into B's active individual, contaminating B's identity.
  const inviteArchiveOut = await inviteKh.toArchive();
  await khB.ingestArchive(inviteArchiveOut);

  const bAgent = individualB.toAgent();
  const eventsForB: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(bAgent);
  const eventsArr: Uint8Array[] = [];
  eventsForB.forEach((v: Uint8Array) => eventsArr.push(v));
  await khB.ingestEventsBytes(eventsArr);

  return { khA, khB, docIdA };
}

describe('cross-peer encrypt/decrypt after invite', () => {
  it('A encrypts, A decrypts (self round-trip)', async () => {
    const { khA, docIdA } = await setupInvitePair();

    const plaintext = new TextEncoder().encode('hello from A');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    // tryEncryptArchive takes doc by reference (tryEncrypt consumes it)
    const docA = await khA.getDocument(docIdA);
    const result = await khA.tryEncryptArchive(docA!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] A self-encrypt: update_op?', !!result.update_op());

    const docA2 = await khA.getDocument(docIdA);
    const decrypted = await khA.tryDecrypt(docA2!, encrypted);
    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it('A encrypts, B decrypts without event sync (expected: Key not found)', async () => {
    // B has A's CGKA state from the archive, but tryEncryptArchive generates
    // a NEW Update op that B hasn't seen yet.
    const { khA, khB, docIdA } = await setupInvitePair();

    const plaintext = new TextEncoder().encode('A→B no sync');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    const docA = await khA.getDocument(docIdA);
    const result = await khA.tryEncryptArchive(docA!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] A→B (no sync): update_op?', !!result.update_op());

    const bReachable = await khB.reachableDocs();
    const docB = bReachable[0].doc;
    await expect(khB.tryDecrypt(docB, encrypted)).rejects.toThrow('Key not found');
  });

  it('A encrypts, B decrypts after bidirectional event sync', async () => {
    const { khA, khB, docIdA } = await setupInvitePair();

    const statsB0 = await khB.stats();
    console.log('[test] B stats initial:', statsB0.totalOps);

    // Step 1: Sync B→A so A learns about B's membership/delegation
    const cardA = await khA.contactCard();
    const individualA_inB = await khB.receiveContactCard(cardA);
    const agentA_inB = individualA_inB.toAgent();

    const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(agentA_inB);
    console.log('[test] B→A sync: B has', bEventsForA.size, 'events for A');
    const bEventsArr: Uint8Array[] = [];
    bEventsForA.forEach((v: Uint8Array) => bEventsArr.push(v));

    const statsA_before = await khA.stats();
    console.log('[test] A stats before B→A ingest:', statsA_before.totalOps);
    await khA.ingestEventsBytes(bEventsArr);
    const statsA_after = await khA.stats();
    console.log('[test] A stats after B→A ingest:', statsA_after.totalOps);

    // Step 2: A encrypts (generates a new CGKA Update op)
    const plaintext = new TextEncoder().encode('hello from A to B');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const docA = await khA.getDocument(docIdA);
    const result = await khA.tryEncryptArchive(docA!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] A→B encrypt: update_op?', !!result.update_op());

    const statsA_postEnc = await khA.stats();
    console.log('[test] A stats after encrypt:', statsA_postEnc.totalOps);

    // Step 3: Sync A→B so B gets A's CGKA ops (including the new Update)
    const cardB = await khB.contactCard();
    const individualB_inA = await khA.receiveContactCard(cardB);
    const agentB_inA = individualB_inA.toAgent();

    const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(agentB_inA);
    console.log('[test] A→B sync: A has', aEventsForB.size, 'events for B');
    const aEventsArr: Uint8Array[] = [];
    aEventsForB.forEach((v: Uint8Array) => aEventsArr.push(v));

    const statsB_beforeIngest = await khB.stats();
    console.log('[test] B stats before A→B ingest:', statsB_beforeIngest.totalOps);
    await khB.ingestEventsBytes(aEventsArr);
    const statsB_afterIngest = await khB.stats();
    console.log('[test] B stats after A→B ingest:', statsB_afterIngest.totalOps);

    // Step 4: B decrypts
    const bReachable = await khB.reachableDocs();
    const docIdB = bReachable[0].doc.doc_id;
    const docB = await khB.getDocument(docIdB);

    // First try: direct decrypt
    try {
      const decrypted = await khB.tryDecrypt(docB!, encrypted);
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    } catch (e: any) {
      console.error('[test] B decrypt failed:', e?.message ?? String(e));
      // Compare with B→A direction which works: this asymmetry is the bug
      throw e;
    }
  });

  it('B encrypts, B decrypts (self round-trip)', async () => {
    const { khB } = await setupInvitePair();

    const bReachable = await khB.reachableDocs();
    const docIdB = bReachable[0].doc.doc_id;

    const plaintext = new TextEncoder().encode('hello from B');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    const docB = await khB.getDocument(docIdB);
    const result = await khB.tryEncryptArchive(docB!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] B self-encrypt: update_op?', !!result.update_op());

    const docB2 = await khB.getDocument(docIdB);
    const decrypted = await khB.tryDecrypt(docB2!, encrypted);
    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it('B encrypts, A decrypts after event sync', async () => {
    const { khA, khB, docIdA } = await setupInvitePair();

    // B encrypts
    const bReachable = await khB.reachableDocs();
    const docIdB = bReachable[0].doc.doc_id;
    const docB = await khB.getDocument(docIdB);

    const plaintext = new TextEncoder().encode('hello from B to A');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    const result = await khB.tryEncryptArchive(docB!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] B→A encrypt: update_op?', !!result.update_op());

    // Sync B's events to A using eventsForAgent + ingestEventsBytes
    const cardA = await khA.contactCard();
    const individualA_inB = await khB.receiveContactCard(cardA);
    const agentA_inB = individualA_inB.toAgent();

    const eventsMap: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(agentA_inB);
    console.log('[test] B has', eventsMap.size, 'events for A');

    const eventsArray: Uint8Array[] = [];
    eventsMap.forEach((eventBytes: Uint8Array) => {
      eventsArray.push(eventBytes);
    });

    const statsBefore = await khA.stats();
    console.log('[test] A stats before event ingest:', statsBefore.totalOps);
    await khA.ingestEventsBytes(eventsArray);
    const statsAfter = await khA.stats();
    console.log('[test] A stats after event ingest:', statsAfter.totalOps);

    // A decrypts B's message — THE KEY TEST
    const docA_fresh = await khA.getDocument(docIdA);
    expect(docA_fresh).toBeDefined();
    const decrypted = await khA.tryDecrypt(docA_fresh!, encrypted);
    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it('B encrypts, A decrypts after archive ingest (expected: Key not found)', async () => {
    // This test documents the known limitation: ingestArchive does NOT
    // transfer CGKA operations, so A cannot derive the decryption key.
    const { khA, khB, docIdA } = await setupInvitePair();

    const bReachable = await khB.reachableDocs();
    const docIdB = bReachable[0].doc.doc_id;
    const docB = await khB.getDocument(docIdB);

    const plaintext = new TextEncoder().encode('archive ingest test');
    const contentRef = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    const result = await khB.tryEncryptArchive(docB!, contentRef, [], plaintext);
    const encrypted = result.encrypted_content();
    console.log('[test] B encrypt (archive test): update_op?', !!result.update_op());

    // Sync via archive ingest (does NOT include CGKA ops)
    const archB = await khB.toArchive();
    const statsBefore = await khA.stats();
    console.log('[test] A stats before archive ingest:', statsBefore.totalOps);
    await khA.ingestArchive(archB);
    const statsAfter = await khA.stats();
    console.log('[test] A stats after archive ingest:', statsAfter.totalOps);

    const docA_fresh = await khA.getDocument(docIdA);
    expect(docA_fresh).toBeDefined();

    // Expect failure: ingestArchive doesn't sync CGKA ops
    await expect(khA.tryDecrypt(docA_fresh!, encrypted)).rejects.toThrow('Key not found');
  });
});

// ── Automerge-worker patterns ───────────────────────────────────────────────
// These tests replicate the exact logic from automerge-worker.ts handlers
// to document and prevent regressions on bugs we encountered.

describe('automerge-worker patterns', () => {
  it('tryToKeyhive reports Admin for invite claimant (the access override bug)', async () => {
    // Replicates the bug at automerge-worker.ts:788-790.
    // tryToKeyhive treats the signer as the keyhive owner, so accessForDoc
    // returns Admin regardless of the actual invite access level.
    // This is why the worker needs inviteAccessOverrides.
    const { khB, docIdA } = await setupInvitePairBuggy();

    const bReachable = await khB.reachableDocs();
    const docIdB = bReachable[0].doc.doc_id;
    const bId = new Identifier(khB.id.bytes);
    const reportedAccess = await khB.accessForDoc(bId, docIdB);

    expect(reportedAccess).toBeDefined();
    // BUG: reports Admin even though invite was Write
    expect(reportedAccess!.toString()).toBe('Admin');
    // The worker works around this with inviteAccessOverrides.set(khDocId, 'Write')
  });

  it('tryToKeyhive CGKA ownership bug: B self-encrypt works but A→B decrypt fails', async () => {
    // The old (buggy) flow used tryToKeyhive(signerB) which copies the CGKA
    // from the archive as-is, leaving owner_id = A. B can self-encrypt
    // (using A's leaf position), but when A encrypts with a new Update op,
    // B can't derive the key because B doesn't own a CGKA leaf.
    const { khA, khB, docIdA } = await setupInvitePairBuggy();

    // B self-encrypt works (it piggybacks on A's CGKA position)
    const bReachable = await khB.reachableDocs();
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const plainB = new TextEncoder().encode('from B');
    const refB = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultB = await khB.tryEncryptArchive(docB!, refB, [], plainB);
    expect(resultB.encrypted_content()).toBeDefined();

    // A encrypts (generates Update op)
    const docA = await khA.getDocument(docIdA);
    const plainA = new TextEncoder().encode('from A');
    const refA = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultA = await khA.tryEncryptArchive(docA!, refA, [], plainA);
    const encryptedA = resultA.encrypted_content();

    // Sync A→B events
    const cardB = await khB.contactCard();
    const indB_inA = await khA.receiveContactCard(cardB);
    const eventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
    const arr: Uint8Array[] = [];
    eventsForB.forEach((v: Uint8Array) => arr.push(v));
    await khB.ingestEventsBytes(arr);

    // B cannot decrypt A's message — CGKA ownership bug
    const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
    await expect(khB.tryDecrypt(docB2!, encryptedA)).rejects.toThrow();
  });

  it('fixed flow (init + ingestEventsBytes) gives B proper CGKA ownership', async () => {
    // The fixed setupInvitePair uses Keyhive.init(signerB) + ingestEventsBytes
    // instead of tryToKeyhive. This properly sets B's CGKA leaf ownership.
    // This test is equivalent to the "A encrypts, B decrypts after bidirectional
    // event sync" test but lives in the automerge-worker patterns section to
    // contrast with the buggy tryToKeyhive test above.
    const { khA, khB, docIdA } = await setupInvitePair();

    // Step 1: Sync B→A so A learns about B's membership
    const cardA = await khA.contactCard();
    const indA_inB = await khB.receiveContactCard(cardA);
    const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
    const bArr: Uint8Array[] = [];
    bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
    await khA.ingestEventsBytes(bArr);

    // Step 2: A encrypts (generates CGKA Update op)
    const docA = await khA.getDocument(docIdA);
    const plainA = new TextEncoder().encode('from A (fixed)');
    const refA = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultA = await khA.tryEncryptArchive(docA!, refA, [], plainA);
    const encryptedA = resultA.encrypted_content();

    // Step 3: Sync A→B
    const cardB = await khB.contactCard();
    const indB_inA = await khA.receiveContactCard(cardB);
    const eventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
    const arr: Uint8Array[] = [];
    eventsForB.forEach((v: Uint8Array) => arr.push(v));
    await khB.ingestEventsBytes(arr);

    // Step 4: B CAN decrypt A's message — fixed!
    const bReachable = await khB.reachableDocs();
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const decrypted = await khB.tryDecrypt(docB!, encryptedA);
    expect(new Uint8Array(decrypted)).toEqual(plainA);
  });

  it('full worker-level generate → encode → decode → claim round-trip', async () => {
    // Replicates the complete kh-generate-invite → InvitePage.decode → kh-claim-invite flow

    // --- A: enable sharing (kh-enable-sharing pattern) ---
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    const docA = await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);

    // --- A: generate invite (kh-generate-invite pattern) ---
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), docA.toMembered(), Access.tryFromString('write')!, []);
    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();

    // --- Encode payload (AccessControl.tsx pattern) ---
    const payload = new Uint8Array(4 + seed.length + archiveBytes.length);
    new DataView(payload.buffer).setUint32(0, seed.length);
    payload.set(seed, 4);
    payload.set(archiveBytes, 4 + seed.length);
    let binary = '';
    for (let i = 0; i < payload.length; i++) binary += String.fromCharCode(payload[i]);
    const payloadB64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // --- Decode payload (InvitePage.tsx pattern) ---
    const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const decodedBinary = atob(b64);
    const decodedBytes = new Uint8Array(decodedBinary.length);
    for (let i = 0; i < decodedBinary.length; i++) decodedBytes[i] = decodedBinary.charCodeAt(i);
    const seedLen = new DataView(decodedBytes.buffer).getUint32(0);
    const decodedSeed = decodedBytes.slice(4, 4 + seedLen);
    const decodedArchive = decodedBytes.slice(4 + seedLen);

    expect(decodedSeed).toEqual(seed);
    expect(decodedArchive).toEqual(archiveBytes);

    // --- B: claim invite (fixed kh-claim-invite pattern) ---
    const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));

    // Reconstruct invite keyhive
    const inviteSigner2 = Signer.memorySignerFromBytes(decodedSeed);
    const inviteKh = await new Archive(decodedArchive).tryToKeyhive(
      CiphertextStore.newInMemory(), inviteSigner2, () => {}
    );

    // B created fresh (not via tryToKeyhive)
    const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
    const cardB = await khB.contactCard();
    const individualB = await inviteKh.receiveContactCard(cardB);
    const reachable = await inviteKh.reachableDocs();
    expect(reachable.length).toBeGreaterThan(0);
    await inviteKh.addMember(individualB.toAgent(), reachable[0].doc.toMembered(), reachable[0].access, []);

    // B receives contact cards so it can process delegations
    const cardA = await khA.contactCard();
    await khB.receiveContactCard(cardA);
    await khB.receiveContactCard(inviteCard);

    // Sync events from inviteKh to B
    const bAgent = individualB.toAgent();
    const eventsForB: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(bAgent);
    const eventsArr: Uint8Array[] = [];
    eventsForB.forEach((v: Uint8Array) => eventsArr.push(v));
    await khB.ingestEventsBytes(eventsArr);

    // Verify B sees the document
    const bReachable = await khB.reachableDocs();
    expect(bReachable.length).toBeGreaterThan(0);
    expect(bReachable[0].doc.doc_id.toString()).toBe(docA.doc_id.toString());
  });

  it('multiple invites to same document', async () => {
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    const docA = await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);
    const docIdA = docA.doc_id;

    async function generateAndClaim(khAdmin: Keyhive, docId: any) {
      const invSeed = crypto.getRandomValues(new Uint8Array(32));
      const invSigner = Signer.memorySignerFromBytes(invSeed);
      const tmpKh = await Keyhive.init(invSigner, CiphertextStore.newInMemory(), () => {});
      const tmpCard = await tmpKh.contactCard();
      const tmpIndividual = await khAdmin.receiveContactCard(tmpCard);
      // Get fresh doc + access references each time (WASM objects may be consumed)
      const doc = await khAdmin.getDocument(docId);
      const writeAccess = Access.tryFromString('write')!;
      await khAdmin.addMember(tmpIndividual.toAgent(), doc!.toMembered(), writeAccess, []);

      // Claim using fixed flow
      const claimantSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const arch = await khAdmin.toArchive();
      const invKh = await new Archive(arch.toBytes()).tryToKeyhive(
        CiphertextStore.newInMemory(), invSigner, () => {}
      );
      const claimantKh = await Keyhive.init(claimantSigner, CiphertextStore.newInMemory(), () => {});
      const claimantCard = await claimantKh.contactCard();
      const claimantIndividual = await invKh.receiveContactCard(claimantCard);
      const reachable = await invKh.reachableDocs();
      await invKh.addMember(claimantIndividual.toAgent(), reachable[0].doc.toMembered(), reachable[0].access, []);

      // Receive contact cards
      const adminCard = await khAdmin.contactCard();
      await claimantKh.receiveContactCard(adminCard);
      await claimantKh.receiveContactCard(tmpCard);

      // Sync events
      const agent = claimantIndividual.toAgent();
      const events: Map<Uint8Array, Uint8Array> = await invKh.eventsForAgent(agent);
      const arr: Uint8Array[] = [];
      events.forEach((v: Uint8Array) => arr.push(v));
      await claimantKh.ingestEventsBytes(arr);

      return claimantKh;
    }

    const khB = await generateAndClaim(khA, docIdA);
    const khC = await generateAndClaim(khA, docIdA);

    // All three see the same document
    const aReachable = await khA.reachableDocs();
    const bReachable = await khB.reachableDocs();
    const cReachable = await khC.reachableDocs();

    expect(aReachable.length).toBeGreaterThan(0);
    expect(bReachable.length).toBeGreaterThan(0);
    expect(cReachable.length).toBeGreaterThan(0);

    const docIdStr = docIdA.toString();
    expect(bReachable[0].doc.doc_id.toString()).toBe(docIdStr);
    expect(cReachable[0].doc.doc_id.toString()).toBe(docIdStr);
  });

  it('syncKeyhive(B) skip bug: after contact card exchange, A never syncs events with B', async () => {
    // This test reproduces the exact production failure sequence.
    //
    // In the network adapter, when B initiates keyhive sync:
    // 1. B sends keyhive-sync-request to A
    // 2. A doesn't know B → sends keyhive-sync-request-contact-card
    // 3. B responds with keyhive-sync-missing-contact-card (includes B's card)
    // 4. A receives B's card → calls receiveContactCard(B)
    // 5. A calls syncKeyhive(B_peerId, true)
    //
    // BUG: syncKeyhive(maybeSenderId) uses senderId to EXCLUDE from the sync
    // loop (to avoid echo). But here senderId=B, so A SKIPS B!
    //   for (const targetId of this.peers.keys()) {
    //     if (targetId == senderId) continue;  // ← skips B!
    //   }
    //
    // Result: A receives B's contact card but never exchanges events with B.
    // A's CGKA tree never includes B. All of A's encryptions use a key
    // that B can't derive. "Updates from either browser never showed up."
    const { khA, khB, docIdA } = await setupInvitePairIngestArchive();

    // --- Simulate the production contact card exchange ---
    // A and B exchange contact cards (this part works)
    const cardB = await khB.contactCard();
    await khA.receiveContactCard(cardB);
    const cardA = await khA.contactCard();
    await khB.receiveContactCard(cardA);

    // --- BUG: syncKeyhive(B) skips B, so NO events are exchanged ---
    // In production, this is where A would call syncKeyhive(B_peerId, true)
    // which skips B. We simulate this by simply NOT exchanging events.
    // (The passing tests all call eventsForAgent + ingestEventsBytes here.)

    // A encrypts — B is NOT in A's CGKA tree because no events were synced
    const docA = await khA.getDocument(docIdA);
    const plaintext = new TextEncoder().encode('encrypted without sync');
    const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const result = await khA.tryEncrypt(docA!, ref, [], plaintext);

    // KEY: updateOp is undefined because A's CGKA tree only has A (no B)
    // The PCS key is derived from A-only tree. B can never derive this key.
    console.log(`[test] A encrypt (no event sync): updateOp=${!!result.update_op()}`);

    const encBytes = result.encrypted_content().toBytes();
    const wire = new Uint8Array(1 + encBytes.length);
    wire[0] = 0x01;
    wire.set(encBytes, 1);

    // B tries to decrypt — fails because B doesn't have A's CGKA state
    const bReachable = await khB.reachableDocs();
    expect(bReachable.length).toBeGreaterThan(0);
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
    await expect(khB.tryDecrypt(docB!, encrypted)).rejects.toThrow('Key not found');

    // Even B encrypting fails for A (reverse direction also broken)
    const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
    const plaintextB = new TextEncoder().encode('from B, no sync');
    const refB = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultB = await khB.tryEncryptArchive(docB2!, refB, [], plaintextB);
    const encryptedB = resultB.encrypted_content();

    const docA2 = await khA.getDocument(docIdA);
    await expect(khA.tryDecrypt(docA2!, encryptedB)).rejects.toThrow('Key not found');

    // PROOF: if we actually exchange events (what the buggy syncKeyhive should do),
    // everything works. This shows the hash-based sync ITSELF is fine — the bug is
    // that syncKeyhive(B) never initiates it.
    const agentA_inB = await khB.getAgent(new Identifier(khA.id.bytes));
    const bEvts: Uint8Array[] = [];
    (await khB.eventsForAgent(agentA_inB!)).forEach((v: Uint8Array) => bEvts.push(v));
    await khA.ingestEventsBytes(bEvts);

    const agentB_inA = await khA.getAgent(new Identifier(khB.id.bytes));
    const aEvts: Uint8Array[] = [];
    (await khA.eventsForAgent(agentB_inA!)).forEach((v: Uint8Array) => aEvts.push(v));
    await khB.ingestEventsBytes(aEvts);

    // Now A encrypts with B in the CGKA tree
    const docA3 = await khA.getDocument(docIdA);
    const plaintext2 = new TextEncoder().encode('after proper sync');
    const ref2 = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const result2 = await khA.tryEncrypt(docA3!, ref2, [], plaintext2);
    console.log(`[test] A encrypt (after proper sync): updateOp=${!!result2.update_op()}`);
    expect(result2.update_op()).toBeTruthy(); // NOW it generates updateOp

    // Sync the CGKA update to B
    const aEvts2: Uint8Array[] = [];
    (await khA.eventsForAgent(agentB_inA!)).forEach((v: Uint8Array) => aEvts2.push(v));
    await khB.ingestEventsBytes(aEvts2);

    const docB3 = await khB.getDocument(bReachable[0].doc.doc_id);
    const encrypted2 = (Encrypted as any).fromBytes(result2.encrypted_content().toBytes());
    const decrypted = await khB.tryDecrypt(docB3!, encrypted2);
    expect(new Uint8Array(decrypted)).toEqual(plaintext2);
  });

  it('production bug: B has pending events → A never gets CGKA ops → B cannot decrypt', async () => {
    // Reproduces the exact production failure from browser logs:
    //
    // Browser A:
    //   totalOps changed 0 → 593   (keyhive sync delivers B's events)
    //   Encrypted outgoing sync, updateOp=undefined  ← ALWAYS undefined
    //   totalOps changed 593 → 597 → 600
    //   Encrypted outgoing sync, updateOp=undefined  ← STILL undefined
    //
    // Browser B:
    //   totalOps changed 0 → 678   (keyhive sync delivers A's events)
    //   "140 hashes and 24 pending" ← B has 24 unresolvable events!
    //   Encrypted outgoing sync, updateOp=[object Object]  ← B's tree works
    //   decryptPayload failed: Key not found
    //   RETRY-DECRYPT failed (attempt 1-7/50): Key not found
    //
    // Root cause: During claimInvite, B calls ingestArchive + ingestEventsBytes.
    // Some events (including CGKA ops for B's membership) go to B's "pending"
    // store because their predecessors aren't available. In the hash-based
    // sync protocol, pending events are included in the hash count but
    // CANNOT BE SERVED to peers:
    //   "don't request pending events — peers can't serve them"
    // So A never receives B's CGKA membership ops. A's CGKA tree never
    // includes B. A encrypts with a key that excludes B forever.
    //
    // This test simulates this by withholding the CGKA events from
    // B→A sync, matching what happens when they're stuck in B's pending.
    const { khA, khB, docIdA } = await setupInvitePairIngestArchive();

    // --- Contact card exchange ---
    const cardB = await khB.contactCard();
    await khA.receiveContactCard(cardB);
    const cardA = await khA.contactCard();
    await khB.receiveContactCard(cardA);

    // --- B→A sync: but simulate pending events by only sending a SUBSET ---
    // In production, B has 140 found + 24 pending. The pending events
    // (which include CGKA membership ops) can't be served. A only gets
    // events from B's "found" set.
    //
    // We simulate this by sending only A's own events back to A (events A
    // already has) — B's NEW events (membership delegation, CGKA Add(B))
    // are withheld, simulating them being in pending.
    const agentA_inB = await khB.getAgent(new Identifier(khA.id.bytes));
    const allBEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(agentA_inB!);

    // Also get what A already knows, so we can send only duplicates
    const agentA_inA = await khA.getAgent(new Identifier(khA.id.bytes));
    const aOwnEvents: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(agentA_inA!);
    const aOwnHashes = new Set<string>();
    for (const hash of aOwnEvents.keys()) aOwnHashes.add(hash.toString());

    // Split B's events into "events A already has" and "new events"
    const eventsAHas: Uint8Array[] = [];
    const newEvents: Uint8Array[] = [];
    for (const [hash, eventBytes] of allBEventsForA) {
      if (aOwnHashes.has(hash.toString())) {
        eventsAHas.push(eventBytes);
      } else {
        newEvents.push(eventBytes);
      }
    }
    console.log(`[test] B→A events: ${allBEventsForA.size} total, ${eventsAHas.length} A already has, ${newEvents.length} new (simulated pending)`);

    // Only send events A already has — withhold new events (simulating pending)
    // In production, these new events are in B's pending store.
    const statsBefore = await khA.stats();
    if (eventsAHas.length > 0) await khA.ingestEventsBytes(eventsAHas);
    const statsAfter = await khA.stats();
    console.log(`[test] A after partial sync: totalOps ${statsBefore.totalOps} → ${statsAfter.totalOps}`);

    // A→B sync (A sends its events to B — this works fine)
    const agentB_inA = await khA.getAgent(new Identifier(khB.id.bytes));
    if (agentB_inA) {
      const aEvts: Uint8Array[] = [];
      (await khA.eventsForAgent(agentB_inA)).forEach((v: Uint8Array) => aEvts.push(v));
      if (aEvts.length > 0) await khB.ingestEventsBytes(aEvts);
    }

    // --- A encrypts (production: outgoing automerge sync) ---
    const docA = await khA.getDocument(docIdA);
    const plaintext = new TextEncoder().encode('A encrypts without B in CGKA');
    const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
    const hasUpdateA = !!result.update_op();
    console.log(`[test] A encrypt (pending events withheld): updateOp=${hasUpdateA}`);

    // Even if A generates a PCS update (key rotation), it's for a tree that
    // doesn't include B. B has no leaf in the tree and can't derive the key.
    // In production: "Encrypted outgoing sync, updateOp=undefined" — but
    // even when updateOp IS present, B still can't decrypt.

    // Sync A's CGKA update to B (in production this happens via keyhive sync).
    // Even though the update reaches B, B can't use it because B has no
    // leaf in A's CGKA tree — the membership events were in B's pending store.
    if (hasUpdateA) {
      const agentB_inA2 = await khA.getAgent(new Identifier(khB.id.bytes));
      if (agentB_inA2) {
        const aUpdateEvts: Uint8Array[] = [];
        (await khA.eventsForAgent(agentB_inA2)).forEach((v: Uint8Array) => aUpdateEvts.push(v));
        if (aUpdateEvts.length > 0) await khB.ingestEventsBytes(aUpdateEvts);
      }
    }

    // B tries to decrypt A's message → Key not found
    // This matches production: "RETRY-DECRYPT failed: Key not found"
    const ENC_ENCRYPTED = 0x01;
    const encBytes = result.encrypted_content().toBytes();
    const wire = new Uint8Array(1 + encBytes.length);
    wire[0] = ENC_ENCRYPTED;
    wire.set(encBytes, 1);

    const bReachable = await khB.reachableDocs();
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
    await expect(khB.tryDecrypt(docB!, encrypted)).rejects.toThrow('Key not found');

    // --- B encrypts (production: B's outgoing sync) ---
    // B's CGKA tree DOES include A, so B generates updateOp
    // This matches production: "updateOp=[object Object]"
    const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
    const plaintextB = new TextEncoder().encode('B encrypts with A in CGKA');
    const refB = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultB = await khB.tryEncryptArchive(docB2!, refB, [], plaintextB);
    const hasUpdateB = !!resultB.update_op();
    console.log(`[test] B encrypt: updateOp=${hasUpdateB}`);
    expect(hasUpdateB).toBe(true);

    // Even after multiple keyhive sync rounds (totalOps keeps going up),
    // A's CGKA tree never includes B because the critical events are
    // stuck in B's pending store and can't be served.
    // Retrying A's decrypt is futile — the key was derived from a tree
    // that excludes B. This matches production retry attempts 1-7 all
    // failing with "Key not found".
  });

  it('ingestArchive flow: full bidirectional encrypt/decrypt', async () => {
    // Reproduces the production pattern from keyhive-ops.ts:213-223.
    // Tests the exact same bidirectional flow as the "fixed flow" test above,
    // but using setupInvitePairIngestArchive (ingestArchive + ingestEventsBytes)
    // instead of setupInvitePair (receiveContactCard + ingestEventsBytes).
    //
    // In production, browser B fails to decrypt A's sync messages after claiming
    // an invite via this flow. This test attempts to reproduce that failure.
    const { khA, khB, docIdA } = await setupInvitePairIngestArchive();

    const bReachable = await khB.reachableDocs();
    console.log('[test] ingestArchive: B reachable docs:', bReachable.length);
    expect(bReachable.length).toBeGreaterThan(0);

    // Step 1: Sync B→A so A learns about B's membership
    const cardA = await khA.contactCard();
    const indA_inB = await khB.receiveContactCard(cardA);
    const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
    const bArr: Uint8Array[] = [];
    bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
    console.log('[test] ingestArchive: B→A sync events:', bArr.length);
    await khA.ingestEventsBytes(bArr);

    // Step 2: A encrypts (generates CGKA Update op)
    const docA = await khA.getDocument(docIdA);
    const plainA = new TextEncoder().encode('from A (ingestArchive flow)');
    const refA = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const resultA = await khA.tryEncryptArchive(docA!, refA, [], plainA);
    const encryptedA = resultA.encrypted_content();
    console.log('[test] ingestArchive: A encrypt update_op?', !!resultA.update_op());

    // Step 3: Sync A→B so B gets A's CGKA ops
    const cardB = await khB.contactCard();
    const indB_inA = await khA.receiveContactCard(cardB);
    const eventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
    const arr: Uint8Array[] = [];
    eventsForB.forEach((v: Uint8Array) => arr.push(v));
    console.log('[test] ingestArchive: A→B sync events:', arr.length);
    await khB.ingestEventsBytes(arr);

    // Step 4: B decrypts A's message
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const decrypted = await khB.tryDecrypt(docB!, encryptedA);
    expect(new Uint8Array(decrypted)).toEqual(plainA);

    // Step 5: B encrypts, A decrypts (reverse direction)
    const plainB = new TextEncoder().encode('from B (ingestArchive flow)');
    const refB = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
    const resultB = await khB.tryEncryptArchive(docB2!, refB, [], plainB);
    const encryptedB = resultB.encrypted_content();

    // Sync B→A again
    const bEventsForA2: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
    const bArr2: Uint8Array[] = [];
    bEventsForA2.forEach((v: Uint8Array) => bArr2.push(v));
    await khA.ingestEventsBytes(bArr2);

    const docA2 = await khA.getDocument(docIdA);
    const decryptedB = await khA.tryDecrypt(docA2!, encryptedB);
    expect(new Uint8Array(decryptedB)).toEqual(plainB);
  });
});

// ── Invite payload encode/decode with production claimInvite ────────────────

describe('invite payload encode/decode with production claimInvite', () => {
  // Replicates: AccessControl.tsx encode → URL → InvitePage.tsx decode → keyhive-ops.ts claimInvite
  // This is the EXACT production path including ingestArchive.

  function encodePayload(seed: Uint8Array, archiveBytes: Uint8Array): string {
    const payload = new Uint8Array(4 + seed.length + archiveBytes.length);
    new DataView(payload.buffer).setUint32(0, seed.length);
    payload.set(seed, 4);
    payload.set(archiveBytes, 4 + seed.length);
    let binary = '';
    for (let i = 0; i < payload.length; i++) binary += String.fromCharCode(payload[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodePayload(b64url: string): { seed: Uint8Array; archive: Uint8Array } {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const seedLen = view.getUint32(0);
    const seed = bytes.slice(4, 4 + seedLen);
    const archive = bytes.slice(4 + seedLen);
    return { seed, archive };
  }

  // Production claimInvite (keyhive-ops.ts:190-241)
  async function claimInvite(khB: any, seed: Uint8Array, archiveBytes: Uint8Array) {
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempStore = CiphertextStore.newInMemory();
    const inviterArchive = new Archive(archiveBytes);
    const inviteKh = await inviterArchive.tryToKeyhive(tempStore, inviteSigner, () => {});
    const ourCard = await khB.contactCard();
    const ourIndividualInInviteKh = await inviteKh.receiveContactCard(ourCard);
    const ourAgentInInviteKh = ourIndividualInInviteKh.toAgent();
    const reachable = await inviteKh.reachableDocs();
    if (reachable.length === 0) throw new Error('Invite has no document access');
    const docSummaryItem = reachable[0];
    const inviteDoc = docSummaryItem.doc;
    const inviteAccess = docSummaryItem.access;
    await inviteKh.addMember(ourAgentInInviteKh, inviteDoc.toMembered(), inviteAccess, []);

    const inviteArchiveOut = await inviteKh.toArchive();
    await khB.ingestArchive(inviteArchiveOut);

    const eventsForUs: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(ourAgentInInviteKh);
    const eventsArr: Uint8Array[] = [];
    eventsForUs.forEach((v: Uint8Array) => eventsArr.push(v));
    await khB.ingestEventsBytes(eventsArr);

    return { inviteDoc, inviteAccess };
  }

  it('archive bytes survive encode → decode round-trip', async () => {
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), (await khA.reachableDocs())[0].doc.toMembered(), Access.tryFromString('write')!, []);

    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();
    console.log('[test] archive size:', archiveBytes.length, 'bytes');

    const b64url = encodePayload(seed, archiveBytes);
    console.log('[test] b64url length:', b64url.length);

    const decoded = decodePayload(b64url);
    expect(decoded.seed).toEqual(seed);
    expect(decoded.archive.length).toBe(archiveBytes.length);
    expect(decoded.archive).toEqual(archiveBytes);
  });

  it('full production claimInvite (ingestArchive) after encode/decode', async () => {
    // A: generate invite
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    const docA = await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), docA.toMembered(), Access.tryFromString('write')!, []);
    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();

    // Encode → decode (simulates URL copy/paste)
    const b64url = encodePayload(seed, archiveBytes);
    const decoded = decodePayload(b64url);

    // B: claim invite using production pattern (ingestArchive)
    const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
    const { inviteDoc } = await claimInvite(khB, decoded.seed, decoded.archive);

    // Verify B sees the document
    const bReachable = await khB.reachableDocs();
    expect(bReachable.length).toBeGreaterThan(0);
    expect(bReachable[0].doc.doc_id.toString()).toBe(docA.doc_id.toString());
  });

  it('production claimInvite + bidirectional encrypt/decrypt', async () => {
    // A: generate invite
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    const docA = await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);
    const docIdA = docA.doc_id;

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), docA.toMembered(), Access.tryFromString('write')!, []);
    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();

    // Encode → decode
    const b64url = encodePayload(seed, archiveBytes);
    const decoded = decodePayload(b64url);

    // B: claim invite using production ingestArchive pattern
    const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
    await claimInvite(khB, decoded.seed, decoded.archive);

    // Bidirectional event sync (simulates keyhive sync protocol)
    // B→A
    const cardA = await khA.contactCard();
    const indA_inB = await khB.receiveContactCard(cardA);
    const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
    const bArr: Uint8Array[] = [];
    bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
    await khA.ingestEventsBytes(bArr);

    // A encrypts
    const plainA = new TextEncoder().encode('hello from A');
    const refA = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const docA2 = await khA.getDocument(docIdA);
    const resultA = await khA.tryEncryptArchive(docA2!, refA, [], plainA);
    const encryptedA = resultA.encrypted_content();

    // A→B
    const cardB = await khB.contactCard();
    const indB_inA = await khA.receiveContactCard(cardB);
    const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
    const aArr: Uint8Array[] = [];
    aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
    await khB.ingestEventsBytes(aArr);

    // B decrypts A's message
    const bReachable = await khB.reachableDocs();
    const docB = await khB.getDocument(bReachable[0].doc.doc_id);
    const decryptedA = await khB.tryDecrypt(docB!, encryptedA);
    expect(new Uint8Array(decryptedA)).toEqual(plainA);

    // B encrypts
    const plainB = new TextEncoder().encode('hello from B');
    const refB = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
    const resultB = await khB.tryEncryptArchive(docB2!, refB, [], plainB);
    const encryptedB = resultB.encrypted_content();

    // Sync B→A again
    const bEventsForA2: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
    const bArr2: Uint8Array[] = [];
    bEventsForA2.forEach((v: Uint8Array) => bArr2.push(v));
    await khA.ingestEventsBytes(bArr2);

    // A decrypts B's message
    const docA3 = await khA.getDocument(docIdA);
    const decryptedB = await khA.tryDecrypt(docA3!, encryptedB);
    expect(new Uint8Array(decryptedB)).toEqual(plainB);
  });

  it('production claimInvite on existing keyhive (B already has state)', async () => {
    // Simulates: B already has a keyhive with its own document, then claims
    // A's invite. This matches production where B loads from IndexedDB first.
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    const docA = await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);

    // B has its own keyhive with its own document (simulates prior session)
    const signerB = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khB = await Keyhive.init(signerB, CiphertextStore.newInMemory(), () => {});
    const docB_own = await khB.generateDocument([], new ChangeId(crypto.getRandomValues(new Uint8Array(32))), []);
    const statsB0 = await khB.stats();
    console.log('[test] B initial stats: totalOps=', statsB0.totalOps);

    // A generates invite
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), docA.toMembered(), Access.tryFromString('write')!, []);
    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();

    // Encode → decode
    const b64url = encodePayload(seed, archiveBytes);
    const decoded = decodePayload(b64url);

    // B claims on its existing keyhive
    await claimInvite(khB, decoded.seed, decoded.archive);

    const statsB1 = await khB.stats();
    console.log('[test] B after claim: totalOps=', statsB1.totalOps);

    // B should see both its own document and A's document
    const bReachable = await khB.reachableDocs();
    expect(bReachable.length).toBe(2);
    const docIds = bReachable.map((r: any) => r.doc.doc_id.toString());
    expect(docIds).toContain(docA.doc_id.toString());
    expect(docIds).toContain(docB_own.doc_id.toString());
  });

  it('archive bytes via Array.from round-trip (worker message path)', async () => {
    // Tests the exact serialization path: Uint8Array → number[] → postMessage → number[] → Uint8Array
    // This is how archiveBytes travel through the worker boundary.
    const signerA = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const khA = await Keyhive.init(signerA, CiphertextStore.newInMemory(), () => {});
    await khA.generateDocument([], new ChangeId(new Uint8Array(32)), []);

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = Signer.memorySignerFromBytes(seed);
    const tempKh = await Keyhive.init(inviteSigner, CiphertextStore.newInMemory(), () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await khA.receiveContactCard(inviteCard);
    await khA.addMember(inviteIndividual.toAgent(), (await khA.reachableDocs())[0].doc.toMembered(), Access.tryFromString('write')!, []);
    const archive = await khA.toArchive();
    const archiveBytes = archive.toBytes();

    // Simulate worker path: Uint8Array → Array.from (number[]) → new Uint8Array
    const asNumberArray: number[] = Array.from(archiveBytes);
    const backToUint8 = new Uint8Array(asNumberArray);

    expect(backToUint8.length).toBe(archiveBytes.length);
    expect(backToUint8).toEqual(archiveBytes);

    // Verify the round-tripped bytes can still be deserialized
    const reconstructed = new Archive(backToUint8);
    const inviteSigner2 = Signer.memorySignerFromBytes(seed);
    const inviteKh = await reconstructed.tryToKeyhive(
      CiphertextStore.newInMemory(), inviteSigner2, () => {}
    );
    const reachable = await inviteKh.reachableDocs();
    expect(reachable.length).toBeGreaterThan(0);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
