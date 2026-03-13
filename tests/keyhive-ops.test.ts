/**
 * Tests for KeyhiveOps — the extracted keyhive handler logic from automerge-worker.
 *
 * These tests exercise the real keyhive WASM (via keyhive-shim.js) with no-op
 * side effects, verifying the business logic without worker infrastructure.
 */

import { initKeyhiveWasm } from '../src/lib/automerge-repo-keyhive';
import {
  Signer,
  Keyhive,
  CiphertextStore,
  Access,
  Archive,
  ChangeId,
  DocumentId,
  Identifier,
  ContactCard,
  Encrypted,
} from '@keyhive/keyhive/slim';
import { KeyhiveOps, KeyhiveBridge, KeyhiveOpsSideEffects } from '../src/client/keyhive-ops';

initKeyhiveWasm();

const bridge: KeyhiveBridge = {
  ChangeId,
  DocumentId,
  Identifier,
  Signer,
  CiphertextStore,
  Keyhive,
  Archive,
  Access,
  ContactCard,
};

function noopSideEffects(): KeyhiveOpsSideEffects & { calls: Record<string, any[][]> } {
  const calls: Record<string, any[][]> = {
    persist: [],
    syncKeyhive: [],
    registerDoc: [],
    forceResyncAllPeers: [],
    findDoc: [],
  };
  return {
    calls,
    persist: async () => { calls.persist.push([]); },
    syncKeyhive: () => { calls.syncKeyhive.push([]); },
    registerDoc: (a, b) => { calls.registerDoc.push([a, b]); },
    forceResyncAllPeers: () => { calls.forceResyncAllPeers.push([]); },
    findDoc: (d) => { calls.findDoc.push([d]); },
  };
}

async function createOps() {
  const signer = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
  const fx = noopSideEffects();
  const ops = new KeyhiveOps(kh, bridge, fx);
  return { ops, kh, fx };
}

