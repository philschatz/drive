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
