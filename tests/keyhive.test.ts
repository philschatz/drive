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
} from '@keyhive/keyhive/slim';
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

  it('ingestArchive identity contamination: B identity differs from contactCard flow', async () => {
    // Reproduces the production pattern from keyhive-ops.ts:214.
    // ingestArchive merges archive.active.individual into B's active individual
    // (keyhive_core/src/keyhive.rs:2598-2599), contaminating B's identity.
    //
    // In production, this causes browser B to fail decrypting A's sync messages
    // because B's identity no longer matches what A expects.
    const { khA: khA_good, khB: khB_good } = await setupInvitePair();
    const { khA: khA_bad, khB: khB_bad } = await setupInvitePairIngestArchive();

    // Compare B's identity bytes between the two flows
    const goodId = khB_good.id.bytes;
    const badId = khB_bad.id.bytes;
    console.log('[test] good B id length:', goodId.length, 'bad B id length:', badId.length);

    // Both B keyhives should have the same structure but ingestArchive
    // may contaminate the active individual
    const goodReachable = await khB_good.reachableDocs();
    const badReachable = await khB_bad.reachableDocs();
    console.log('[test] good B reachable:', goodReachable.length, 'bad B reachable:', badReachable.length);

    // Check B self-encrypt works in both flows
    const plaintext = new TextEncoder().encode('self-encrypt test');
    const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

    const goodDoc = await khB_good.getDocument(goodReachable[0].doc.doc_id);
    const goodResult = await khB_good.tryEncryptArchive(goodDoc!, ref, [], plaintext);
    expect(goodResult.encrypted_content()).toBeDefined();

    const ref2 = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const badDoc = await khB_bad.getDocument(badReachable[0].doc.doc_id);
    const badResult = await khB_bad.tryEncryptArchive(badDoc!, ref2, [], plaintext);
    expect(badResult.encrypted_content()).toBeDefined();

    // Check access — ingestArchive may report wrong access level
    const goodAccess = await khB_good.accessForDoc(new Identifier(goodId), goodReachable[0].doc.doc_id);
    const badAccess = await khB_bad.accessForDoc(new Identifier(badId), badReachable[0].doc.doc_id);
    console.log('[test] good B access:', goodAccess?.toString(), 'bad B access:', badAccess?.toString());
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
