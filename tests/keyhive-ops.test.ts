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
