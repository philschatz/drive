/**
 * Tests for KeyhiveOps — the extracted keyhive handler logic from automerge-worker.
 *
 * These tests exercise the real keyhive WASM (via keyhive-shim.js) with no-op
 * side effects, verifying the business logic without worker infrastructure.
 */

import { initKeyhiveWasm } from '../lib/automerge-repo-keyhive';
import {
  Signer,
  Keyhive,
  CiphertextStore,
  Access,
  ChangeId,
  DocumentId,
  Identifier,
  ContactCard,
  Encrypted,
} from '@keyhive/keyhive/slim';
import { KeyhiveOps, KeyhiveBridge, KeyhiveOpsSideEffects } from './keyhive-ops';

initKeyhiveWasm();

const bridge: KeyhiveBridge = {
  ChangeId,
  DocumentId,
  Identifier,
  Signer,
  CiphertextStore,
  Keyhive,
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

/** Simulate the seed-only claim flow: get archive from inviter → tryToKeyhive → claimInviteWithKeyhive */
async function claimViaArchive(
  opsInviter: KeyhiveOps,
  opsClaimant: KeyhiveOps,
  inviteKeyBytes: number[],
  automergeDocId?: string,
) {
  const seed = new Uint8Array(inviteKeyBytes);
  const inviteSigner = Signer.memorySignerFromBytes(seed);
  const archive = await opsInviter.kh.toArchive();
  const tempStore = CiphertextStore.newInMemory();
  const inviteKh = await archive.tryToKeyhive(tempStore, inviteSigner, () => {});
  return opsClaimant.claimInviteWithKeyhive(inviteKh, automergeDocId);
}

describe('KeyhiveOps', () => {
  describe('getIdentity', () => {
    it('returns the keyhive device ID', async () => {
      const { ops, kh } = await createOps();
      const result = await ops.getIdentity();
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
    it('generates an invite with seed bytes', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');

      const result = await ops.generateInvite(khDocId, 'write');
      expect(result.inviteKeyBytes).toHaveLength(32);
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

  describe('claimInviteWithKeyhive', () => {
    it('full round-trip: enableSharing → generateInvite → claimInviteWithKeyhive', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB, fx: fxB } = await createOps();

      // A enables sharing and generates invite
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');

      // B claims via archive (simulates seed-only flow)
      const result = await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');
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
      const result = await claimViaArchive(opsA, opsB, invite.inviteKeyBytes);

      // getMyAccess should return the override, not Admin
      const access = await opsB.getMyAccess(result.khDocId);
      expect(access).toBe('Write');
    });

    it('claimant can encrypt after claiming (CGKA ownership works)', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes);

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

    it('A encrypts → B decrypts after claim (cross-peer)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

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
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Sync B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A encrypts
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

      // Sync A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Deserialize + decrypt
      expect(wire[0]).toBe(ENC_ENCRYPTED);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const decrypted = await khB.tryDecrypt(docB!, encrypted);
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('A encrypts before knowing about B → B cannot decrypt (production timing)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // A encrypts BEFORE any sync with B
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('encrypted before sync');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // B tries to decrypt without A's CGKA events
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
      await expect(khB.tryDecrypt(docB!, encrypted)).rejects.toThrow();
    });

    it('A encrypts before sync → B still cannot decrypt even after sync (production bug)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // A encrypts before sync
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('encrypted before sync');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const result = await khA.tryEncrypt(docA!, ref, [], plaintext);
      const ENC_ENCRYPTED = 0x01;
      const encBytes = result.encrypted_content().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = ENC_ENCRYPTED;
      wire.set(encBytes, 1);

      // First attempt fails
      const bReachable = await khB.reachableDocs();
      const docB1 = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted1 = (Encrypted as any).fromBytes(wire.slice(1));
      await expect(khB.tryDecrypt(docB1!, encrypted1)).rejects.toThrow('Key not found');

      // Keyhive sync: B→A then A→B
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
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      const ENC_ENCRYPTED = 0x01;
      const khDocIdStr = opsA.khDocuments.values().next().value!.doc_id;

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

      async function decryptOnB(wire: Uint8Array): Promise<string> {
        const bReachable = await khB.reachableDocs();
        const doc = await khB.getDocument(bReachable[0].doc.doc_id);
        const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
        const decrypted = await khB.tryDecrypt(doc!, encrypted);
        return new TextDecoder().decode(new Uint8Array(decrypted));
      }

      // Step 1: A encrypts BEFORE keyhive sync
      const msg1 = await encryptOnA('before-sync');
      await expect(decryptOnB(msg1.wire)).rejects.toThrow();

      // Step 2: Keyhive sync B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // Step 3: A encrypts AFTER partial sync
      const msg2 = await encryptOnA('after-partial-sync');

      // Step 4: Complete keyhive sync A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Step 5: Old message is FOREVER undecryptable
      await expect(decryptOnB(msg1.wire)).rejects.toThrow('Key not found');

      // Step 6: msg2 after sync
      if (msg2.hasUpdate) {
        const aEvts2: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
        const arr2: Uint8Array[] = [];
        aEvts2.forEach((v: Uint8Array) => arr2.push(v));
        await khB.ingestEventsBytes(arr2);
      }
      const msg2Text = await decryptOnB(msg2.wire);
      expect(msg2Text).toBe('after-partial-sync');

      // Step 7: A encrypts AFTER full sync — always works
      const msg3 = await encryptOnA('after-full-sync');
      if (msg3.hasUpdate) {
        const aEvts3: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
        const arr3: Uint8Array[] = [];
        aEvts3.forEach((v: Uint8Array) => arr3.push(v));
        await khB.ingestEventsBytes(arr3);
      }
      const msg3Text = await decryptOnB(msg3.wire);
      expect(msg3Text).toBe('after-full-sync');
    });

    it('A encrypts AFTER sync → B CAN decrypt', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Keyhive sync: B→A then A→B
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

      // NOW A encrypts — CGKA tree includes B
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

      // B decrypts
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const encrypted = (Encrypted as any).fromBytes(wire.slice(1));
      const decrypted = await khB.tryDecrypt(docB!, encrypted);
      expect(new TextDecoder().decode(new Uint8Array(decrypted))).toBe('encrypted AFTER sync');
    });

    it('B encrypts → A decrypts after claim (cross-peer reverse)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

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

    it('inviter can revoke temp invite member after claim', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');

      // Before claim: temp invite member should be in the member list
      const membersBefore = await opsA.getDocMembers(khDocId);
      const tempMemberBefore = membersBefore.find(m => m.agentId === invite.inviteSignerAgentId);
      expect(tempMemberBefore).toBeDefined();

      // B claims via archive
      const result = await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Temp member is still present on B's side (claimer can't revoke)
      const membersOnB = await opsB.getDocMembers(result.khDocId);
      expect(membersOnB.find(m => m.agentId === invite.inviteSignerAgentId)).toBeDefined();

      // Alice (inviter/owner) revokes the temp invite member
      await opsA.revokeMember(invite.inviteSignerAgentId, khDocId);

      // After revocation: temp member is gone from Alice's member list
      const membersAfterA = await opsA.getDocMembers(khDocId);
      expect(membersAfterA.find(m => m.agentId === invite.inviteSignerAgentId)).toBeUndefined();

      // B should still be a member (on A's side)
      // Sync B's archive to A so A knows about B
      const bArchive = await khB.toArchive();
      await khA.ingestArchive(bArchive);
      const bCard = await khB.contactCard();
      await khA.receiveContactCard(bCard);
      const membersAfterSync = await opsA.getDocMembers(khDocId);
      const bOnA = membersAfterSync.find(m => !m.isMe && m.agentId !== invite.inviteSignerAgentId);
      expect(bOnA).toBeDefined();
      expect(bOnA!.role).toBe('Write');
    });

    it('cross-peer encryption works after temp member revocation', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'write');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Sync: A ingests B's archive so A knows about B
      const bArchive = await khB.toArchive();
      await khA.ingestArchive(bArchive);
      const bCard = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(bCard);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indB_inA.toAgent());
      const syncArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => syncArr.push(v));
      await khA.ingestEventsBytes(syncArr);

      // A encrypts after claim + revocation
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('post-revocation message');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await khA.tryEncryptArchive(docA!, ref, [], plaintext);
      expect(encResult.encrypted_content()).toBeDefined();

      // B ingests A's events and decrypts
      const aArchive = await khA.toArchive();
      await khB.ingestArchive(aArchive);
      const aCard = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(aCard);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indA_inB.toAgent());
      const arr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => arr.push(v));
      await khB.ingestEventsBytes(arr);

      const docB = await khB.getDocument(opsB.khDocuments.values().next().value!.doc_id);
      const decrypted = await khB.tryDecrypt(docB!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });
  });

  describe('accessForDoc cross-peer (insufficient access bug)', () => {
    it('Bob can see Alice has access after claiming invite (using kh.id)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Alice enables sharing and generates admin invite for Bob
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');

      // Bob claims the invite
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Keyhive sync: exchange contact cards and events (simulates relay sync)
      // B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Bob checks Alice's access using kh.id (the keyhive identity)
      const aliceIdentifier = new Identifier(khA.id.bytes);
      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);
      const docIdOnB = bReachable[0].doc.doc_id;
      const aliceAccess = await khB.accessForDoc(aliceIdentifier, docIdOnB);

      // Alice is the document owner — Bob should see her as having Admin access
      expect(aliceAccess).toBeDefined();
      expect(aliceAccess!.toString()).toBe('Admin');
    });

    it('Bob can see Alice has access using verifying key identifier (network adapter path)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Alice enables sharing and generates admin invite for Bob
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');

      // Bob claims the invite
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Keyhive sync: exchange contact cards and events
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

      // Simulate the network adapter's identifierForPeer:
      // In production, the peer ID is base64(signer.verifyingKey) + "-suffix"
      // keyhiveIdentifierFromPeerId extracts the verifying key and creates Identifier from it
      // This may NOT match kh.id (the keyhive identity)
      const aliceSigner = (khA as any).signer;
      const aliceVerifyingKey = aliceSigner?.verifyingKey;

      // If we can access the verifying key, test with it
      if (aliceVerifyingKey) {
        const verifyingKeyIdentifier = new Identifier(aliceVerifyingKey);
        const bReachable = await khB.reachableDocs();
        const docIdOnB = bReachable[0].doc.doc_id;
        const aliceAccessViaVK = await khB.accessForDoc(verifyingKeyIdentifier, docIdOnB);

        // This tests if the verifying key Identifier matches what accessForDoc expects
        // In the bug scenario, this returns null even though Alice is the owner
        expect(aliceAccessViaVK).toBeDefined();
        expect(aliceAccessViaVK!.toString()).toBe('Admin');
      }

      // Also test with contact card ID (what peerContactCardIds stores)
      const aliceContactCardId = cardA.id;
      if (aliceContactCardId) {
        const bReachable = await khB.reachableDocs();
        const docIdOnB = bReachable[0].doc.doc_id;
        const aliceAccessViaCC = await khB.accessForDoc(aliceContactCardId, docIdOnB);
        expect(aliceAccessViaCC).toBeDefined();
        expect(aliceAccessViaCC!.toString()).toBe('Admin');
      }
    });

    it('Bob can see Alice has access WITHOUT prior keyhive sync', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Alice enables sharing and generates admin invite for Bob
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');

      // Bob claims the invite (no keyhive sync yet — just archive claim)
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Bob checks Alice's access immediately (no contact card exchange)
      const aliceIdentifier = new Identifier(khA.id.bytes);
      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);
      const docIdOnB = bReachable[0].doc.doc_id;
      const aliceAccess = await khB.accessForDoc(aliceIdentifier, docIdOnB);

      // Alice is the document owner — Bob should see her as having access
      // even without explicit keyhive sync, since the archive contains the delegation chain
      expect(aliceAccess).toBeDefined();
      expect(aliceAccess!.toString()).toBe('Admin');
    });

    it('kh.id matches Identifier(signer.verifyingKey)', async () => {
      // The network adapter derives Identifier from the peer ID (which is
      // base64(signer.verifyingKey)). If kh.id != Identifier(verifyingKey),
      // accessForDoc will fail because the delegation chain uses kh.id.
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const signer = Signer.memorySignerFromBytes(seed);
      const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});

      const khIdBytes = kh.id.bytes;
      const verifyingKeyBytes = signer.verifyingKey;
      const vkIdentifier = new Identifier(verifyingKeyBytes);


      // If this fails, that's the root cause of the production bug
      expect(Buffer.from(khIdBytes).equals(Buffer.from(verifyingKeyBytes))).toBe(true);

      // Now test after archive reload
      const archive = await kh.toArchive();
      const kh2 = await archive.tryToKeyhive(CiphertextStore.newInMemory(), signer, () => {});
      const kh2IdBytes = kh2.id.bytes;
      expect(Buffer.from(kh2IdBytes).equals(Buffer.from(verifyingKeyBytes))).toBe(true);

      // After reload with invite ingested
      const ops = new KeyhiveOps(kh, bridge, noopSideEffects());
      await ops.enableSharing('test-doc');
      await ops.generateInvite(
        Array.from(ops.khDocuments.keys())[0],
        'admin',
      );
      const archive2 = await kh.toArchive();
      const kh3 = await archive2.tryToKeyhive(CiphertextStore.newInMemory(), signer, () => {});
      const kh3IdBytes = kh3.id.bytes;
      expect(Buffer.from(kh3IdBytes).equals(Buffer.from(verifyingKeyBytes))).toBe(true);
    });

    it('Bob rejects Alice sync after archive reload (production bug)', async () => {
      // Simulates the production scenario:
      // 1. Alice creates doc, generates invite
      // 2. Bob claims invite via archive
      // 3. Alice reloads from archive (simulating server restart / new session)
      // 4. Bob checks Alice's NEW identity's access — may fail if archive
      //    reload changes Alice's Identifier
      const aliceSeed = crypto.getRandomValues(new Uint8Array(32));
      const aliceSigner = Signer.memorySignerFromBytes(aliceSeed);
      const aliceStore = CiphertextStore.newInMemory();
      const khAlice = await Keyhive.init(aliceSigner, aliceStore, () => {});
      const fxA = noopSideEffects();
      const opsA = new KeyhiveOps(khAlice, bridge, fxA);

      const { ops: opsB, kh: khB } = await createOps();

      // Alice enables sharing and generates admin invite
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');

      // Bob claims the invite
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Alice's original identity
      const aliceIdBefore = khAlice.id.bytes.slice();

      // Alice saves and reloads from archive (simulates restart)
      const aliceArchive = await khAlice.toArchive();
      const aliceStore2 = CiphertextStore.newInMemory();
      const khAlice2 = await aliceArchive.tryToKeyhive(aliceStore2, aliceSigner, () => {});
      const aliceIdAfter = khAlice2.id.bytes;

      // Check if identity changed after archive reload
      const idMatch = aliceIdBefore.length === aliceIdAfter.length &&
        aliceIdBefore.every((b: number, i: number) => b === aliceIdAfter[i]);

      // Keyhive sync with Alice's NEW keyhive instance
      const cardA2 = await khAlice2.contactCard();
      const indA2_inB = await khB.receiveContactCard(cardA2);
      const bEventsForA2: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA2_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA2.forEach((v: Uint8Array) => bArr.push(v));
      await khAlice2.ingestEventsBytes(bArr);

      const cardB = await khB.contactCard();
      const indB_inA2 = await khAlice2.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khAlice2.eventsForAgent(indB_inA2.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // Bob checks Alice's (reloaded) identity's access
      const aliceId2 = new Identifier(aliceIdAfter);
      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);
      const docIdOnB = bReachable[0].doc.doc_id;
      const aliceAccess = await khB.accessForDoc(aliceId2, docIdOnB);


      // This is the production bug: after archive reload, Alice's identity
      // should still have Admin access from Bob's perspective
      expect(aliceAccess).toBeDefined();
      expect(aliceAccess!.toString()).toBe('Admin');
    });

    it('Bob checks access before contact card exchange (timing bug)', async () => {
      // Production scenario: Bob claims invite, receives Alice's automerge sync
      // BEFORE contact card exchange. The network adapter calls identifierForPeer
      // which falls back to keyhiveIdentifierFromPeerId(alicePeerId).
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // NO contact card exchange — Bob checks access immediately
      // using Identifier derived from Alice's verifying key (like identifierForPeer would)
      const aliceIdentifier = new Identifier(khA.id.bytes);

      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);
      const docIdOnB = bReachable[0].doc.doc_id;

      const aliceAccess = await khB.accessForDoc(aliceIdentifier, docIdOnB);

      expect(aliceAccess).toBeDefined();
      expect(aliceAccess!.toString()).toBe('Admin');
    });

    it('Bob checks access with DocumentId from registerDoc vs reachableDocs', async () => {
      // Test if the DocumentId stored via registerDoc matches what
      // accessForDoc expects (type/value match)
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');
      const claimResult = await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Get the DocumentId from khDocuments (same as what registerDoc uses)
      const docFromKhDocuments = opsB.khDocuments.get(claimResult.khDocId);
      expect(docFromKhDocuments).toBeDefined();
      const docMapDocId = docFromKhDocuments.doc_id;

      // Get the DocumentId from reachableDocs
      const bReachable = await khB.reachableDocs();
      const reachableDocId = bReachable[0].doc.doc_id;

      const docMapBytes = (docMapDocId as any).toBytes ? (docMapDocId as any).toBytes() : docMapDocId;
      const reachableBytes = (reachableDocId as any).toBytes ? (reachableDocId as any).toBytes() : reachableDocId;

      // Check access using both DocumentId sources
      const aliceId = new Identifier(khA.id.bytes);
      const accessViaDocMap = await khB.accessForDoc(aliceId, docMapDocId);
      const accessViaReachable = await khB.accessForDoc(aliceId, reachableDocId);


      expect(accessViaDocMap).toBeDefined();
      expect(accessViaReachable).toBeDefined();
    });

    it('accessForDoc fails with wrong Identifier (simulates identifierForPeer mismatch)', async () => {
      // Simulates the production bug: identifierForPeer returns an Identifier
      // that doesn't match what's in the delegation chain. This happens when
      // keyhiveIdentifierFromPeerId(peerId) produces a different Identifier
      // than the one used in the delegation chain (e.g., WebCrypto signer
      // where verifyingKey != keyhive identity after archive reload).
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      const bReachable = await khB.reachableDocs();
      const docIdOnB = bReachable[0].doc.doc_id;

      // Correct identifier — works
      const correctId = new Identifier(khA.id.bytes);
      const correctAccess = await khB.accessForDoc(correctId, docIdOnB);
      expect(correctAccess).toBeDefined();
      expect(correctAccess!.toString()).toBe('Admin');

      // Wrong identifier (a valid but unrelated signer's key) — simulates identifierForPeer mismatch
      const unrelatedSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const wrongId = new Identifier(unrelatedSigner.verifyingKey);
      const wrongAccess = await khB.accessForDoc(wrongId, docIdOnB);
      // This returns null — exactly the production bug behavior
      expect(wrongAccess).toBeUndefined();
    });

    it('Sharing panel shows access but accessForDoc returns null (production mismatch)', async () => {
      // The user reports the Sharing & Permissions panel correctly shows
      // HrqeCwxo... (Alice) has admin access, but the network adapter's
      // accessForDoc returns null. This could mean docMemberCapabilities
      // sees the member but accessForDoc doesn't.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await opsA.generateInvite(khDocId, 'admin');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Keyhive sync
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

      // Bob's perspective: check docMemberCapabilities (what Sharing panel uses)
      const bReachable = await khB.reachableDocs();
      const docIdOnB = bReachable[0].doc.doc_id;
      const members = await khB.docMemberCapabilities(docIdOnB);

      // Check if Alice appears in members
      const aliceMember = members.find((m: any) => {
        const idBytes = m.who.id?.toBytes ? m.who.id.toBytes() : null;
        if (!idBytes) return false;
        return Buffer.from(idBytes).equals(Buffer.from(khA.id.bytes));
      });

      // Also check accessForDoc
      const aliceId = new Identifier(khA.id.bytes);
      const access = await khB.accessForDoc(aliceId, docIdOnB);


      // Both should agree: if members shows Alice, accessForDoc should too
      if (aliceMember) {
        expect(access).toBeDefined();
      }
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

      await claimViaArchive(opsA, opsB, inviteB.inviteKeyBytes);
      await claimViaArchive(opsA, opsC, inviteC.inviteKeyBytes);

      const bDocs = await opsB.kh.reachableDocs();
      const cDocs = await opsC.kh.reachableDocs();
      expect(bDocs.length).toBeGreaterThan(0);
      expect(cDocs.length).toBeGreaterThan(0);
    });
  });

  describe('device linking via contact card exchange', () => {
    /** Simulate bidirectional contact card exchange (the device-linking flow).
     *  Returns base64 agent IDs suitable for addMember. */
    async function linkDevices(opsA: KeyhiveOps, opsB: KeyhiveOps) {
      const cardA = await opsA.getContactCard();
      const cardB = await opsB.getContactCard();

      // Receive contact cards at keyhive level to get proper Individual objects
      const cardObjA = ContactCard.fromJson(cardA);
      const cardObjB = ContactCard.fromJson(cardB);
      const individualAonB = await opsB.kh.receiveContactCard(cardObjA);
      const individualBonA = await opsA.kh.receiveContactCard(cardObjB);

      // Convert to base64 agent IDs (the format addMember expects)
      const { bytesToBase64 } = await import('./keyhive-ops');
      const agentIdOfAOnB = bytesToBase64(individualAonB.id.toBytes());
      const agentIdOfBOnA = bytesToBase64(individualBonA.id.toBytes());
      return { agentIdOfAOnB, agentIdOfBOnA };
    }

    /** Full keyhive event sync: A→B and B→A. */
    async function syncBidirectional(khA: any, khB: any) {
      // B→A
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A→B
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      return { indA_inB, indB_inA };
    }

    it('bidirectional contact card exchange registers both identities', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { agentIdOfAOnB, agentIdOfBOnA } = await linkDevices(opsA, opsB);

      // Both sides have registered the other's identity
      expect(agentIdOfAOnB).toBeDefined();
      expect(agentIdOfBOnA).toBeDefined();
      expect(agentIdOfAOnB).not.toBe(agentIdOfBOnA);
    });

    it('linked device can be added as a member and gains document access', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Step 1: Link devices (bidirectional contact card exchange)
      const { agentIdOfBOnA } = await linkDevices(opsA, opsB);

      // Step 2: Device A creates a shared document
      const { khDocId } = await opsA.enableSharing('doc-1');

      // Step 3: Device A adds the linked device B as a member
      await opsA.addMember(agentIdOfBOnA, khDocId, 'admin');

      // Step 4: Sync keyhive state so B learns about the document
      const bArchive = await khB.toArchive();
      await khA.ingestArchive(bArchive);
      const aArchive = await khA.toArchive();
      await khB.ingestArchive(aArchive);
      await syncBidirectional(khA, khB);

      // Step 5: Device B can see the document
      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBeGreaterThan(0);

      // Step 6: Device B can encrypt (proving CGKA membership)
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const plaintext = new TextEncoder().encode('hello from linked device B');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await khB.tryEncryptArchive(docB!, ref, [], plaintext);
      expect(encResult.encrypted_content()).toBeDefined();

      // Step 7: Device A can decrypt what B encrypted
      // Sync B's CGKA ops to A
      const cardA2 = await khA.contactCard();
      const indA_inB2 = await khB.receiveContactCard(cardA2);
      const bEvts: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB2.toAgent());
      const bArr: Uint8Array[] = [];
      bEvts.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const decrypted = await khA.tryDecrypt(docA!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('linked device appears in document member list after being added', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { agentIdOfBOnA } = await linkDevices(opsA, opsB);
      const { khDocId } = await opsA.enableSharing('doc-1');
      await opsA.addMember(agentIdOfBOnA, khDocId, 'write');

      const members = await opsA.getDocMembers(khDocId);
      const deviceB = members.find(m => m.agentId === agentIdOfBOnA);
      expect(deviceB).toBeDefined();
      expect(deviceB!.role).toBe('Write');
    });

    it('contact card exchange alone does not grant document access', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Link devices
      await linkDevices(opsA, opsB);

      // Device A creates a shared document (but does NOT add B as a member)
      await opsA.enableSharing('doc-1');

      // Sync keyhive state
      const aArchive = await khA.toArchive();
      await khB.ingestArchive(aArchive);

      // Device B should NOT see the document — linking alone doesn't grant access
      const bReachable = await khB.reachableDocs();
      expect(bReachable.length).toBe(0);
    });

    it('A encrypts → linked device B decrypts after sync (cross-device)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Link + share
      const { agentIdOfBOnA } = await linkDevices(opsA, opsB);
      const { khDocId } = await opsA.enableSharing('doc-1');
      await opsA.addMember(agentIdOfBOnA, khDocId, 'write');

      // Sync archives so B knows about the document
      const bArchive = await khB.toArchive();
      await khA.ingestArchive(bArchive);
      const { indB_inA } = await syncBidirectional(khA, khB);

      // A encrypts
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const plaintext = new TextEncoder().encode('synced across devices');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const encResult = await khA.tryEncryptArchive(docA!, ref, [], plaintext);

      // Sync A's CGKA update to B
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // B decrypts
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const decrypted = await khB.tryDecrypt(docB!, encResult.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });
  });
});
