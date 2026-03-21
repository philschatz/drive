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
import { KeyhiveOps, KeyhiveBridge, KeyhiveOpsSideEffects, bytesToBase64 } from './keyhive-ops';

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

    it('returns a JSON string suitable for URL encoding (not [object Object])', async () => {
      const { ops } = await createOps();
      const cardJson = await ops.getContactCard();

      // Must be a string, not an object
      expect(typeof cardJson).toBe('string');

      // Must be valid parseable JSON
      const parsed = JSON.parse(cardJson);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe('object');

      // TextEncoder.encode must not produce "[object Object]"
      // (this is the bug: if toJson() returns an object, encode() stringifies it)
      const encoded = new TextDecoder().decode(new TextEncoder().encode(cardJson));
      expect(encoded).not.toBe('[object Object]');
      expect(encoded).toBe(cardJson);
    });

    it('raw card.toJson() is handled correctly regardless of return type', async () => {
      const { kh } = await createOps();
      const card = await kh.contactCard();
      const rawJson = card.toJson();

      // Document what the WASM binding actually returns
      // (it may be a string or an object depending on the binding version)
      if (typeof rawJson === 'string') {
        // If it's a string, it must be valid JSON
        expect(() => JSON.parse(rawJson)).not.toThrow();
      } else {
        // If it's an object, JSON.stringify must not produce "[object Object]"
        const stringified = JSON.stringify(rawJson);
        expect(stringified).not.toBe('[object Object]');
        expect(() => JSON.parse(stringified)).not.toThrow();
      }
    });

    it('detects own contact card', async () => {
      const { ops, fx } = await createOps();
      const cardJson = await ops.getContactCard();
      const result = await ops.receiveContactCard(cardJson);
      expect(result.isOwnCard).toBe(true);
      expect(result.agentId).toBeDefined();
      expect(result.agentId).not.toBe('[object Object]');
      // Should not persist when own card
      expect(fx.calls.persist.length).toBe(0);
    });

    it('does not flag other contact cards as own', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB, fx: fxB } = await createOps();
      const cardJson = await opsA.getContactCard();
      const result = await opsB.receiveContactCard(cardJson);
      expect(result.isOwnCard).toBe(false);
      expect(result.agentId).toBeDefined();
      expect(result.agentId).not.toBe('[object Object]');
      // Should persist when not own card
      expect(fxB.calls.persist.length).toBe(1);
    });

    it('contact card survives deflate/inflate round-trip (URL encoding path)', async () => {
      // This tests the exact path used by encodeCardForUrl / decodeCardFromUrl
      // in AddFriendPage and LinkDevicePage
      const pako = await import('pako');
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const cardJson = await opsA.getContactCard();

      // Simulate encodeCardForUrl: TextEncoder → deflate → base64url
      const compressed = pako.deflate(new TextEncoder().encode(cardJson));
      let b64 = '';
      for (let i = 0; i < compressed.length; i++) b64 += String.fromCharCode(compressed[i]);
      const b64url = btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      // Simulate decodeCardFromUrl: base64url → inflate → TextDecoder
      const b64standard = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(b64standard);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const decompressed = new TextDecoder().decode(pako.inflate(bytes));

      // Must survive the round-trip exactly
      expect(decompressed).toBe(cardJson);
      expect(decompressed).not.toContain('[object Object]');

      // Must still be receivable after the round-trip
      const result = await opsB.receiveContactCard(decompressed);
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

  describe('device linking', () => {
    /**
     * Simulate the device-linking flow: bidirectional contact card exchange
     * + full archive sync, so both keyhive instances know about each other.
     */
    async function linkDevices(khA: any, khB: any) {
      // Bidirectional contact card exchange
      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      const individualAonB = await khB.receiveContactCard(cardA);
      const individualBonA = await khA.receiveContactCard(cardB);

      // Grant B access to all of A's documents (and vice-versa)
      const aDocs = await khA.reachableDocs();
      for (const item of aDocs) {
        await khA.addMember(individualBonA.toAgent(), item.doc.toMembered(), item.access, []);
      }
      const bDocs = await khB.reachableDocs();
      for (const item of bDocs) {
        await khB.addMember(individualAonB.toAgent(), item.doc.toMembered(), item.access, []);
      }

      // Full archive sync so both sides have the complete picture
      const archiveA = await khA.toArchive();
      const archiveB = await khB.toArchive();
      await khB.ingestArchive(archiveA);
      await khA.ingestArchive(archiveB);

      // Event sync
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(individualBonA.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(individualAonB.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      return { individualAonB, individualBonA };
    }

    it('after linking, both devices see the same documents with the same access', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Device A creates two documents before linking
      const doc1 = await opsA.enableSharing('automerge-doc-1');
      const doc2 = await opsA.enableSharing('automerge-doc-2');

      // Link devices (bidirectional contact card exchange + sync)
      await linkDevices(khA, khB);

      // Both devices should see the same set of reachable documents
      const aDocs = await khA.reachableDocs();
      const bDocs = await khB.reachableDocs();
      expect(aDocs.length).toBe(bDocs.length);

      // Both should have the same access level on every document
      const aId = new Identifier(khA.id.bytes);
      const bId = new Identifier(khB.id.bytes);
      for (const aDoc of aDocs) {
        const docId = aDoc.doc.doc_id;
        const aAccess = await khA.accessForDoc(aId, docId);
        const bAccess = await khB.accessForDoc(bId, docId);
        expect(aAccess).not.toBeNull();
        expect(bAccess).not.toBeNull();
        expect(bAccess!.toString()).toBe(aAccess!.toString());
      }
    });

    it('document created after linking is also visible to both devices', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Link first
      await linkDevices(khA, khB);

      // Then device A creates a document and grants B access
      await opsA.enableSharing('automerge-doc-1');
      const cardB = await khB.contactCard();
      const individualBonA = await khA.receiveContactCard(cardB);
      const aDocs2 = await khA.reachableDocs();
      for (const item of aDocs2) {
        const bId = new Identifier(individualBonA.id.toBytes());
        const existing = await khA.accessForDoc(bId, item.doc.doc_id);
        if (!existing) {
          await khA.addMember(individualBonA.toAgent(), item.doc.toMembered(), item.access, []);
        }
      }

      // Re-sync so B learns about the new doc
      const archiveA = await khA.toArchive();
      await khB.ingestArchive(archiveA);

      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const aEvts: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indA_inB.toAgent());
      const arr: Uint8Array[] = [];
      aEvts.forEach((v: Uint8Array) => arr.push(v));
      await khB.ingestEventsBytes(arr);

      // Both devices should see it with the same access
      const aDocs = await khA.reachableDocs();
      const bDocs = await khB.reachableDocs();
      expect(aDocs.length).toBe(1);
      expect(bDocs.length).toBe(1);

      const aId = new Identifier(khA.id.bytes);
      const bId = new Identifier(khB.id.bytes);
      const aAccess = await khA.accessForDoc(aId, aDocs[0].doc.doc_id);
      const bAccess = await khB.accessForDoc(bId, bDocs[0].doc.doc_id);
      expect(bAccess!.toString()).toBe(aAccess!.toString());
    });

    it('linked device can encrypt and the other can decrypt', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      await opsA.enableSharing('automerge-doc-1');
      const { individualAonB } = await linkDevices(khA, khB);

      // B encrypts on a doc it gained access to via linking
      const bDocs = await khB.reachableDocs();
      expect(bDocs.length).toBe(1);
      const docB = await khB.getDocument(bDocs[0].doc.doc_id);
      const plaintext = new TextEncoder().encode('written on device B');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const enc = await khB.tryEncryptArchive(docB!, ref, [], plaintext);

      // Sync B's CGKA ops to A
      const bEvts: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(individualAonB.toAgent());
      const arr: Uint8Array[] = [];
      bEvts.forEach((v: Uint8Array) => arr.push(v));
      await khA.ingestEventsBytes(arr);

      // A decrypts
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const decrypted = await khA.tryDecrypt(docA!, enc.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });
  });

  describe('direct add member (no invite link)', () => {
    /**
     * Simulate the idFactory: generate a keyhive document and use its doc_id
     * bytes as the "automerge document ID". This mirrors what keyhiveIdFactory
     * does when the secure repo creates a document.
     */
    async function createDocWithIdFactory(kh: any): Promise<{ automergeDocIdBytes: Uint8Array }> {
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const g = await kh.generateGroup([]);
      const doc = await kh.generateDocument([g.toPeer()], ref, []);
      return { automergeDocIdBytes: doc.doc_id.toBytes() };
    }

    /**
     * Simulate the "add friend then add member" flow with idFactory:
     * 1. Alice creates a document (idFactory makes automerge docId = keyhive docId)
     * 2. Alice enables sharing (reuses the existing keyhive doc)
     * 3. Alice and Bob exchange contact cards (add friend)
     * 4. Alice adds Bob as a member via addMember (not invite link)
     * 5. Alice syncs keyhive to Bob (archive + events)
     */
    async function addFriendAndMember(opts: {
      opsA: KeyhiveOps; khA: any;
      opsB: KeyhiveOps; khB: any;
      automergeDocId: string;
      automergeDocIdBytes: Uint8Array;
      role?: string;
    }) {
      const { opsA, khA, opsB, khB, automergeDocId, automergeDocIdBytes, role = 'write' } = opts;

      // Alice enables sharing — pass existing doc bytes so it reuses the
      // keyhive doc created by the idFactory instead of generating a duplicate.
      const { khDocId } = await opsA.enableSharing(automergeDocId, automergeDocIdBytes);

      // Bidirectional contact card exchange (add friend)
      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      const indBonA = await khA.receiveContactCard(cardB);
      await khB.receiveContactCard(cardA);

      // Alice adds Bob as member via the direct addMember path
      const bobAgentId = bytesToBase64(indBonA.id.toBytes());
      await opsA.addMember(bobAgentId, khDocId, role);

      // Sync keyhive state from Alice → Bob (simulates network sync)
      const archiveA = await khA.toArchive();
      await khB.ingestArchive(archiveA);

      const indAonB = await khB.receiveContactCard(cardA);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indAonB.toAgent());
      const arr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => arr.push(v));
      await khB.ingestEventsBytes(arr);

      return { khDocId, bobAgentId };
    }

    it('after sync, Bob can discover the document via reachableDocs', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocWithIdFactory(khA);
      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-1',
        automergeDocIdBytes,
      });

      const bDocs = await khB.reachableDocs();
      expect(bDocs.length).toBeGreaterThan(0);
    });

    it('enableSharing reuses existing keyhive doc from idFactory', async () => {
      const { ops, kh } = await createOps();

      // Simulate idFactory creating a keyhive doc
      const { automergeDocIdBytes } = await createDocWithIdFactory(kh);

      // enableSharing should find the existing doc, not create a new one
      const docsBefore = await kh.reachableDocs();
      const { khDocId } = await ops.enableSharing('am-doc-1', automergeDocIdBytes);
      const docsAfter = await kh.reachableDocs();

      // Should not have created an additional document
      expect(docsAfter.length).toBe(docsBefore.length);

      // khDocuments should contain the doc
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });

    it('enableSharing falls back to creating a new doc when bytes do not match', async () => {
      const { ops, kh } = await createOps();

      // Pass random bytes that don't correspond to any keyhive document
      // (simulates an insecure-repo doc being upgraded to shared)
      const fakeBytes = crypto.getRandomValues(new Uint8Array(32));
      const docsBefore = await kh.reachableDocs();
      const { khDocId } = await ops.enableSharing('am-doc-1', fakeBytes);
      const docsAfter = await kh.reachableDocs();

      // Should have created a new document
      expect(docsAfter.length).toBe(docsBefore.length + 1);
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });

    it('enableSharing without existingDocIdBytes creates a new doc (legacy path)', async () => {
      const { ops, kh } = await createOps();

      const docsBefore = await kh.reachableDocs();
      const { khDocId } = await ops.enableSharing('am-doc-1');
      const docsAfter = await kh.reachableDocs();

      expect(docsAfter.length).toBe(docsBefore.length + 1);
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });

    it('Bob can find the keyhive doc from automerge docId when IDs match', async () => {
      // This is the fix: when the idFactory is used, automerge docId bytes =
      // keyhive doc_id bytes. Bob can look up the keyhive doc directly.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocWithIdFactory(khA);
      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-1',
        automergeDocIdBytes,
      });

      // Bob's keyhive knows about the document (via reachableDocs)
      const bDocs = await khB.reachableDocs();
      expect(bDocs.length).toBeGreaterThan(0);

      // Bob can look up the keyhive doc using the automerge doc ID bytes
      // (this is what the open-doc handler does via docIdFromAutomergeUrl)
      const khDocId = new DocumentId(automergeDocIdBytes);
      const doc = await khB.getDocument(khDocId);
      expect(doc).toBeDefined();

      // Bob can now register the mapping and access the document
      const khDocIdB64 = bytesToBase64(doc!.id.toBytes());
      opsB.khDocuments.set(khDocIdB64, doc);
      expect(opsB.khDocuments.size).toBe(1);

      // And check access
      const bobId = new Identifier(khB.id.bytes);
      const access = await khB.accessForDoc(bobId, doc!.doc_id);
      expect(access).toBeDefined();
      expect(access!.toString()).toBe('Write');
    });
  });
});
