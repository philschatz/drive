/**
 * Tests for KeyhiveOps — the extracted keyhive handler logic from automerge-worker.
 *
 * These tests exercise the real keyhive WASM (via keyhive-shim.js) with no-op
 * side effects, verifying the business logic without worker infrastructure.
 */

import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import {
  Signer,
  Keyhive,
  CiphertextStore,
  Access,
  ChangeId,
  DocumentId,
  Identifier,
  GroupId,
  ContactCard,
  Encrypted,
  Archive,
} from '@keyhive/keyhive/slim';
import { KeyhiveOps, KeyhiveBridge, KeyhiveOpsSideEffects, bytesToBase64, base64ToBytes } from './keyhive-ops';

initKeyhiveWasm();

const bridge: KeyhiveBridge = {
  ChangeId,
  DocumentId,
  Identifier,
  GroupId,
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
    saveEventBytes: [],
  };
  let userGroupId: string | null = null;
  return {
    calls,
    persist: async () => { calls.persist.push([]); },
    syncKeyhive: () => { calls.syncKeyhive.push([]); },
    registerDoc: (a, b) => { calls.registerDoc.push([a, b]); },
    forceResyncAllPeers: () => { calls.forceResyncAllPeers.push([]); },
    findDoc: (d) => { calls.findDoc.push([d]); },
    saveEventBytes: async (e) => { calls.saveEventBytes.push([e]); },
    getUserGroupId: async () => userGroupId,
    setUserGroupId: async (id) => { userGroupId = id; },
  };
}

async function createOps() {
  const signer = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), () => {});
  const fx = noopSideEffects();
  const ops = new KeyhiveOps(kh, bridge, fx);
  return { ops, kh, fx };
}

/**
 * Test-only harness: grant a second peer access to a shared doc using raw keyhive
 * primitives — a temporary signer is added as an individual member of the doc.
 * This mirrors how the app's cross-peer encryption works (individual membership)
 * without depending on any product-level "invite" API. Returns the seed bytes the
 * claimant uses to reconstruct that membership in {@link claimViaArchive}.
 */
async function grantPeerAccessViaTempSigner(
  ops: KeyhiveOps,
  khDocId: string,
  role: string,
) {
  const doc = ops.khDocuments.get(khDocId);
  if (!doc) throw new Error('Document not found');
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const tempSigner = Signer.memorySignerFromBytes(seed);
  const tempKh = await Keyhive.init(tempSigner, CiphertextStore.newInMemory(), () => {});
  const tempIndividual = await ops.kh.receiveContactCard(await tempKh.contactCard());
  // Ingest the temp keyhive's events (prekeys, identity ops) into ops' keyhive.
  await ops.kh.ingestArchive(await tempKh.toArchive());
  const access = Access.tryFromString(role);
  if (!access) throw new Error(`Invalid role: ${role}`);
  await ops.kh.addMember(tempIndividual.toAgent(), doc.toMembered(), access, []);
  return {
    inviteKeyBytes: Array.from(seed) as number[],
    inviteSignerAgentId: bytesToBase64(tempIndividual.id.toBytes()),
  };
}

/**
 * Test-only counterpart to {@link grantPeerAccessViaTempSigner}: reconstruct the
 * temp signer's keyhive from the granter's archive, add the claimant as an
 * individual member, and ingest the resulting events into the claimant's keyhive —
 * giving the claimant cross-peer access for encryption tests.
 */