describe('KeyhiveOps', () => {
  describe('getIdentity', () => {
    it('returns the keyhive device ID', async () => {
      const { ops, kh } = await createOps();
      const result = ops.getIdentity();
      expect(result.deviceId).toBe(kh.idString);
    });
  });

  describe('getContactCard / receiveContactCard', () => {
    it('round-trips a contact card via JSON', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const cardJson = await opsA.getContactCard();
      expect(typeof cardJson).toBe('string');

      const result = await opsB.receiveContactCard(cardJson);
      expect(result.agentId).toBeDefined();
    });
  });

  describe('enableSharing', () => {
    it('creates a keyhive document and returns khDocId', async () => {
      const { ops, fx } = await createOps();
      const result = await ops.enableSharing('automerge-doc-123');
      expect(result.khDocId).toBeDefined();
      expect(typeof result.khDocId).toBe('string');
      expect(ops.khDocuments.has(result.khDocId)).toBe(true);
      expect(fx.calls.registerDoc.length).toBe(1);
      expect(fx.calls.registerDoc[0][0]).toBe('automerge-doc-123');
      expect(fx.calls.persist.length).toBe(1);
      expect(fx.calls.syncKeyhive.length).toBe(1);
    });
  });

  describe('generateInvite', () => {
    it('generates an invite with seed and archive bytes', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');

      const result = await ops.generateInvite(khDocId, 'write');
      expect(result.inviteKeyBytes).toHaveLength(32);
      expect(result.archiveBytes.length).toBeGreaterThan(0);
      expect(result.inviteSignerAgentId).toBeDefined();
    });

    it('throws for unknown document', async () => {
      const { ops } = await createOps();
      await expect(ops.generateInvite('nonexistent', 'write')).rejects.toThrow('Document not found');
    });

    it('throws for invalid role', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      await expect(ops.generateInvite(khDocId, 'superadmin')).rejects.toThrow('Invalid role');
    });
  });

  describe('claimInvite', () => {
    it('full round-trip: enableSharing → generateInvite → claimInvite', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB, fx: fxB } = await createOps();

      // A enables sharing and generates invite
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');

      // B claims
      const result = await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');
      expect(result.khDocId).toBeDefined();
      expect(opsB.khDocuments.has(result.khDocId)).toBe(true);
      expect(fxB.calls.registerDoc.length).toBe(1);
      expect(fxB.calls.forceResyncAllPeers.length).toBe(1);
      expect(fxB.calls.findDoc.length).toBe(1);
      expect(fxB.calls.findDoc[0][0]).toBe('doc-1');
    });

    it('sets inviteAccessOverrides to the correct access level', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      const result = await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes);

      // getMyAccess should return the override, not Admin
      const access = await opsB.getMyAccess(result.khDocId);
      expect(access).toBe('Write');
    });

    it('claimant can encrypt after claiming (CGKA ownership works)', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      const result = await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes);

      // B can self-encrypt
      const bReachable = await opsB.kh.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);
      const docB = await opsB.kh.getDocument(bReachable[0].doc.doc_id);
      const plaintext = new TextEncoder().encode('hello from B');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await opsB.kh.tryEncryptArchive(docB!, ref, [], plaintext);
      expect(encResult.encrypted_content()).toBeDefined();

      // B can decrypt its own message
      const docB2 = await opsB.kh.getDocument(bReachable[0].doc.doc_id);
      const decrypted = await opsB.kh.tryDecrypt(docB2!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('A encrypts → B decrypts after claimInvite (cross-peer)', async () => {
      // This is the production failure: after B claims via claimInvite (which uses
      // ingestArchive internally), A encrypts a message and B should be able to
      // decrypt it after receiving A's CGKA events.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // Step 1: Sync B→A so A knows about B
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // Step 2: A encrypts
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('hello from A after invite');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await khA.tryEncryptArchive(docA!, ref, [], plaintext);

      // Step 3: Sync A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Step 4: B decrypts
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const decrypted = await khB.tryDecrypt(docB!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('A encrypts → serialize → deserialize → B decrypts (network adapter path)', async () => {
      // Tests the exact encrypt/decrypt path used by the network adapter:
      // encrypt → Encrypted.toBytes() → [0x01 || bytes] over wire → Encrypted.fromBytes() → tryDecrypt
      // This is the path that fails in production with RETRY-DECRYPT errors.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // Sync B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A encrypts (using tryEncrypt, which consumes the doc — same as network adapter)
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('network adapter round-trip');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);

      // Serialize like network adapter: [0x01 || encrypted.toBytes()]
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // Sync A→B (including the new CGKA Update op from encryption)
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Deserialize + decrypt like network adapter
      expect(wire[0]).toBe(ENC_ENCRYPTED);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const decrypted = await khB.tryDecrypt(docB!, encrypted);
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('A encrypts before knowing about B → B cannot decrypt (production timing)', async () => {
      // Reproduces the exact production failure:
      // 1. B claims invite via claimInvite (uses ingestArchive internally)
      // 2. A has already encrypted sync messages using its current CGKA state
      // 3. B tries to decrypt but doesn't have A's CGKA Update ops
      //
      // In production, A encrypts outgoing sync messages immediately when B connects.
      // The keyhive sync (which would give B A's CGKA ops) happens in parallel,
      // but the encrypted automerge sync messages arrive first.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // A encrypts BEFORE any sync with B — this is the production scenario.
      // A doesn't know about B yet, so it encrypts using only its own CGKA state.
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('encrypted before sync');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));

      // Use tryEncrypt (not tryEncryptArchive) to match network adapter behavior
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // B tries to decrypt WITHOUT receiving A's CGKA events first.
      // This is what happens in production: encrypted sync arrives before keyhive sync.
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));

      // This should fail — B doesn't have A's CGKA Update op from the encryption
      await expect(khB.tryDecrypt(docB!, encrypted)).rejects.toThrow();
    });

    it('A encrypts before sync → B still cannot decrypt even after sync (production bug)', async () => {
      // This reproduces the exact production failure from browser logs:
      // 1. B claims invite (claimInvite uses ingestArchive internally)
      // 2. A encrypts sync messages (CGKA Update op generated without B in tree)
      // 3. B receives encrypted messages → buffered as pendingDecrypt
      // 4. Keyhive sync happens (B→A, A→B)
      // 5. B retries decrypt → STILL FAILS with "Key not found"
      //
      // Root cause: A's CGKA Update op from encryption was generated when B
      // wasn't in A's CGKA tree, so the update doesn't include B's leaf.
      // Even after syncing, B can't derive the decryption key because the
      // PCS key was derived from a tree state that doesn't include B.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // A encrypts before sync (production: outgoing sync msg encrypted immediately)
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('encrypted before sync');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // First attempt fails (no A's CGKA events yet)
      const bReachable = await khB.reachableDocs();
      const docB1 = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted1 = (Encrypted as any).fromBytes(wire.slice(1));
      await expect(khB.tryDecrypt(docB1!, encrypted1)).rejects.toThrow('Key not found');

      // Simulate keyhive sync: B→A then A→B
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Retry — STILL FAILS because A's Update op was for a tree without B
      const docB2 = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted2 = (Encrypted as any).fromBytes(wire.slice(1));
      await expect(khB.tryDecrypt(docB2!, encrypted2)).rejects.toThrow('Key not found');
    });

    it('full production flow: old messages undecryptable, new messages work after resync', async () => {
      // This test captures the complete production failure and required fix:
      //
      // Production sequence:
      // 1. B claims invite → connects to A
      // 2. A encrypts sync data with OLD PCS key (B not in CGKA tree) → B buffers
      // 3. Keyhive sync happens (B→A, A→B) → A learns about B
      // 4. A encrypts AGAIN → still updateOp=undefined (old key reused!)
      // 5. More keyhive sync → A's tree finally includes B
      // 6. A encrypts → updateOp=[object Object] (NEW CGKA key includes B)
      // 7. A sends CGKA update via keyhive sync → B ingests
      // 8. B retries old messages → STILL FAILS (old key, forever undecryptable)
      // 9. B needs NEW encrypted messages from A with the new key
      //    → requires automerge re-sync, not just retry
      //
      // The fix: after keyhive sync changes state, force automerge to re-sync
      // by emitting peer-disconnected + peer-candidate (not just peer-candidate,
      // which automerge-repo ignores for already-connected peers).
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      const ENC_ENCRYPTED = 0x01;
      const khDocIdStr = opsA.khDocuments.values().next().value!.doc_id;

      // Helper to encrypt and serialize
      async function encryptOnA(text: string) {
        const doc = await khA.getDocument(khDocIdStr);
        const plain = new TextEncoder().encode(text);
        const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
        const result = await khA.tryEncrypt(doc!, ref, [], plain);
        const hasUpdate = !!result.update_op();
        const encBytes = result.encrypted_content().toBytes();
        const wire = new Uint8Array(1 + encBytes.length);
        wire[0] = ENC_ENCRYPTED;
        wire.set(encBytes, 1);
        return { wire, hasUpdate };
      }

      // Helper to try decrypt on B
      async function decryptOnB(wire: Uint8Array): Promise<string> {
        const bReachable = await khB.reachableDocs();
        const doc = await khB.getDocument(bReachable[0].doc.doc_id);
        const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
        const decrypted = await khB.tryDecrypt(doc!, encrypted);
        return new TextDecoder().decode(new Uint8Array(decrypted));
      }

      // Step 1: A encrypts BEFORE keyhive sync (production: immediate sync response)
      const msg1 = await encryptOnA('before-sync');
      // B can't decrypt (no CGKA events from A)
      await expect(decryptOnB(msg1.wire)).rejects.toThrow();

      // Step 2: Keyhive sync B→A (A learns about B's existence)
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // Step 3: A encrypts AFTER partial sync — may or may not generate CGKA update
      const msg2 = await encryptOnA('after-partial-sync');

      // Step 4: Complete keyhive sync A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Step 5: Old message (msg1) is FOREVER undecryptable
      await expect(decryptOnB(msg1.wire)).rejects.toThrow('Key not found');

      // Step 6: msg2 (after partial sync) — try to decrypt
      // If A generated a CGKA update in msg2, B needs it synced first
      if (msg2.hasUpdate) {
        // Sync A's new CGKA update to B
        const aEvts2: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
        const arr2: Uint8Array[] = [];
        aEvts2.forEach((v: Uint8Array) => arr2.push(v));
        await khB.ingestEventsBytes(arr2);
      }
      // After full sync + CGKA update sync, msg2 should be decryptable
      const msg2Text = await decryptOnB(msg2.wire);
      expect(msg2Text).toBe('after-partial-sync');

      // Step 7: A encrypts AFTER full sync — this always works
      const msg3 = await encryptOnA('after-full-sync');
      // Sync the CGKA update if generated
      if (msg3.hasUpdate) {
        const aEvts3: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
        const arr3: Uint8Array[] = [];
        aEvts3.forEach((v: Uint8Array) => arr3.push(v));
        await khB.ingestEventsBytes(arr3);
      }
      const msg3Text = await decryptOnB(msg3.wire);
      expect(msg3Text).toBe('after-full-sync');

      // KEY INSIGHT: msg1 is forever lost. The network adapter must re-sync
      // automerge data after keyhive sync changes the CGKA tree, sending
      // fresh messages encrypted with the new key. Simply retrying buffered
      // messages will never work for msg1.
    });

    it('A encrypts AFTER sync → B CAN decrypt (fix: re-encrypt after learning about B)', async () => {
      // This test proves that the fix works: after keyhive sync completes and A
      // learns about B, A's NEW encryptions use a CGKA tree that includes B.
      // The production fix is: after A ingests B's events, force automerge re-sync
      // so A sends fresh encrypted messages that B can decrypt.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // Simulate keyhive sync: B→A then A→B (same as production keyhive sync)
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // NOW A encrypts — this should use a CGKA tree that includes B
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('encrypted AFTER sync');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // Sync A's new CGKA Update op to B
      const aEventsForB2: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr2: Uint8Array[] = [];
      aEventsForB2.forEach((v: Uint8Array) => aArr2.push(v));
      await khB.ingestEventsBytes(aArr2);

      // B decrypts — should succeed because A's tree now includes B
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
      const decrypted = await khB.tryDecrypt(docB!, encrypted);
      expect(new TextDecoder().decode(new Uint8Array(decrypted))).toBe('encrypted AFTER sync');
    });

    it('B encrypts → A decrypts after claimInvite (cross-peer reverse)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await opsB.claimInvite(invite.inviteKeyBytes, invite.archiveBytes, 'doc-1');

      // B encrypts
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const plaintext = new TextEncoder().encode('hello from B after invite');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await khB.tryEncryptArchive(docB!, ref, [], plaintext);

      // Sync B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A decrypts
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const decrypted = await khA.tryDecrypt(docA!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });
  });

  describe('getDocMembers', () => {
    it('lists members with correct roles', async () => {
      const { ops: opsA } = await createOps();
      const { khDocId } = await opsA.enableSharing('doc-1');

      const members = await opsA.getDocMembers(khDocId);
      expect(members.length).toBeGreaterThan(0);
      // Owner should be admin
      const me = members.find(m => m.isMe);
      expect(me).toBeDefined();
      expect(me!.role).toBe('Admin');
    });
  });

  describe('getMyAccess', () => {
    it('returns Admin for document owner', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const access = await ops.getMyAccess(khDocId);
      expect(access).toBe('Admin');
    });

    it('returns override when set', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      ops.inviteAccessOverrides.set(khDocId, 'Read');
      const access = await ops.getMyAccess(khDocId);
      expect(access).toBe('Read');
    });
  });

  describe('registerSharingGroup', () => {
    it('restores document into khDocuments map', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');

      // Clear the map to simulate a reload
      ops.khDocuments.clear();
      expect(ops.khDocuments.has(khDocId)).toBe(false);

      await ops.registerSharingGroup(khDocId);
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });
  });

  describe('multiple invites to same document', () => {
    it('both claimants see the document', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();
      const { ops: opsC } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const inviteB = await opsA.generateInvite(khDocId, 'write');
      const inviteC = await opsA.generateInvite(khDocId, 'write');

      await opsB.claimInvite(inviteB.inviteKeyBytes, inviteB.archiveBytes);
      await opsC.claimInvite(inviteC.inviteKeyBytes, inviteC.archiveBytes);

      const bDocs = await opsB.kh.reachableDocs();
      const cDocs = await opsC.kh.reachableDocs();
      expect(bDocs.length).toBeGreaterThan(0);
      expect(cDocs.length).toBeGreaterThan(0);
    });
  });
});