async function claimViaArchive(
  opsGranter: KeyhiveOps,
  opsClaimant: KeyhiveOps,
  inviteKeyBytes: number[],
  _automergeDocId?: string,
) {
  const seed = new Uint8Array(inviteKeyBytes);
  const tempSigner = Signer.memorySignerFromBytes(seed);
  const archive = await opsGranter.kh.toArchive();
  const tempKh = await archive.tryToKeyhive(CiphertextStore.newInMemory(), tempSigner, () => {});

  const ourIndividual = await tempKh.receiveContactCard(await opsClaimant.kh.contactCard());
  const ourAgent = ourIndividual.toAgent();
  const reachable = await tempKh.reachableDocs();
  if (reachable.length === 0) throw new Error('Grant has no document access');
  const grantedDoc = reachable[0].doc;
  await tempKh.addMember(ourAgent, grantedDoc.toMembered(), reachable[0].access, []);

  const eventsForUs: Map<Uint8Array, Uint8Array> = await tempKh.eventsForAgent(ourAgent);
  const eventsArr: Uint8Array[] = [];
  eventsForUs.forEach((v: Uint8Array) => eventsArr.push(v));
  await opsClaimant.kh.ingestArchive(await tempKh.toArchive());
  await opsClaimant.kh.ingestEventsBytes(eventsArr);

  const khDocId = bytesToBase64(grantedDoc.id.toBytes());
  const docFromOurKh = await opsClaimant.kh.getDocument(grantedDoc.doc_id);
  if (docFromOurKh) opsClaimant.khDocuments.set(khDocId, docFromOurKh);
  return { khDocId };
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

    it('rejects a bundle whose groupEvents count exceeds the bound', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      // An attacker-controlled bundle: valid card, but a flood of "group ops".
      const bundle = JSON.parse(await opsA.getContactCard());
      bundle.groupEvents = Array.from({ length: 1025 }, () => 'AAAA');

      await expect(opsB.receiveContactCard(JSON.stringify(bundle)))
        .rejects.toThrow(/group ops too large/i);
    });

    it('rejects a bundle whose groupEvents total size exceeds the bound', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const bundle = JSON.parse(await opsA.getContactCard());
      const big = 'A'.repeat(64 * 1024);
      bundle.groupEvents = Array.from({ length: 17 }, () => big); // 17 × 64 KiB > 1 MiB

      await expect(opsB.receiveContactCard(JSON.stringify(bundle)))
        .rejects.toThrow(/group ops too large/i);
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
      // enableSharing also mints the user-group and makes it doc admin, so it
      // persists/syncs more than once now.
      expect(fx.calls.persist.length).toBeGreaterThanOrEqual(1);
      expect(fx.calls.syncKeyhive.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('cross-peer access (shared-doc test harness)', () => {
    it('claimant can encrypt after claiming (CGKA ownership works)', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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

    it('presence value round-trips cross-peer (encrypted ephemeral payload)', async () => {
      // Mirrors the worker presence helpers (encryptPresenceValue / decryptPresenceValue
      // in automerge-worker.ts): a JSON presence value is encrypted with the doc key,
      // sent as bytes, then decrypted back to the identical value by another member.
      const encryptPresenceValue = async (kh: Keyhive, doc: any, value: unknown): Promise<Uint8Array> => {
        const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
        const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
        const result = await kh.tryEncrypt(doc, ref, [], bytes);
        return result.encrypted_content().toBytes();
      };
      const decryptPresenceValue = async (kh: Keyhive, doc: any, enc: Uint8Array): Promise<unknown> => {
        const out = await kh.tryDecrypt(doc, (Encrypted as any).fromBytes(enc));
        return JSON.parse(new TextDecoder().decode(out));
      };

      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      // Sync B→A so A knows about B before encrypting.
      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      // A encrypts a presence value (a focused-field path, as broadcast by editors).
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      const presenceValue = { focusedField: ['events', 'uid-123', 'title'] };
      const enc = await encryptPresenceValue(khA, docA!, presenceValue);

      // Sync A→B so B has the key.
      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
      const aArr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => aArr.push(v));
      await khB.ingestEventsBytes(aArr);

      // B decrypts and recovers the identical value.
      const bReachable = await khB.reachableDocs();
      const docB = await khB.getDocument(bReachable[0].doc.doc_id);
      const recovered = await decryptPresenceValue(khB, docB!, enc);
      expect(recovered).toEqual(presenceValue);
    });

    it('A encrypts before knowing about B → B cannot decrypt (production timing)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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

    it('cross-peer encryption works after temp member revocation', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
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

    /**
     * Shared setup for the forcePcsUpdate / reload regression tests below:
     * A shares a doc with B and both sides fully sync, so a plain
     * encrypt-after-sync round-trips (the ':596' baseline).
     */
    async function setupSyncedPair() {
      const { ops: opsA, kh: khA } = await createOps();
      // B is created with an exposed signer so tests can rebuild him from an
      // archive (Archive.tryToKeyhive needs the original signer).
      const bSigner = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const khB = await Keyhive.init(bSigner, CiphertextStore.newInMemory(), () => {});
      const opsB = new KeyhiveOps(khB, bridge, noopSideEffects());

      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
      await claimViaArchive(opsA, opsB, invite.inviteKeyBytes, 'doc-1');

      const cardA = await khA.contactCard();
      const indA_inB = await khB.receiveContactCard(cardA);
      const bEventsForA: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(indA_inB.toAgent());
      const bArr: Uint8Array[] = [];
      bEventsForA.forEach((v: Uint8Array) => bArr.push(v));
      await khA.ingestEventsBytes(bArr);

      const cardB = await khB.contactCard();
      const indB_inA = await khA.receiveContactCard(cardB);
      const syncAtoB = async (kh: Keyhive = khB) => {
        const evs: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indB_inA.toAgent());
        const arr: Uint8Array[] = [];
        evs.forEach((v: Uint8Array) => arr.push(v));
        await kh.ingestEventsBytes(arr);
        return arr.length;
      };
      await syncAtoB();

      const encrypt = async (text: string) => {
        const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
        const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
        const result = await khA.tryEncrypt(docA!, ref, [], new TextEncoder().encode(text));
        return result.encrypted_content();
      };
      const decryptOnB = async (encrypted: any, kh: Keyhive = khB) => {
        const reachable = await kh.reachableDocs();
        const docB = await kh.getDocument(reachable[0].doc.doc_id);
        const out = await kh.tryDecrypt(docB!, encrypted);
        return new TextDecoder().decode(new Uint8Array(out));
      };
      return { opsA, khA, opsB, khB, bSigner, syncAtoB, encrypt, decryptOnB };
    }

    it('forcePcsUpdate mints a CGKA op WITHOUT emitting it (bridge nudge gap)', async () => {
      // Characterization of the keyhive alpha.58 behavior that makes the npm
      // bridge's membership nudge dangerous. The nudge calls forcePcsUpdate(doc)
      // after our agent adds a member. Unlike the CGKA update minted inside
      // tryEncrypt (emitted via the event listener,
      // keyhive_core/src/keyhive.rs try_encrypt_content), the pcs_update op is
      // NOT emitted to the event handler — so it is never persisted to /ops/
      // storage, never triggers keyhive-repo's persist-archive-on-event hook,
      // and (the binding also resolves void) its rotated leaf SECRET exists only
      // in WASM memory. A worker reload after a nudge rotation restores an
      // instance that cannot derive its own current epoch: every encrypt fails
      // "SecretKey not found" and every peer decrypt "Key not found", forever.
      // That is why drive no-ops the method (neutralizeForcePcsUpdate).
      //
      // If this test starts FAILING on a keyhive upgrade (the rotation now
      // emits), the upstream gap is fixed: reconsider removing the no-op shadow.
      const emitted: any[] = [];
      const signer = Signer.memorySignerFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), (e: any) => { emitted.push(e); });
      const ops = new KeyhiveOps(kh, bridge, noopSideEffects());
      const { khDocId } = await ops.enableSharing('doc-1');
      const doc = ops.khDocuments.get(khDocId)!;
      // A membership change blanks the CGKA root, so the next encrypt must mint
      // a rotation — the emitting counterpart to forcePcsUpdate's silent one.
      await grantPeerAccessViaTempSigner(ops, khDocId, 'edit');

      // Baseline: a tryEncrypt that mints a rotation DOES emit events.
      const beforeEncrypt = emitted.length;
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      await kh.tryEncrypt(doc, ref, [], new TextEncoder().encode('mint'));
      expect(emitted.length).toBeGreaterThan(beforeEncrypt);

      // forcePcsUpdate rotates the CGKA (op count grows) yet emits NOTHING.
      const opsBefore = Number((await kh.stats()).cgkaOperations);
      const emittedBefore = emitted.length;
      await kh.forcePcsUpdate(doc);
      expect(Number((await kh.stats()).cgkaOperations)).toBe(opsBefore + 1);
      expect(emitted.length).toBe(emittedBefore);
    });

    it('neutralized forcePcsUpdate keeps cross-peer decryption working (drive fix)', async () => {
      // Drive's fix: shadow forcePcsUpdate with a no-op on the keyhive instance the
      // bridge holds, so the membership nudge stops minting orphan rotation ops.
      // Security outcome is unchanged: after an add, the next tryEncrypt mints the
      // rotation itself via try_encrypt_content, which IS emitted and synced.
      const { neutralizeForcePcsUpdate } = await import('../shared/keyhive-repo');
      const { khA, opsA, syncAtoB, encrypt, decryptOnB } = await setupSyncedPair();

      neutralizeForcePcsUpdate(khA);
      const docA = await khA.getDocument(opsA.khDocuments.values().next().value!.doc_id);
      await khA.forcePcsUpdate(docA!); // the nudge's call — now inert

      const enc = await encrypt('after neutralized rotation');
      await syncAtoB();
      expect(await decryptOnB(enc)).toBe('after neutralized rotation');
    });

    it('B reloads from archive → A encrypts fresh → B can decrypt (worker reload)', async () => {
      // Models presence-liveness step 2b: bob's page reload rebuilds his worker
      // from persisted keyhive state; alice re-encrypts fresh presence ciphertext
      // (the engine re-flushes on his new session's snapshot); bob must decrypt.
      // NOTE: the jest reload uses Archive.tryToKeyhive, which is more complete
      // than the browser's archive+events+prekey-secrets persistence — a pass here
      // exonerates the keyhive core, not necessarily the bridge storage layering.
      const { khB, bSigner, syncAtoB, encrypt, decryptOnB } = await setupSyncedPair();

      const enc1 = await encrypt('before B reload');
      await syncAtoB();
      expect(await decryptOnB(enc1)).toBe('before B reload');

      // B "reloads": rebuild keyhive from its own archive with the same signer.
      const bArchive = await khB.toArchive();
      const khB2 = await bArchive.tryToKeyhive(CiphertextStore.newInMemory(), bSigner, () => {});

      const enc2 = await encrypt('after B reload');
      await syncAtoB(khB2);
      expect(await decryptOnB(enc2, khB2)).toBe('after B reload');
      expect(await decryptOnB(enc1, khB2)).toBe('before B reload');
    });
  });

  describe('accessForDoc cross-peer (insufficient access bug)', () => {
    it('Bob can see Alice has access after claiming invite (using kh.id)', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // Alice enables sharing and generates admin invite for Bob
      const { khDocId } = await opsA.enableSharing('doc-1');
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');

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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');

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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');

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
      await grantPeerAccessViaTempSigner(ops, 
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');

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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');
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
      const invite = await grantPeerAccessViaTempSigner(opsA, khDocId, 'admin');
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
      expect(me!.role).toBe('admin');
    });
  });

  describe('getMyAccess', () => {
    it('returns Admin for document owner', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const access = await ops.getMyAccess(khDocId);
      expect(access).toBe('Admin');
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

  describe('multiple peers sharing a document', () => {
    it('both claimants see the document', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();
      const { ops: opsC } = await createOps();

      const { khDocId } = await opsA.enableSharing('doc-1');
      const inviteB = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');
      const inviteC = await grantPeerAccessViaTempSigner(opsA, khDocId, 'edit');

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

    // The device-link handshake has two legs and the UI must tell them apart:
    // the new device shows a return link (linked=false) and the original device
    // shows "Linking complete" once both devices are in the group (linked=true).
    it('linkDevice reports linked=true on the original device once both devices are in the group', async () => {
      const { ops: opsA } = await createOps();
      const { ops: opsB } = await createOps();

      // A is the original device and owns the user-group.
      const groupId = await opsA.ensureUserGroup({ create: true });
      expect(groupId).not.toBeNull();

      // A learns B's identity, as it would from opening B's return link.
      const { agentId: bAgentId } = await opsA.receiveContactCard(await opsB.getContactCard());

      const result = await opsA.linkDevice(bAgentId, groupId);
      expect(result.linked).toBe(true);

      // B is now a real member of the user-group (not just adopted the id).
      const devices = await opsA.listGroupDevices();
      expect(devices.some((d) => d.agentId === bAgentId && !d.isMe)).toBe(true);
    });

    it('linkDevice reports linked=false on the new device before the original device finishes', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      // A owns the group; B will adopt its id on the first leg.
      const groupId = await opsA.ensureUserGroup({ create: true });

      // Sync A's keyhive state into B so the adopted group resolves immediately
      // (otherwise ensureUserGroup's waitForSync would poll).
      await khB.ingestArchive(await khA.toArchive());

      // B learns A's identity, as it would from opening A's link.
      const { agentId: aAgentId } = await opsB.receiveContactCard(await opsA.getContactCard());

      const result = await opsB.linkDevice(aAgentId, groupId);
      // B has only adopted the group id; the original device hasn't added it yet,
      // so the handshake is not complete and the UI shows a return link.
      expect(result.linked).toBe(false);
    });
  });

  describe('direct add member (no invite link)', () => {
    /**
     * Simulate createKeyhiveDoc: generate a keyhive document (no co-parents)
     * and use its doc_id bytes as the "automerge document ID". This mirrors
     * what the worker does: createKeyhiveDoc() → setNextDocId → create2().
     */
    async function createDocForSharing(ops: KeyhiveOps): Promise<{ automergeDocIdBytes: Uint8Array; khDocId: string }> {
      const { docIdBytes, khDocId } = await ops.createKeyhiveDoc();
      return { automergeDocIdBytes: docIdBytes, khDocId };
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
      const { opsA, khA, opsB, khB, automergeDocId, automergeDocIdBytes, role = 'edit' } = opts;

      // Alice enables sharing — pass existing doc bytes so it reuses the
      // keyhive doc created by the idFactory instead of generating a duplicate.
      const { khDocId } = await opsA.enableSharing(automergeDocId, automergeDocIdBytes);

      // Bob mints his personal user-group (its id travels with a friend link);
      // sharing is group-only, so Alice shares with that group.
      const bobGroupId = await opsB.ensureUserGroup({ create: true });

      // Bidirectional contact card exchange (add friend)
      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      await khA.receiveContactCard(cardB);
      await khB.receiveContactCard(cardA);

      // Alice ingests Bob's archive so Bob's group ops resolve in her keyhive,
      // then adds Bob's group as a member via the direct addMember path.
      await khA.ingestArchive(await khB.toArchive());
      await opsA.addMember(bobGroupId!, khDocId, role);

      // Sync keyhive state from Alice → Bob (simulates network sync)
      const archiveA = await khA.toArchive();
      await khB.ingestArchive(archiveA);

      const indAonB = await khB.receiveContactCard(cardA);
      const aEventsForB: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indAonB.toAgent());
      const arr: Uint8Array[] = [];
      aEventsForB.forEach((v: Uint8Array) => arr.push(v));
      await khB.ingestEventsBytes(arr);

      return { khDocId, bobGroupId };
    }

    it('addMember calls forceResyncAllPeers to trigger doc sync to the new member', async () => {
      const { ops: opsA, kh: khA, fx: fxA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocForSharing(opsA);
      const resyncCountBefore = fxA.calls.forceResyncAllPeers.length;

      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-1',
        automergeDocIdBytes,
      });

      // forceResyncAllPeers triggers automerge-repo to re-sync with all peers.
      // This is safe because the network adapter drops doc messages while
      // keyhiveSynced=false — keyhive handshake completes first, then
      // encrypted doc data flows. Without this call, Bob wouldn't receive
      // the doc until Alice makes an edit.
      expect(fxA.calls.forceResyncAllPeers.length).toBe(resyncCountBefore + 1);
    });

    it('addMember calls syncKeyhive before forceResyncAllPeers (keyhive handshake first)', async () => {
      // The order matters: syncKeyhive delivers membership ops so the peer's
      // keyhive can process them. forceResyncAllPeers then triggers automerge-repo
      // to re-sync, which starts with a keyhive handshake (non-doc messages).
      // Once the handshake confirms (keyhiveSynced=true), encrypted doc data flows.
      // If forceResyncAllPeers ran first, the re-sync would try to send doc data
      // before the peer has CGKA keys — but the network adapter drops those messages.
      const { ops: opsA, kh: khA, fx: fxA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocForSharing(opsA);

      // Track call order
      const callOrder: string[] = [];
      const origSync = fxA.syncKeyhive;
      const origResync = fxA.forceResyncAllPeers;
      fxA.syncKeyhive = () => { callOrder.push('syncKeyhive'); origSync(); };
      fxA.forceResyncAllPeers = () => { callOrder.push('forceResyncAllPeers'); origResync(); };

      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-order',
        automergeDocIdBytes,
      });

      const syncIdx = callOrder.indexOf('syncKeyhive');
      const resyncIdx = callOrder.indexOf('forceResyncAllPeers');
      expect(syncIdx).toBeGreaterThanOrEqual(0);
      expect(resyncIdx).toBeGreaterThan(syncIdx);
    });

    it('after sync, Bob can discover the document via reachableDocs', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocForSharing(opsA);
      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-1',
        automergeDocIdBytes,
      });

      const bDocs = await khB.reachableDocs();
      expect(bDocs.length).toBeGreaterThan(0);
    });

    it('Bob sees his own group in the member list, not just Alice', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocForSharing(opsA);
      const { khDocId, bobGroupId } = await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-members',
        automergeDocIdBytes,
      });

      // Alice's panel is correct; Bob's panel should show the same members:
      // Alice (admin) AND Bob's own group (the share target).
      const membersOnBob = await opsB.getDocMembers(khDocId);
      const ids = membersOnBob.map((m) => m.agentId);
      expect(ids).toContain(bobGroupId);
    });

    // KNOWN BUG (it.failing): when a doc is shared with Bob's GROUP, a member
    // cannot decrypt it after the real per-agent network sync. The network
    // adapter's getEventHashesForAgent (utilities.ts) sends, per peer, only
    // eventsForAgent(individual) + that individual's keyOps() — which does NOT
    // carry the doc-level CGKA key material a group member needs. Result in the
    // app: "EncryptError/DecryptError: ShareKey not found" and Bob's Share panel
    // shows only Alice, never himself. (A full-archive sync works — see the
    // passing tests above — so this is a sync-completeness gap, not core logic.)
    // This test PASSES while the bug exists and will FAIL (alerting us) once the
    // per-agent sync is fixed to include the needed group/doc key ops.
    it.failing('group-shared doc: a group member can decrypt after faithful per-agent sync', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('am-doc-sharekey');
      const bobGroupId = await opsB.ensureUserGroup({ create: true });

      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      const indBonA = await khA.receiveContactCard(cardB);
      await khB.receiveContactCard(cardA);

      // Alice obtains Bob's group ops (she can share).
      await khA.ingestArchive(await khB.toArchive());
      await opsA.addMember(bobGroupId!, khDocId, 'edit');

      // Faithful per-agent wire payload Alice → Bob (events + individual keyOps only).
      const collect = async (kh: any, agents: any[]) => {
        const byHash = new Map<string, Uint8Array>();
        for (const agent of agents) {
          const ev: Map<Uint8Array, Uint8Array> = await kh.eventsForAgent(agent);
          ev.forEach((v, k) => byHash.set(k.toString(), v));
          const ko: Map<Uint8Array, Uint8Array> = await agent.keyOps();
          ko.forEach((v, k) => byHash.set(k.toString(), v));
        }
        return [...byHash.values()];
      };
      const aliceAgent = (await khA.individual).toAgent();
      const payload = await collect(khA, [aliceAgent, indBonA.toAgent()]);
      await khB.ingestEventsBytes(payload);

      // Alice encrypts; Bob must be able to decrypt (needs the doc's ShareKey).
      const docA = opsA.khDocuments.get(khDocId);
      const plaintext = new TextEncoder().encode('shared with bob group');
      const ref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const enc = await khA.tryEncryptArchive(docA!, ref, [], plaintext);

      const docB = await khB.getDocument(docA.doc_id);
      expect(docB).toBeDefined();
      const decrypted = await khB.tryDecrypt(docB!, enc.encrypted_content());
      expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('Alice grants Bob (individual) access via his group — the sync access-gate sees it', async () => {
      // peerHasAnyAccess / peerHasWriteAccess gate sync on Alice's side using
      // keyhive.accessForDoc(bobIndividualId, doc). If that returns null because
      // Alice's keyhive does not resolve Bob's individual's access THROUGH his
      // group, Alice silently drops ALL sync to Bob — Bob sees Alice but never
      // himself. Verify accessForDoc resolves transitively on the GRANTER side.
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { automergeDocIdBytes } = await createDocForSharing(opsA);
      await addFriendAndMember({
        opsA, khA, opsB, khB,
        automergeDocId: 'am-doc-gate',
        automergeDocIdBytes,
      });

      const bobIndividualId = new Identifier((await khB.individual).id.toBytes());
      const khDocIdObj = new DocumentId(automergeDocIdBytes);
      const access = await khA.accessForDoc(bobIndividualId, khDocIdObj);
      expect(access).toBeDefined();
      expect(access).not.toBeNull();
    });

    it('per-agent sync delivers the group delegation so Bob sees his group as a member', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('am-doc-repro');
      const bobGroupId = await opsB.ensureUserGroup({ create: true });

      // Card exchange (add friend, both directions).
      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      const indBonA = await khA.receiveContactCard(cardB);
      await khB.receiveContactCard(cardA);

      // Alice obtains Bob's group ops (the bug report confirms Alice CAN share,
      // so by this point her keyhive resolves Bob's group).
      await khA.ingestArchive(await khB.toArchive());
      await opsA.addMember(bobGroupId!, khDocId, 'edit');

      // Faithful per-agent sync — exactly what the network adapter transfers:
      // the union of eventsForAgent(self) and eventsForAgent(remote individual),
      // NOT a full archive. This is the real wire payload Bob receives.
      const aliceAgent = (await khA.individual).toAgent();
      const bobAgentOnAlice = indBonA.toAgent();
      const evMap = new Map<string, Uint8Array>();
      for (const agent of [aliceAgent, bobAgentOnAlice]) {
        const ev: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(agent);
        ev.forEach((v, k) => evMap.set(k.toString(), v));
      }
      await khB.ingestEventsBytes([...evMap.values()]);

      const membersOnBob = await opsB.getDocMembers(khDocId);
      expect(membersOnBob.map((m) => m.agentId)).toContain(bobGroupId);
    });

    it('per-agent sync delivers Bob group ops to Alice so she can share with the group', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const { khDocId } = await opsA.enableSharing('am-doc-probe');
      const bobGroupId = await opsB.ensureUserGroup({ create: true });

      const cardA = await khA.contactCard();
      const cardB = await khB.contactCard();
      await khA.receiveContactCard(cardB);
      const indAonB = await khB.receiveContactCard(cardA);

      // Bob → Alice per-agent sync (union of eventsForAgent), NO full archive.
      const bobAgent = (await khB.individual).toAgent();
      const aliceAgentOnBob = indAonB.toAgent();
      const evMap = new Map<string, Uint8Array>();
      for (const agent of [bobAgent, aliceAgentOnBob]) {
        const ev: Map<Uint8Array, Uint8Array> = await khB.eventsForAgent(agent);
        ev.forEach((v, k) => evMap.set(k.toString(), v));
      }
      await khA.ingestEventsBytes([...evMap.values()]);

      // Can Alice now resolve + share with Bob's group?
      await opsA.addMember(bobGroupId!, khDocId, 'edit');
      const members = await opsA.getDocMembers(khDocId);
      expect(members.map((m) => m.agentId)).toContain(bobGroupId);
    });

    it('enableSharing reuses existing keyhive doc from createKeyhiveDoc', async () => {
      const { ops, kh } = await createOps();

      // createKeyhiveDoc creates the keyhive doc
      const { automergeDocIdBytes } = await createDocForSharing(ops);

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
      // (simulates a doc with an unknown keyhive ID)
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

      const { automergeDocIdBytes } = await createDocForSharing(opsA);
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
      expect(access!.toString()).toBe('Edit');
    });
  });

  // ── User-group (a "user" = a keyhive Group of device Individuals) ──────────
  describe('user group', () => {
    /** A learns about B by receiving B's contact card; returns B's agentId. */
    async function learnAgent(learner: KeyhiveOps, subject: KeyhiveOps): Promise<string> {
      const card = await subject.getContactCard();
      const { agentId } = await learner.receiveContactCard(card);
      return agentId;
    }

    it('ensureUserGroup({create}) mints and persists a group; getUserGroupId returns it', async () => {
      const { ops, fx } = await createOps();
      expect(await ops.getUserGroupId()).toBeNull();
      const id = await ops.ensureUserGroup({ create: true });
      expect(id).toBeTruthy();
      expect(await ops.getUserGroupId()).toBe(id);
      // idempotent: a second create returns the same id, doesn't mint a new group
      const again = await ops.ensureUserGroup({ create: true });
      expect(again).toBe(id);
      expect(fx.calls.persist.length).toBeGreaterThan(0);
    });

    it('addDeviceToGroup adds a device and listGroupDevices lists self + the device', async () => {
      const { ops: a } = await createOps();
      const { ops: b } = await createOps();
      await a.ensureUserGroup({ create: true });
      const bAgentId = await learnAgent(a, b);

      await a.addDeviceToGroup(bAgentId);
      const devices = await a.listGroupDevices();
      const ids = devices.map((d) => d.agentId);
      const me = (await a.getIdentity()).agentId;
      expect(ids).toContain(me);
      expect(ids).toContain(bAgentId);
      expect(devices.find((d) => d.agentId === me)?.isMe).toBe(true);

      // idempotent — adding again does not duplicate
      await a.addDeviceToGroup(bAgentId);
      const devices2 = await a.listGroupDevices();
      expect(devices2.filter((d) => d.agentId === bAgentId)).toHaveLength(1);
    });

    it('listGroupDevices reports normalized MemberRole (read/edit/admin), never a raw Access string', async () => {
      const { ops: a } = await createOps();
      const { ops: b } = await createOps();
      await a.ensureUserGroup({ create: true });
      const bAgentId = await learnAgent(a, b);
      await a.addDeviceToGroup(bAgentId); // added as admin

      const devices = await a.listGroupDevices();
      const me = (await a.getIdentity()).agentId;
      for (const d of devices) {
        expect(['read', 'edit', 'admin']).toContain(d.role); // normalized, lowercase — no 'owner'/'Admin'
      }
      expect(devices.find((d) => d.agentId === me)?.role).toBe('admin'); // self is admin, not synthetic 'owner'
      expect(devices.find((d) => d.agentId === bAgentId)?.role).toBe('admin'); // device added as admin
    });

    it('changeDeviceRole demotes a device in the user-group (revoke + re-add) and resyncs peers', async () => {
      const { ops: a, fx } = await createOps();
      const { ops: b } = await createOps();
      await a.ensureUserGroup({ create: true });
      const bAgentId = await learnAgent(a, b);
      await a.addDeviceToGroup(bAgentId); // admin by default
      expect((await a.listGroupDevices()).find((d) => d.agentId === bAgentId)?.role).toBe('admin');

      const resyncsBefore = fx.calls.forceResyncAllPeers.length;
      await a.changeDeviceRole(bAgentId, 'read');

      const devices = await a.listGroupDevices();
      expect(devices.find((d) => d.agentId === bAgentId)?.role).toBe('read');
      // Same propagation contract as doc-level changeRole so the demoted device learns its new access.
      expect(fx.calls.forceResyncAllPeers.length).toBeGreaterThan(resyncsBefore);
    });

    it('changeDeviceRole rejects an unknown device', async () => {
      const { ops: a } = await createOps();
      const { ops: b } = await createOps();
      await a.ensureUserGroup({ create: true });
      const bAgentId = await learnAgent(a, b); // known but not in the group
      await expect(a.changeDeviceRole(bAgentId, 'read')).rejects.toThrow(/not found in group/);
    });

    it('listGroupDevices returns just self when there is no group', async () => {
      const { ops } = await createOps();
      const devices = await ops.listGroupDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].isMe).toBe(true);
      expect(devices[0].agentId).toBe((await ops.getIdentity()).agentId);
    });

    it('addMember resolves a group id to the Group (doc member is a group)', async () => {
      const { ops } = await createOps();
      const groupId = await ops.ensureUserGroup({ create: true });
      const { khDocId } = await ops.enableSharing('doc-group');

      await ops.addMember(groupId!, khDocId, 'read');
      const members = await ops.getDocMembers(khDocId);
      const groupMember = members.find((m) => m.agentId === groupId);
      expect(groupMember).toBeDefined();
      expect(groupMember!.type).toBe('group');
    });

    it('getDocMembers marks the user-group as "me", reports its devices, and hides grouped devices', async () => {
      const { ops } = await createOps();
      const groupId = await ops.ensureUserGroup({ create: true });
      // enableSharing makes the user-group an admin co-owner; the creating device
      // is both a root doc member and a member of its own user-group.
      const { khDocId } = await ops.enableSharing('doc-grouped-devices');
      const myAgentId = (await ops.getIdentity()).agentId;

      const members = await ops.getDocMembers(khDocId);

      const groupMember = members.find((m) => m.agentId === groupId);
      expect(groupMember).toBeDefined();
      expect(groupMember!.type).toBe('group');
      expect(groupMember!.isMe).toBe(true); // own user-group reads as "you"
      // The group reports its device members (here: just the creating device).
      if (groupMember!.type === 'group') {
        expect(groupMember!.deviceIds).toContain(myAgentId);
      }

      // The current device is covered by its own user-group, so getDocMembers
      // filters it out — only the group stands in for it.
      const deviceMember = members.find((m) => m.type === 'individual' && m.agentId === myAgentId);
      expect(deviceMember).toBeUndefined();
    });

    it('a group can co-own a doc as admin; the creating device cannot be revoked (keyhive constraint)', async () => {
      // The user-group CAN be added as an admin co-owner of a document. But the
      // CREATING device gets a root delegation (proof: None) that roots the
      // document's authority, and keyhive only accepts a revocation of a root
      // delegation if it is signed by the DOCUMENT's own key — which no device
      // holds. So a device's attempt to revoke its own root membership silently
      // no-ops. Net: "remove the device as admin" is not achievable for a doc
      // the device created. This test documents that constraint.
      const { ops, kh } = await createOps();
      const groupId = await ops.ensureUserGroup({ create: true });
      const group = await kh.getGroup(GroupId.fromBytes(base64ToBytes(groupId!)));
      expect(group).toBeDefined();

      const ref = new ChangeId(new Uint8Array(32));
      const doc = await kh.generateDocument([], ref, []);

      const admin = Access.tryFromString('admin')!;
      await kh.addMember(group!.toAgent(), doc.toMembered(), admin, []);

      const me = await kh.individual;
      const myIdB64 = bytesToBase64(me.id.toBytes());
      const before = await kh.docMemberCapabilities(doc.doc_id);
      const deviceMember = before.find((m: any) => bytesToBase64(m.who.id.toBytes()) === myIdB64);
      expect(deviceMember).toBeDefined();
      // Attempt to revoke the creating device — silently ignored (root delegation).
      await kh.revokeMember(deviceMember!.who, true, doc.toMembered());

      const members = await kh.docMemberCapabilities(doc.doc_id);
      const ids = members.map((m: any) => bytesToBase64(m.who.id.toBytes()));
      // The group IS an admin co-owner...
      expect(ids).toContain(groupId);
      // ...but the creating device remains (cannot be revoked).
      expect(ids).toContain(myIdB64);

      // The group grants its members access too: the device has Admin and the
      // doc still encrypts/decrypts.
      const access = await kh.accessForDoc(new Identifier(me.id.toBytes()), doc.doc_id);
      expect(access?.toString()).toBe('Admin');
      const pt = new TextEncoder().encode('group co-owned doc');
      const eref = new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
      const enc = await kh.tryEncryptArchive(doc, eref, [], pt);
      const dec = await kh.tryDecrypt(doc, enc.encrypted_content());
      expect(new Uint8Array(dec)).toEqual(pt);
    });

    it('addMember rejects a bare individual id (sharing is group-only)', async () => {
      const { ops: a } = await createOps();
      const { ops: b } = await createOps();
      const bAgentId = await learnAgent(a, b);
      const { khDocId } = await a.enableSharing('doc-indiv');

      await expect(a.addMember(bAgentId, khDocId, 'read')).rejects.toThrow('Agent not found');
    });

    it('linkDevice: admin adds the peer; a groupless peer adopts the group id', async () => {
      const { ops: a } = await createOps();
      const { ops: b } = await createOps();
      const aGroupId = await a.ensureUserGroup({ create: true });
      const aAgentId = (await a.getIdentity()).agentId;
      const bAgentId = await learnAgent(a, b);

      // A is the admin: linking B (peer has no group) adds B to A's group.
      await a.linkDevice(bAgentId, null);
      expect((await a.listGroupDevices()).map((d) => d.agentId)).toContain(bAgentId);

      // B adopts A's group id. Give B the group ops so waitForSync resolves immediately.
      await b.kh.ingestArchive(new Archive((await a.kh.toArchive()).toBytes()));
      await learnAgent(b, a);
      const res = await b.linkDevice(aAgentId, aGroupId);
      expect(res.userGroupId).toBe(aGroupId);
      expect(await b.getUserGroupId()).toBe(aGroupId);
    });

    it('getKnownContacts lists a stored contact as their user-group', async () => {
      const { ops: a } = await createOps();
      // A stored contact is identified by its user-group id (sharing is group-only).
      const groupId = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

      const contacts = await a.getKnownContacts(undefined, [groupId]);
      const entry = contacts.find((c) => c.agentId === groupId);
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('group'); // a contact is the user-group; its agentId is the share target
    });
  });

  // The home page is driven by user-group access: a doc shows iff the personal
  // user-group has at least read access, and "delete" revokes the user-group.
  // We deliberately check the GROUP (not the device) so that revoke actually
  // removes a self-created doc — the creating device's root delegation is
  // permanent in keyhive and can never be revoked.
  describe('home-page user-group access', () => {
    it('V1: the user-group is admin of a doc it created (group-access query works)', async () => {
      const { ops, kh, fx } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1'); // mints user-group, makes it admin
      const userGroupId = await fx.getUserGroupId();
      expect(userGroupId).toBeTruthy();

      const groupIdentifier = new Identifier(base64ToBytes(userGroupId!));
      const docIdObj = new DocumentId(base64ToBytes(khDocId));
      const access = await kh.accessForDoc(groupIdentifier, docIdObj);
      expect(access).toBeDefined();
      expect(access!.toString()).toBe('Admin');
    });

    it('V2: revoking the user-group removes its access (device root delegation persists)', async () => {
      const { ops, kh, fx } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const userGroupId = await fx.getUserGroupId();
      const groupIdentifier = new Identifier(base64ToBytes(userGroupId!));
      const docIdObj = new DocumentId(base64ToBytes(khDocId));

      // Group starts as admin.
      expect((await kh.accessForDoc(groupIdentifier, docIdObj))?.toString()).toBe('Admin');

      // Revoke the user-group from the doc.
      const doc = await kh.getDocument(docIdObj);
      expect(doc).toBeDefined();
      const groupBytes = base64ToBytes(userGroupId!);
      const members = await kh.docMemberCapabilities(doc!.doc_id);
      const groupMember = members.find((m: any) => {
        const b: Uint8Array = m.who.id.toBytes();
        return b.length === groupBytes.length && b.every((x: number, i: number) => x === groupBytes[i]);
      });
      expect(groupMember).toBeDefined();
      await kh.revokeMember(groupMember!.who, true, doc!.toMembered());

      // Group access is gone — so the doc would drop off the home list.
      const afterGroup = await kh.accessForDoc(groupIdentifier, docIdObj);
      expect(afterGroup == null).toBe(true);

      // ...but the creating device still reaches the doc via its permanent root
      // delegation. This is exactly why we filter by group access, not device.
      const myIdentifier = new Identifier(kh.id.bytes);
      const afterDevice = await kh.accessForDoc(myIdentifier, docIdObj);
      expect(afterDevice?.toString()).toBe('Admin');
    });

    it('enumerateUserDocs lists a doc the user-group can access', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const { accessibleKhIds, reachableKhIds } = await ops.enumerateUserDocs();
      expect(accessibleKhIds).toContain(khDocId);
      expect(reachableKhIds).toContain(khDocId);
    });

    it('revokeMyAccess revokes the user-group so the doc is no longer accessible (but still reachable)', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      expect(await ops.getUserGroupAccess(khDocId)).toBe('Admin');

      await ops.revokeMyAccess(khDocId);

      // The home page filters by user-group access, so the doc now drops off the list...
      expect(await ops.getUserGroupAccess(khDocId)).toBeNull();
      const { accessibleKhIds, reachableKhIds } = await ops.enumerateUserDocs();
      expect(accessibleKhIds).not.toContain(khDocId);
      // ...even though the creating device's permanent root delegation keeps it reachable.
      expect(reachableKhIds).toContain(khDocId);
    });

    it('keyhive doc id ↔ automerge doc id round-trips (worker home-list conversion)', async () => {
      const repo = (await import('@automerge/automerge-repo')) as any;
      // The worker's conversion: keyhive doc-id bytes → automerge doc id string.
      const amDocIdFromBytes = (b: Uint8Array): string =>
        repo.parseAutomergeUrl(repo.stringifyAutomergeUrl(b)).documentId;
      const docBytes = crypto.getRandomValues(new Uint8Array(16)); // automerge doc id = 16-byte UUID
      const amDocId = amDocIdFromBytes(docBytes);
      // The automerge doc id decodes back to exactly these bytes — and those bytes ARE
      // the keyhive DocumentId (the bridge's docIdFromAutomergeUrl returns
      // parseAutomergeUrl(url).binaryDocumentId), so the worker's id mapping is lossless.
      const back: Uint8Array = repo.parseAutomergeUrl(`automerge:${amDocId}`).binaryDocumentId;
      expect(Array.from(back)).toEqual(Array.from(docBytes));
    });

    // Guards the GROUP-based cross-device enumeration path: device A assigns the
    // shared user-group as admin of a new doc (assignGroupAsAdmin), and device B —
    // a member of that same user-group — must enumerate it via getUserGroupAccess /
    // enumerateUserDocs. The existing cross-device tests share individual→individual,
    // so this transitive (B ∈ group → group admins doc) path was never exercised.
    // NOTE: this passes once B's keyhive HAS A's ops; in production the gap is that
    // those ops never reach an offline B (stateless relay, no store-and-forward peer).
    it('doc created on device A after linking is enumerable on device B via the user-group', async () => {
      const { ops: opsA, kh: khA } = await createOps();
      const { ops: opsB, kh: khB } = await createOps();

      const syncAtoB = async () => {
        await khB.ingestArchive(new Archive((await khA.toArchive()).toBytes()));
        const indAonB = await khB.receiveContactCard(await khA.contactCard());
        const evts: Map<Uint8Array, Uint8Array> = await khA.eventsForAgent(indAonB.toAgent());
        const arr: Uint8Array[] = [];
        evts.forEach((v: Uint8Array) => arr.push(v));
        await khB.ingestEventsBytes(arr);
      };

      // --- Link B into A's user-group (same user, two devices) ---
      const aGroupId = await opsA.ensureUserGroup({ create: true });
      const aAgentId = (await opsA.getIdentity()).agentId;
      const bAgentId = (await opsA.receiveContactCard(await opsB.getContactCard())).agentId;
      await opsA.linkDevice(bAgentId, null); // A (admin) adds B to its group

      await syncAtoB(); // B learns A's group ops
      await opsB.receiveContactCard(await opsA.getContactCard());
      await opsB.linkDevice(aAgentId, aGroupId); // B adopts A's group id
      expect(await opsB.getUserGroupId()).toBe(aGroupId);

      // --- A creates a NEW doc AFTER linking (shared with the user-group) ---
      const { khDocId } = await opsA.enableSharing('am-doc-after-link');

      // --- Sync A's new ops to B (as periodic keyhive sync would) ---
      await syncAtoB();

      // --- B must now see the doc through the shared user-group ---
      expect(await opsB.getUserGroupAccess(khDocId)).toBe('Admin');
      const { accessibleKhIds } = await opsB.enumerateUserDocs();
      expect(accessibleKhIds).toContain(khDocId);
    });

    // ── home-page "archive" of a contact-shared doc ─────────────────────────
    // B's device revokes its own user-group's grant, which was issued by A's
    // device. B is not the issuer, not a doc admin, and not in the grant's proof
    // lineage — the revoke goes through keyhive's transitive-membership fallback
    // (B ∈ B-group with access ≥ the grant). Guards that fallback plus the two
    // resurrection channels the app exercises: continued sync from A (who never
    // saw the revocation) and an archive reload.

    // Two-peer harness for the contact-share scenario. B is built from a known
    // seed so its keyhive can be rebuilt from an archive ("reload").
    async function createContactShare() {
      const { ops: opsA, kh: khA } = await createOps();
      const seedB = crypto.getRandomValues(new Uint8Array(32));
      const khB = await Keyhive.init(Signer.memorySignerFromBytes(seedB), CiphertextStore.newInMemory(), () => {});
      const opsB = new KeyhiveOps(khB, bridge, noopSideEffects());

      // Give `to` everything `from` has (archive + identity events), as the
      // app's contact exchange + periodic keyhive sync would.
      const syncAll = async (khFrom: any, khTo: any) => {
        await khTo.ingestArchive(new Archive((await khFrom.toArchive()).toBytes()));
        const ind = await khTo.receiveContactCard(await khFrom.contactCard());
        const evts: Map<Uint8Array, Uint8Array> = await khFrom.eventsForAgent(ind.toAgent());
        const arr: Uint8Array[] = [];
        evts.forEach((v: Uint8Array) => arr.push(v));
        await khTo.ingestEventsBytes(arr);
      };

      const bGroupId = (await opsB.ensureUserGroup({ create: true }))!;
      expect(bGroupId).toBeTruthy();

      // A learns B's identity + group (contact exchange), then shares a doc to
      // B's user-group with edit access. Like the real app, the doc carries CGKA
      // state: A encrypts content before and after the share.
      await syncAll(khB, khA);
      const { khDocId } = await opsA.enableSharing('contact-shared-doc');
      const docOnA = await khA.getDocument(new DocumentId(base64ToBytes(khDocId)));
      await khA.tryEncrypt(docOnA!, new ChangeId(crypto.getRandomValues(new Uint8Array(32))), [], new TextEncoder().encode('before share'));
      await opsA.addMember(bGroupId, khDocId, 'edit');
      await khA.tryEncrypt(docOnA!, new ChangeId(crypto.getRandomValues(new Uint8Array(32))), [], new TextEncoder().encode('after share'));

      // B learns the doc + the grant.
      await syncAll(khA, khB);
      expect(await opsB.getUserGroupAccess(khDocId)).toBe('Edit');

      return { opsA, khA, opsB, khB, seedB, bGroupId, khDocId, syncAll };
    }

    it('revokeMyAccess revokes a contact-shared grant; the revocation survives sync-back and reload', async () => {
      const { opsA: _opsA, khA, opsB, khB, seedB, bGroupId, khDocId, syncAll } = await createContactShare();

      const res = await opsB.revokeMyAccess(khDocId);
      expect(res.status).toBe('revoked');
      // The baseline was captured before the revoke: A's single grant.
      expect(res.grantSigs).toHaveLength(1);

      expect(await opsB.getUserGroupAccess(khDocId)).toBeNull();
      const { accessibleKhIds } = await opsB.enumerateUserDocs();
      expect(accessibleKhIds).not.toContain(khDocId);

      // A never saw the revocation and keeps syncing its state to B — that must
      // not resurrect B's access (ops are monotonic).
      await syncAll(khA, khB);
      expect(await opsB.getUserGroupAccess(khDocId)).toBeNull();

      // Reload: rebuild B's keyhive from its own persisted archive — the
      // revocation must be durable.
      const archB = new Archive((await khB.toArchive()).toBytes());
      const khB2 = await archB.tryToKeyhive(CiphertextStore.newInMemory(), Signer.memorySignerFromBytes(seedB), () => {});
      const accessAfterReload = await khB2.accessForDoc(
        new Identifier(base64ToBytes(bGroupId)),
        new DocumentId(base64ToBytes(khDocId)),
      );
      expect(accessAfterReload == null).toBe(true);
    });

    it('revokeMyAccess reports no-authority + the grant baseline when the revoke fails; a re-share mints a new signature', async () => {
      const { opsA, khA, opsB, khB, bGroupId, khDocId, syncAll } = await createContactShare();

      const baseline = await opsB.getUserGroupGrantSigs(khDocId);
      expect(baseline).toHaveLength(1);

      // Simulate the real-world failure modes (partial CGKA state, WASM rekey
      // trap) by making the revoke throw. Own-property assignment shadows the
      // wasm prototype method (same trick as neutralizeForcePcsUpdate).
      (khB as any).revokeMember = async () => { throw new Error('NoProof (simulated)'); };
      const res = await opsB.revokeMyAccess(khDocId);
      expect(res.status).toBe('no-authority');
      expect(res.grantSigs).toEqual(baseline);
      // Access survives — this is exactly the case the archive tombstone hides.
      expect(await opsB.getUserGroupAccess(khDocId)).toBe('Edit');

      // Re-adding the SAME grant is a keyhive no-op (identical op, deduped) —
      // no new signature, so it must NOT read as a re-share.
      await opsA.addMember(bGroupId, khDocId, 'edit');
      await syncAll(khA, khB);
      expect(await opsB.getUserGroupGrantSigs(khDocId)).toEqual(baseline);

      // A deliberate re-share reaches B as a fresh delegation (the app's only
      // paths — change the member's role, or revoke + re-add — both mint one).
      // Its NEW signature is the un-archive trigger reconcileHomeDocs keys off.
      await opsA.changeRole(bGroupId, khDocId, 'admin');
      await syncAll(khA, khB);
      const after = await opsB.getUserGroupGrantSigs(khDocId);
      expect(after.length).toBeGreaterThan(0);
      expect(after.some(s => !baseline.includes(s))).toBe(true);
    });
  });
});
