/**
 * KeyhiveOps against the real keyhive 0.8.0 WASM — no shims.
 *
 * Two layers are pinned here:
 *
 * - what the app does through KeyhiveOps: contact bundles, sharing with a
 *   friend's user-group, device linking, the home page's group-access lens;
 * - the raw keyhive behaviour those depend on, where getting it wrong would be
 *   silent: key agreement across peers and reloads, which revocations orphan a
 *   group, what `accessForDoc` resolves.
 *
 * Peers are synced by hand (tests/support/keyhive-harness.ts): `syncAsBridge`
 * transfers what the bridge would, `syncPeers` transfers everything.
 */
import {
  ChangeId,
  ContactCard,
  DocumentId,
  Encrypted,
  GroupId,
  Identifier,
  IndividualId,
  MemberedId,
  Power,
} from '@keyhive/keyhive/slim';
import { CONTACT_BUNDLE_VERSION_MISMATCH, base64ToBytes, bytesToBase64 } from './keyhive-ops';
import type { DeviceEntry, MemberInfo } from './keyhive-types';
import {
  befriend,
  createOps,
  decrypt,
  docIdOf,
  encrypt,
  exchangeCards,
  identifierOf,
  learnContact,
  linkDevices,
  pushVisibleEvents,
  reload,
  shareDocWithDevice,
  shareWithFriend,
  syncAsBridge,
  syncPeers,
  type Peer,
} from '../../tests/support/keyhive-harness';

const b64 = bytesToBase64;
const groupIdOf = (idB64: string) => new GroupId(base64ToBytes(idB64));
const knowsDevice = (peer: Peer, agentId: string) => peer.kh.hasIndividual(new IndividualId(base64ToBytes(agentId)));
const knowsGroup = (peer: Peer, groupId: string) => peer.kh.hasGroup(groupIdOf(groupId));
const memberOf = (members: MemberInfo[], agentId: string) => members.find((m) => m.agentId === agentId);
const deviceOf = (devices: DeviceEntry[], agentId: string) => devices.find((d) => d.agentId === agentId);

/** Raw power one identifier holds on a document, as `peer`'s keyhive sees it ("Admin"/…/undefined). */
async function rawAccess(peer: Peer, idB64: string, khDocId: string): Promise<string | undefined> {
  return (await peer.kh.accessForDoc(identifierOf(idB64), docIdOf(khDocId)))?.toString();
}

/** The direct members of a document: base64 id → the capability keyhive reports for it. */
async function directMembers(peer: Peer, khDocId: string): Promise<Map<string, any>> {
  const doc = await peer.kh.getDocument(docIdOf(khDocId));
  const out = new Map<string, any>();
  for (const cap of await doc!.members()) out.set(b64(cap.who.toBytes()), cap);
  return out;
}

/** Whether any of these base64 events contains the 32 raw bytes of an id. */
function mentions(eventsB64: string[], idB64: string): boolean {
  const needle = Buffer.from(base64ToBytes(idB64));
  return eventsB64.some((e) => Buffer.from(base64ToBytes(e)).includes(needle));
}

describe('KeyhiveOps', () => {
  describe('getIdentity', () => {
    it('reports the device id, the agentId (the signer\'s verifying key) and the user-group once there is one', async () => {
      const { ops, kh, signer } = await createOps();

      const before = await ops.getIdentity();
      expect(before.deviceId).toBe(kh.idString);
      // A peerId is `<base64 verifying key>-…`, and friends, devices and the
      // share gate all key off the agentId — so the two must be the same bytes.
      expect(before.agentId).toBe(b64(signer.verifyingKey));
      expect(before.userGroupId).toBeNull();

      const groupId = await ops.ensureUserGroup({ create: true });
      expect((await ops.getIdentity()).userGroupId).toBe(groupId);
    });
  });

  describe('contact bundle (getContactCard / receiveContactCard)', () => {
    it('round-trips: JSON carrying the signed card as base64 bytes, and the receiver learns the sender', async () => {
      const alice = await createOps();
      const bob = await createOps();

      const bundle = await alice.ops.getContactCard();
      const parsed = JSON.parse(bundle);
      expect(parsed).toMatchObject({ __kind: 'contact-bundle', v: 2 });
      // The card is keyhive's own signed frame, not a re-encoding of it.
      const card = ContactCard.fromBytes(base64ToBytes(parsed.card));
      expect(b64(card.individualId.toBytes())).toBe(alice.agentId);
      // The bundle travels inside a URL / QR payload as text.
      expect(new TextDecoder().decode(new TextEncoder().encode(bundle))).toBe(bundle);

      const result = await bob.ops.receiveContactCard(bundle);
      expect(result).toEqual({ agentId: alice.agentId, isOwnCard: false });
      expect(await knowsDevice(bob, alice.agentId)).toBe(true);
    });

    it('detects its own card, and does not persist for it', async () => {
      const { ops, fx, agentId } = await createOps();
      const result = await ops.receiveContactCard(await ops.getContactCard());
      expect(result.isOwnCard).toBe(true);
      expect(result.agentId).toBe(agentId);
      expect(fx.calls.persist).toHaveLength(0);
    });

    it('does not flag another device\'s card as its own, and persists the new contact', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const result = await bob.ops.receiveContactCard(await alice.ops.getContactCard());
      expect(result.isOwnCard).toBe(false);
      expect(result.agentId).toBe(alice.agentId);
      expect(bob.fx.calls.persist).toHaveLength(1);
    });

    it('carries the sender\'s user-group, which the receiver can then resolve', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const aliceGroupId = (await alice.ops.ensureUserGroup({ create: true }))!;

      // A group never reaches a non-member through keyhive sync, so without
      // this the receiver would have nothing to share a document with.
      expect(await knowsGroup(bob, aliceGroupId)).toBe(false);
      const result = await bob.ops.receiveContactCard(await alice.ops.getContactCard());
      expect(result.groupId).toBe(aliceGroupId);
      expect(await knowsGroup(bob, aliceGroupId)).toBe(true);
    });

    it('rejects a bundle whose groupEvents count exceeds the bound', async () => {
      const alice = await createOps();
      const bob = await createOps();

      // An attacker-controlled bundle: a valid card, then a flood of "group ops".
      const bundle = JSON.parse(await alice.ops.getContactCard());
      bundle.groupEvents = Array.from({ length: 1025 }, () => 'AAAA');

      await expect(bob.ops.receiveContactCard(JSON.stringify(bundle))).rejects.toThrow(/group ops too large/i);
    });

    it('rejects a bundle whose groupEvents total size exceeds the bound', async () => {
      const alice = await createOps();
      const bob = await createOps();

      const bundle = JSON.parse(await alice.ops.getContactCard());
      const big = 'A'.repeat(64 * 1024);
      bundle.groupEvents = Array.from({ length: 17 }, () => big); // 17 × 64 KiB > 1 MiB

      await expect(bob.ops.receiveContactCard(JSON.stringify(bundle))).rejects.toThrow(/group ops too large/i);
    });

    // Bundle format 2 is keyhive >= 0.6's framed encoding. A device still on the
    // old build produces (and expects) something this keyhive cannot read, and
    // the user has to be told to update — not shown a decode error.
    it('rejects a bundle of another format version with the update-both-devices message', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { v: _v, ...unversioned } = JSON.parse(await alice.ops.getContactCard());

      // What the previous build sent: no `v`, and the card as ContactCard.toJson().
      const legacy = { __kind: 'contact-bundle', card: '{"op":{"Rotate":{}}}', groupId: 'x', groupEvents: [] };
      for (const bundle of [unversioned, { ...unversioned, v: 1 }, { ...unversioned, v: 3 }, legacy]) {
        await expect(bob.ops.receiveContactCard(JSON.stringify(bundle))).rejects.toThrow(CONTACT_BUNDLE_VERSION_MISMATCH);
      }
      expect(await knowsDevice(bob, alice.agentId)).toBe(false);
      expect(bob.fx.calls.persist).toHaveLength(0);
    });

    it('rejects anything that is not a bundle as an invalid contact card', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bareCard = b64((await alice.kh.contactCard()).toBytes());

      // The envelope is mandatory: a bare card string is not accepted either.
      for (const notABundle of ['hello', '{"foo":1}', '[]', 'null', bareCard, JSON.stringify({ __kind: 'contact-bundle', v: 2 })]) {
        await expect(bob.ops.receiveContactCard(notABundle)).rejects.toThrow('Invalid contact card');
      }
      expect(await knowsDevice(bob, alice.agentId)).toBe(false);
    });

    it('rejects a bundle whose card bytes were tampered with, and records nothing', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bundle = JSON.parse(await alice.ops.getContactCard());
      const original = base64ToBytes(bundle.card);

      // Frame header, signed payload, and the signature's last byte.
      for (const index of [0, 4, 40, 100, original.length - 1]) {
        const bytes = original.slice();
        bytes[index] ^= 0x01;
        const tampered = JSON.stringify({ ...bundle, card: b64(bytes) });
        await expect(bob.ops.receiveContactCard(tampered)).rejects.toThrow(/cannot read ContactCard/);
      }
      // A flipped payload byte is caught by the signature, not by luck of parsing.
      const payloadFlip = original.slice();
      payloadFlip[40] ^= 0x01;
      await expect(bob.ops.receiveContactCard(JSON.stringify({ ...bundle, card: b64(payloadFlip) })))
        .rejects.toThrow(/signature does not verify/);

      expect(await knowsDevice(bob, alice.agentId)).toBe(false);
      expect(bob.fx.calls.persist).toHaveLength(0);
    });
  });

  // The bundle is shown as a QR and sent over the rendezvous channel, both of
  // which have hard size limits — and it is handed to people who are not yet
  // trusted with anything. It must say who the sender is, and nothing about what
  // they have or who else they know.
  describe('contact bundle size', () => {
    /**
     * Give `peer` a user-group, a friend, and `docCount` documents shared with
     * that friend and written to. Sharing forces a key rotation on each
     * document, so every one accumulates membership AND CGKA history.
     */
    async function seedAccount(peer: Peer, docCount: number): Promise<{ friend: Peer; khDocIds: string[] }> {
      await peer.ops.ensureUserGroup({ create: true });
      const friend = await createOps();
      const friendGroupId = (await friend.ops.ensureUserGroup({ create: true }))!;
      await befriend(peer, friend);
      const khDocIds: string[] = [];
      for (let i = 0; i < docCount; i++) {
        const { khDocId } = await peer.ops.enableSharing(`doc-${i}`);
        await peer.ops.addMember(friendGroupId, khDocId, 'edit');
        for (let n = 0; n < 3; n++) await encrypt(peer, khDocId, `edit ${i}.${n}`);
        khDocIds.push(khDocId);
      }
      return { friend, khDocIds };
    }

    /** The base64 group events of a real (minting) card. */
    async function groupEvents(peer: Peer): Promise<string[]> {
      return JSON.parse(await peer.ops.getContactCard()).groupEvents ?? [];
    }

    /** Prekey ops keyhive holds for our own device — the set every real card adds to. */
    async function ownPrekeyOpCount(peer: Peer): Promise<number> {
      const all = await peer.kh.allAgentEvents();
      let count = 0;
      all.prekeySources.forEach((hashes: Uint8Array[], source: Uint8Array) => {
        if (b64(source) === peer.agentId) count = hashes.length;
      });
      return count;
    }

    it('does not grow with the number of documents', async () => {
      const few = await createOps();
      await seedAccount(few, 1);
      const many = await createOps();
      await seedAccount(many, 10);

      // Every field is fixed-width, so "no growth" is exact equality.
      expect((await many.ops.getContactCard()).length).toBe((await few.ops.getContactCard()).length);
    });

    it('previewContactCard mints nothing, so staging a QR costs no prekey', async () => {
      const peer = await createOps();
      await seedAccount(peer, 1);

      const before = await ownPrekeyOpCount(peer);
      for (let i = 0; i < 5; i++) await peer.ops.previewContactCard();
      expect(await ownPrekeyOpCount(peer)).toBe(before);

      // A real exchange still mints — a key reserved for one contact is the point.
      await peer.ops.getContactCard();
      expect(await ownPrekeyOpCount(peer)).toBeGreaterThan(before);
    });

    it('the preview is close enough to the real payload to show as "~N"', async () => {
      const peer = await createOps();
      await seedAccount(peer, 1);

      const preview = (await peer.ops.previewContactCard()).length;
      const real = (await peer.ops.getContactCard()).length;
      // Never over, and under by at most one 32-byte key: the op the preview
      // borrows is whichever existing one keyhive returns — an add-key op (one
      // key) or a rotate-key op (two) — where a real card is always a rotate.
      // A wildly-off estimate under the QR would mislead.
      expect(real - preview).toBeGreaterThanOrEqual(0);
      expect(real - preview).toBeLessThan(200);
    });

    // Every real card leaves two permanent ops in our own prekey history. They
    // used to ride along in the next card, so the size under the QR climbed by
    // ~480 B per visit to the invite screen, exchange or not.
    it('does not grow when cards are minted repeatedly', async () => {
      const peer = await createOps();
      await seedAccount(peer, 1);

      const first = await groupEvents(peer);
      for (let i = 0; i < 5; i++) await peer.ops.getContactCard();
      expect((await groupEvents(peer)).sort()).toEqual(first.sort());
    });

    it('does not grow while a document is edited', async () => {
      const peer = await createOps();
      const { khDocIds } = await seedAccount(peer, 1);
      const before = await groupEvents(peer);

      for (let i = 0; i < 20; i++) await encrypt(peer, khDocIds[0], `edit ${i}`);
      expect((await groupEvents(peer)).sort()).toEqual(before.sort());
    });

    // The number under the QR is the whole preview envelope, not just
    // groupEvents — so pin that too, or the assertions above could hold while
    // the figure the user reads still crept up through the `card` term.
    it('shows an identical size across edits, envelope and all', async () => {
      const peer = await createOps();
      const { khDocIds } = await seedAccount(peer, 1);
      const before = (await peer.ops.previewContactCard()).length;

      for (let i = 0; i < 20; i++) {
        await encrypt(peer, khDocIds[0], `edit ${i}`);
        // Re-read every iteration: a drift of a few bytes per edit would average
        // out to nothing if only the first and last reading were compared.
        expect((await peer.ops.previewContactCard()).length).toBe(before);
      }
    });

    it('for a single-device account is one group delegation and under 1 KB, however established', async () => {
      const peer = await createOps();
      await seedAccount(peer, 10);
      const bundle = await peer.ops.getContactCard();
      expect(JSON.parse(bundle).groupEvents).toHaveLength(1);
      expect(bundle.length).toBeLessThan(1024);
    });

    it('carries no CGKA ops (the receiver is not a member of our documents)', async () => {
      const peer = await createOps();
      await seedAccount(peer, 5);
      const bundled = await groupEvents(peer);

      // Classify by keyhive's own indices rather than by decoding frames, so a
      // change of wire format cannot make this pass vacuously.
      const all = await peer.kh.allAgentEvents();
      const bytesByHash = new Map<string, string>();
      all.events.forEach((bytes: Uint8Array, hash: Uint8Array) => bytesByHash.set(b64(hash), b64(bytes)));
      const eventsIn = (sources: Map<Uint8Array, Uint8Array[]>) => {
        const out = new Set<string>();
        sources.forEach((hashes) => hashes.forEach((h) => { const e = bytesByHash.get(b64(h)); if (e) out.add(e); }));
        return out;
      };
      const cgka = eventsIn(all.cgkaSources);
      const membership = eventsIn(all.membershipSources);

      expect(cgka.size).toBeGreaterThan(0); // the account really has CGKA history to leak
      expect(bundled.filter((e) => cgka.has(e))).toEqual([]);
      // A real bundle always carries the delegation that defines our group.
      expect(bundled.filter((e) => membership.has(e)).length).toBeGreaterThan(0);
    });

    // keyhive >= 0.6 counts everyone who shares a document with us among the
    // prekey sources it reports for us and for our group. Shipping those put
    // our friends' device ids and prekey histories into a card we hand to
    // strangers, and made it grow with every friend and each of their devices.
    it('does not carry the devices of friends we share documents with', async () => {
      const alice = await createOps();
      await alice.ops.ensureUserGroup({ create: true });
      const alone = await groupEvents(alice);

      const frank = await createOps();
      const frankPhone = await createOps();
      const { groupId: frankGroupId } = await linkDevices(frank, frankPhone);
      const { khDocId } = await shareWithFriend(alice, frank, 'edit');
      await encrypt(alice, khDocId, 'something for frank');
      await shareWithFriend(frank, alice, 'edit'); // and a document shared the other way
      await syncPeers(alice, frank); // alice now holds everything frank does

      const withFriend = await groupEvents(alice);
      for (const id of [frank.agentId, frankPhone.agentId, frankGroupId]) {
        expect(mentions(withFriend, id)).toBe(false);
      }
      expect(withFriend.sort()).toEqual(alone.sort());
    });

    // The assertions above only prove the bundle is small — they cannot catch
    // an over-trim. These two prove what is left is still SUFFICIENT.
    it('still lets a receiver share a document with the sender\'s user-group', async () => {
      const alice = await createOps();
      const bob = await createOps();
      await seedAccount(alice, 5); // history — the case that used to bloat the card

      const aliceGroupId = (await alice.ops.getUserGroupId())!;
      const received = await learnContact(bob, alice);
      expect(received.groupId).toBe(aliceGroupId);

      // Bob shares one of his own documents with Alice's GROUP (never a bare device).
      const { khDocId } = await bob.ops.enableSharing('bob-doc');
      await expect(bob.ops.addMember(aliceGroupId, khDocId, 'edit')).resolves.toBe(true);
      expect(memberOf(await bob.ops.getDocMembers(khDocId), aliceGroupId)?.role).toBe('edit');

      // …and it is usable, not just listed: Alice's device reads what Bob writes.
      const message = await encrypt(bob, khDocId, 'from bob');
      await pushVisibleEvents(bob, alice);
      expect(await decrypt(alice, khDocId, message.bytes)).toBe('from bob');
    });

    it('carries our other devices\' prekeys, so a receiver can encrypt to a device it never met', async () => {
      const laptop = await createOps();
      const phone = await createOps();
      const { groupId } = await linkDevices(laptop, phone);

      const bob = await createOps();
      await learnContact(bob, laptop); // bob only ever exchanges with the laptop
      expect(await knowsDevice(bob, phone.agentId)).toBe(true);

      const { khDocId } = await bob.ops.createKeyhiveDoc();
      await bob.ops.addMember(groupId, khDocId, 'edit');
      const message = await encrypt(bob, khDocId, 'for both devices');

      await pushVisibleEvents(bob, phone);
      expect(await decrypt(phone, khDocId, message.bytes)).toBe('for both devices');
    });
  });

  describe('enableSharing / createKeyhiveDoc', () => {
    it('enableSharing creates a keyhive document, registers it, and persists + syncs', async () => {
      const { ops, fx } = await createOps();
      const { khDocId } = await ops.enableSharing('automerge-doc-123');
      expect(typeof khDocId).toBe('string');
      expect(ops.khDocuments.has(khDocId)).toBe(true);
      expect(fx.calls.persist.length).toBeGreaterThanOrEqual(1);
      expect(fx.calls.syncKeyhive.length).toBeGreaterThanOrEqual(1);
    });

    // The create-doc flow mints the keyhive document first and uses its id bytes
    // as the automerge document id, so the two ids are one value.
    it('createKeyhiveDoc returns the document id as bytes and as base64', async () => {
      const { ops, kh } = await createOps();
      const { khDocId, docIdBytes } = await ops.createKeyhiveDoc();
      expect(docIdBytes).toHaveLength(32);
      expect(b64(docIdBytes)).toBe(khDocId);
      expect(await kh.hasDocument(new DocumentId(docIdBytes))).toBe(true);
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });

    it('enableSharing reuses the document createKeyhiveDoc made instead of minting a second', async () => {
      const { ops, kh } = await createOps();
      const { khDocId: created, docIdBytes } = await ops.createKeyhiveDoc();

      const before = (await kh.reachableDocs()).length;
      const { khDocId } = await ops.enableSharing('am-doc-1', docIdBytes);
      expect(khDocId).toBe(created);
      expect((await kh.reachableDocs()).length).toBe(before);
    });

    it('enableSharing falls back to a new document when the bytes name none it knows', async () => {
      const { ops, kh } = await createOps();
      const stranger = await createOps();
      const foreignDoc = (await stranger.ops.createKeyhiveDoc()).docIdBytes; // a real id, unknown here
      const garbage = crypto.getRandomValues(new Uint8Array(32)); // may not even be a valid id

      for (const bytes of [foreignDoc, garbage]) {
        const before = (await kh.reachableDocs()).length;
        const { khDocId } = await ops.enableSharing('am-doc', bytes);
        expect((await kh.reachableDocs()).length).toBe(before + 1);
        expect(ops.khDocuments.has(khDocId)).toBe(true);
        expect(khDocId).not.toBe(b64(bytes));
      }
    });

    it('enableSharing without bytes creates a new document', async () => {
      const { ops, kh } = await createOps();
      const before = (await kh.reachableDocs()).length;
      const { khDocId } = await ops.enableSharing('am-doc-1');
      expect((await kh.reachableDocs()).length).toBe(before + 1);
      expect(ops.khDocuments.has(khDocId)).toBe(true);
    });
  });

  // A document's authority starts at its root edges, and a root edge can only be
  // minted at creation. These pin why mintDocument names the user-group there.
  describe('document ownership (the user-group as co-root)', () => {
    /** Two devices of one user, both admins of its group; `laptop` founded it. */
    async function twoDevices() {
      const laptop = await createOps();
      const phone = await createOps();
      const { groupId } = await linkDevices(laptop, phone);
      return { laptop, phone, groupId };
    }

    const revokeDeviceFromDoc = (by: Peer, agentId: string, khDocId: string) =>
      by.kh.revokeMember(identifierOf(agentId), true, MemberedId.document(docIdOf(khDocId)));

    it('createKeyhiveDoc makes the user-group a co-root: a direct member whose proof the document itself signed', async () => {
      const peer = await createOps();
      const { khDocId } = await peer.ops.createKeyhiveDoc();
      const groupId = (await peer.ops.getUserGroupId())!;
      const members = await directMembers(peer, khDocId);

      expect([...members.keys()].sort()).toEqual([peer.agentId, groupId].sort());
      for (const id of [groupId, peer.agentId]) {
        const cap = members.get(id);
        expect(cap.can.toString()).toBe('Admin');
        // A root edge: issued by the document's own key, not by a device.
        expect(b64(cap.proof.verifyingKey)).toBe(khDocId);
        expect(b64(cap.proof.delegation.issuer.toBytes())).toBe(khDocId);
      }
    });

    it('the group keeps its access after another admin device revokes the creating device from the document', async () => {
      const { laptop, phone, groupId } = await twoDevices();
      const { khDocId } = await laptop.ops.createKeyhiveDoc();
      await syncAsBridge(laptop, phone);

      // e.g. the laptop is lost and the phone strips it from the document.
      expect(await revokeDeviceFromDoc(phone, laptop.agentId, khDocId)).toHaveLength(1);

      expect([...(await directMembers(phone, khDocId)).keys()]).toEqual([groupId]);
      expect(await phone.ops.getUserGroupAccess(khDocId)).toBe('Admin');
      expect(await phone.ops.getMyAccess(khDocId)).toBe('Admin');
      // The document is still usable, and the group's other devices still read it.
      const message = await encrypt(phone, khDocId, 'still ours');
      await syncPeers(laptop, phone);
      expect(await laptop.ops.getUserGroupAccess(khDocId)).toBe('Admin');
      expect(await decrypt(laptop, khDocId, message.bytes)).toBe('still ours');
    });

    // The alternative mintDocument avoids: create alone, then delegate admin to
    // the group. The group's delegation is then live only while the creating
    // device has standing, and revoking that device takes the group with it.
    it('contrast: a group that was only DELEGATED admin loses the document when the creating device is revoked', async () => {
      const { laptop, phone, groupId } = await twoDevices();
      const docId = await laptop.kh.generateDocument([], new ChangeId(new Uint8Array(32)), []);
      const khDocId = b64(docId.toBytes());
      await laptop.kh.addMember(identifierOf(groupId), MemberedId.document(docId), Power.admin());
      await syncPeers(laptop, phone);

      const group = (await directMembers(phone, khDocId)).get(groupId);
      expect(b64(group.proof.verifyingKey)).toBe(laptop.agentId); // delegated by a device, not a root edge
      expect(await phone.ops.getUserGroupAccess(khDocId)).toBe('Admin');

      expect(await revokeDeviceFromDoc(phone, laptop.agentId, khDocId)).toHaveLength(1);

      expect((await directMembers(phone, khDocId)).size).toBe(0);
      expect(await phone.ops.getUserGroupAccess(khDocId)).toBeNull();
      expect(await phone.ops.getMyAccess(khDocId)).toBeNull();
      await expect(encrypt(phone, khDocId, 'orphaned')).rejects.toThrow(/Group has no members/);
    });
  });

  describe('cross-peer encryption', () => {
    /**
     * Alice owns a document and Bob's device is a direct member of it — the
     * shortest way to two devices in one key tree (see shareDocWithDevice).
     */
    async function sharedDoc(role = 'edit') {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, role);
      return { alice, bob, khDocId };
    }

    it('the owner encrypts and the member decrypts', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const message = await encrypt(alice, khDocId, 'hello from alice');
      await syncPeers(alice, bob);
      expect(await decrypt(bob, khDocId, message.bytes)).toBe('hello from alice');
    });

    it('the member encrypts and the owner decrypts', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const message = await encrypt(bob, khDocId, 'hello from bob');
      expect(await decrypt(bob, khDocId, message.bytes)).toBe('hello from bob'); // and reads its own
      await syncPeers(alice, bob);
      expect(await decrypt(alice, khDocId, message.bytes)).toBe('hello from bob');
    });

    it('ciphertext round-trips through its wire bytes inside a larger frame', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const plaintext = crypto.getRandomValues(new Uint8Array(4096)); // binary, not just text
      const result = await alice.kh.tryEncrypt(docIdOf(khDocId), new ChangeId(crypto.getRandomValues(new Uint8Array(32))), [], plaintext);

      // What a transport does: a tag byte, then Encrypted.toBytes().
      const encBytes = result.encryptedContent().toBytes();
      const wire = new Uint8Array(1 + encBytes.length);
      wire[0] = 0x01;
      wire.set(encBytes, 1);

      await syncPeers(alice, bob);
      const decrypted = await bob.kh.tryDecrypt(docIdOf(khDocId), Encrypted.fromBytes(wire.slice(1)));
      expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    });

    // Mirrors the engine's presence crypto (engine-presence.ts): a JSON value,
    // a fresh content ref, no predecessors, the document's key.
    it('a presence-style JSON value round-trips between members', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const value = { viewing: true, focusedField: ['events', 'uid-123', 'title'], userGroupId: 'abc=' };

      const fromAlice = await encrypt(alice, khDocId, JSON.stringify(value));
      await syncPeers(alice, bob);
      expect(JSON.parse(await decrypt(bob, khDocId, fromAlice.bytes))).toEqual(value);

      // `null` is what a cleared channel broadcasts.
      const cleared = await encrypt(bob, khDocId, JSON.stringify(null));
      await syncPeers(alice, bob);
      expect(JSON.parse(await decrypt(alice, khDocId, cleared.bytes))).toBeNull();
    });

    it('three members all read each other', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const carol = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, 'edit');
      await shareDocWithDevice(alice, khDocId, carol, 'edit');
      const peers = [alice, bob, carol];
      // Bob and Carol never exchange cards: everything reaches them through Alice.
      const syncAll = async () => {
        for (let round = 0; round < 2; round++) for (const other of [bob, carol]) await syncPeers(alice, other);
      };
      await syncAll();
      for (const peer of [bob, carol]) expect((await peer.kh.reachableDocs()).length).toBe(1);

      for (const [i, writer] of peers.entries()) {
        const message = await encrypt(writer, khDocId, `from peer ${i}`);
        await syncAll();
        for (const reader of peers) expect(await decrypt(reader, khDocId, message.bytes)).toBe(`from peer ${i}`);
      }
    });

    it('a member added later can read what was written before it joined, across earlier key epochs', async () => {
      const alice = await createOps();
      const xavier = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();

      const alone = await encrypt(alice, khDocId, 'written alone');
      await shareDocWithDevice(alice, khDocId, xavier, 'edit');
      const withXavier = await encrypt(alice, khDocId, 'written with xavier'); // a later epoch
      expect(withXavier.newEpoch).toBe(true);

      // Bob joins after both, and is handed nothing but the usual sync.
      const bob = await createOps();
      await shareDocWithDevice(alice, khDocId, bob, 'read');
      expect(await decrypt(bob, khDocId, alone.bytes)).toBe('written alone');
      expect(await decrypt(bob, khDocId, withXavier.bytes)).toBe('written with xavier');
    });

    // The window the engine's presence retry exists for: ciphertext is on the
    // wire at once, the key material behind it follows with keyhive sync.
    it('ciphertext from a key epoch the reader has not synced yet is "Key not found", then decrypts once it arrives', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const message = await encrypt(alice, khDocId, 'first after the share');
      expect(message.newEpoch).toBe(true); // adding Bob forced a rotation

      await expect(decrypt(bob, khDocId, message.bytes)).rejects.toThrow('Key not found');
      await syncPeers(alice, bob);
      expect(await decrypt(bob, khDocId, message.bytes)).toBe('first after the share');

      // Within an epoch nothing more has to travel.
      const next = await encrypt(alice, khDocId, 'same epoch');
      expect(next.newEpoch).toBe(false);
      expect(await decrypt(bob, khDocId, next.bytes)).toBe('same epoch');
    });

    // engine-presence.ts reads `updateOp()` as "this encrypt minted key material
    // the peer does not have" and pushes a keyhive sync when it is set. Measured
    // on 0.8.0, that is not what it reports: a member's FIRST encrypt always
    // starts a new epoch (its leaf was placed by whoever added it) yet leaves
    // updateOp() unset — and the owner's own post-share rotation leaves it unset
    // now and then too. The emitted CGKA_OPERATION event is the reliable signal.
    // If this starts failing because updateOp() is set, the engine's check is
    // sufficient again; until then it under-fires.
    it('a new key epoch is not always reported by updateOp()', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const pcsKeyOf = (c: { bytes: Uint8Array }) => b64(Encrypted.fromBytes(c.bytes).pcsKeyHash);
      // Bob holds the current key: he has read something encrypted under it.
      const fromAlice = await encrypt(alice, khDocId, 'alice writes');
      await syncPeers(alice, bob);
      expect(await decrypt(bob, khDocId, fromAlice.bytes)).toBe('alice writes');

      const fromBob = await encrypt(bob, khDocId, 'bob\'s first write');

      expect(fromBob.newEpoch).toBe(true);
      expect(pcsKeyOf(fromBob)).not.toBe(pcsKeyOf(fromAlice));
      expect(fromBob.updateOp).toBe(false);
      // …and the peer really does need that op before it can read the message.
      await expect(decrypt(alice, khDocId, fromBob.bytes)).rejects.toThrow('Key not found');
      await syncPeers(alice, bob);
      expect(await decrypt(alice, khDocId, fromBob.bytes)).toBe('bob\'s first write');

      // Only the first: Bob's later writes stay in the epoch he started.
      const second = await encrypt(bob, khDocId, 'bob again');
      expect(second.newEpoch).toBe(false);
      expect(await decrypt(alice, khDocId, second.bytes)).toBe('bob again');
    });

    // A rekey that arrives from a peer updates the tree, and the next local
    // operation must be able to use it whichever operation that is. (An encrypt
    // straight after a remote rekey, with no decrypt in between, used to trap.)
    it('a member whose first operation after a remote rekey is an encrypt succeeds, and the owner reads it', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const rekey = await encrypt(alice, khDocId, 'rotates the key');
      expect(rekey.newEpoch).toBe(true);
      await syncPeers(alice, bob); // Bob ingests the rekey and decrypts nothing

      const fromBob = await encrypt(bob, khDocId, 'bob writes first');
      await syncPeers(alice, bob);
      expect(await decrypt(alice, khDocId, fromBob.bytes)).toBe('bob writes first');
      expect(await decrypt(bob, khDocId, rekey.bytes)).toBe('rotates the key');
    });

    it('a revoked member cannot read what is written afterwards; the remaining members can', async () => {
      const { alice, bob, khDocId } = await sharedDoc();
      const carol = await createOps();
      await shareDocWithDevice(alice, khDocId, carol, 'edit');
      const before = await encrypt(alice, khDocId, 'while carol was a member');
      for (const peer of [bob, carol]) await syncPeers(alice, peer);
      expect(await decrypt(carol, khDocId, before.bytes)).toBe('while carol was a member');

      await alice.kh.revokeMember(carol.kh.id.toIdentifier(), true, MemberedId.document(docIdOf(khDocId)));
      const after = await encrypt(alice, khDocId, 'after carol left');
      expect(after.newEpoch).toBe(true);
      for (const peer of [bob, carol]) await syncPeers(alice, peer); // carol is handed everything alice has

      expect(await decrypt(bob, khDocId, after.bytes)).toBe('after carol left');
      await expect(decrypt(carol, khDocId, after.bytes)).rejects.toThrow('Key not found');
      expect(await rawAccess(carol, carol.agentId, khDocId)).toBeUndefined();
      // Revocation is not retroactive: what she could read, she still can.
      expect(await decrypt(carol, khDocId, before.bytes)).toBe('while carol was a member');

      // Bob's reply goes to the remaining members only.
      const reply = await encrypt(bob, khDocId, 'bob replies');
      for (const peer of [bob, carol]) await syncPeers(alice, peer);
      expect(await decrypt(alice, khDocId, reply.bytes)).toBe('bob replies');
      await expect(decrypt(carol, khDocId, reply.bytes)).rejects.toThrow('Key not found');
    });

    describe('across a reload', () => {
      it('a clean reload (same signer, fully saved state) keeps every key, old and new', async () => {
        const { alice, bob, khDocId } = await sharedDoc();
        const fromAlice = await encrypt(alice, khDocId, 'before the reload');
        await syncPeers(alice, bob);
        const fromBob = await encrypt(bob, khDocId, 'bob, before the reload');
        await syncPeers(alice, bob);

        const bob2 = await reload(bob);
        expect(bob2.agentId).toBe(bob.agentId);
        expect(await decrypt(bob2, khDocId, fromAlice.bytes)).toBe('before the reload');
        expect(await decrypt(bob2, khDocId, fromBob.bytes)).toBe('bob, before the reload');

        const afterReload = await encrypt(alice, khDocId, 'after the reload');
        await syncPeers(alice, bob2);
        expect(await decrypt(bob2, khDocId, afterReload.bytes)).toBe('after the reload');
        const reply = await encrypt(bob2, khDocId, 'bob, after the reload');
        await syncPeers(alice, bob2);
        expect(await decrypt(alice, khDocId, reply.bytes)).toBe('bob, after the reload');
      });

      // The restart keyhive-repo.ts's archive save makes rare, and what happens
      // when it occurs anyway. The bridge writes every emitted event to storage
      // at once but the archive (which holds the leaf secrets) only now and
      // then — so a restart can find a rotation's OP on disk and the SECRET
      // behind it gone. Under alpha.58 that wedged the instance for good
      // ("SecretKey not found" on every encrypt). keyhive >= 0.6 rotates again
      // when it cannot derive the current secret, so the instance heals on its
      // next encrypt; the app still saves the archive shortly after each event
      // because the lost epoch itself stays unreadable (next test).
      it.each([
        ['a member', 'bob'],
        ['the owner', 'alice'],
      ] as const)('%s reloaded from a STALE archive heals on its next encrypt', async (_label, who) => {
        const { alice, bob, khDocId } = await sharedDoc();
        const restarted = who === 'bob' ? bob : alice;
        const other = who === 'bob' ? alice : bob;

        // What is on disk: an archive and prekey secrets from BEFORE the encrypt…
        const staleArchive = (await restarted.kh.toArchive()).toBytes();
        const stalePrekeys = await restarted.kh.exportPrekeySecrets();
        const mark = restarted.emitted.length;
        const lost = await encrypt(restarted, khDocId, 'minted a rotation');
        expect(lost.newEpoch).toBe(true);
        // …plus the events emitted since, which include that rotation's op.
        const eventsSince = restarted.emitted.slice(mark);
        expect(eventsSince.length).toBeGreaterThan(0);
        await syncPeers(alice, bob);
        expect(await decrypt(other, khDocId, lost.bytes)).toBe('minted a rotation');

        const back = await reload(restarted, { archive: staleArchive, prekeySecrets: stalePrekeys, events: eventsSince });
        expect(back.agentId).toBe(restarted.agentId);

        // It cannot derive the epoch it minted, so it starts another — no throw.
        const healed = await encrypt(back, khDocId, 'after the stale reload');
        expect(healed.newEpoch).toBe(true);
        await syncPeers(back, other);
        expect(await decrypt(other, khDocId, healed.bytes)).toBe('after the stale reload');

        // And it reads the peer again.
        const reply = await encrypt(other, khDocId, 'welcome back');
        await syncPeers(back, other);
        expect(await decrypt(back, khDocId, reply.bytes)).toBe('welcome back');
      });

      // The whole cost of the stale reload above: one's own ciphertext from the
      // lost epoch. Fine for presence (re-broadcast on every change); document
      // content does not go through this path.
      it('a member reloaded from a stale archive loses only its own ciphertext from the lost epoch', async () => {
        const { alice, bob, khDocId } = await sharedDoc();
        const staleArchive = (await bob.kh.toArchive()).toBytes();
        const stalePrekeys = await bob.kh.exportPrekeySecrets();
        const mark = bob.emitted.length;
        const lost = await encrypt(bob, khDocId, 'from the lost epoch');
        await syncPeers(alice, bob);

        const bob2 = await reload(bob, { archive: staleArchive, prekeySecrets: stalePrekeys, events: bob.emitted.slice(mark) });
        await expect(decrypt(bob2, khDocId, lost.bytes)).rejects.toThrow('Key not found');
        // Alice, who was never restarted, still reads it.
        expect(await decrypt(alice, khDocId, lost.bytes)).toBe('from the lost epoch');
      });
    });
  });

  // khAccessCheck (keyhive-repo.ts) decides whether a peer is told a document
  // exists: it rebuilds an Identifier from the verifying key in the peer's id
  // and asks accessForDoc. A wrong answer here is a document that silently
  // never syncs, or one announced to someone with no right to it.
  describe('accessForDoc (the share gate\'s inputs)', () => {
    it('a device\'s keyhive id is its signer\'s verifying key, before and after a reload', async () => {
      const peer = await createOps();
      expect(b64(peer.kh.id.toBytes())).toBe(b64(peer.signer.verifyingKey));
      expect(b64(peer.kh.whoami.toBytes())).toBe(b64(peer.signer.verifyingKey));

      await peer.ops.createKeyhiveDoc();
      const again = await reload(peer);
      expect(b64(again.kh.id.toBytes())).toBe(b64(peer.signer.verifyingKey));
    });

    it('an Identifier built from the verifying key sees the same access as kh.id, in both directions', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, 'read');
      const docId = docIdOf(khDocId);
      const power = async (kh: Peer['kh'], id: Identifier) => (await kh.accessForDoc(id, docId))?.toString();

      // Bob's gate, asked about Alice.
      expect(await power(bob.kh, alice.kh.id.toIdentifier())).toBe('Admin');
      expect(await power(bob.kh, new Identifier(alice.signer.verifyingKey))).toBe('Admin');
      // Alice's gate, asked about Bob.
      expect(await power(alice.kh, bob.kh.id.toIdentifier())).toBe('Read');
      expect(await power(alice.kh, new Identifier(bob.signer.verifyingKey))).toBe('Read');
    });

    // Sharing is with a friend's GROUP, but the gate is asked about a DEVICE.
    // If keyhive did not follow the group, the granter would drop all sync to
    // the friend and the friend would never see the document.
    it('resolves a device\'s access through its user-group, on the granter\'s side and the friend\'s', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');

      expect(await rawAccess(alice, bob.agentId, khDocId)).toBe('Edit');
      expect(await rawAccess(alice, friendGroupId, khDocId)).toBe('Edit');
      expect(await rawAccess(bob, bob.agentId, khDocId)).toBe('Edit');
      expect(await rawAccess(bob, alice.agentId, khDocId)).toBe('Admin');
    });

    it('reports no access for an identifier that was never granted any', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await shareWithFriend(alice, bob, 'edit');
      const stranger = await createOps();

      for (const peer of [alice, bob]) {
        expect(await peer.kh.accessForDoc(new Identifier(stranger.signer.verifyingKey), docIdOf(khDocId))).toBeUndefined();
      }
      // Knowing the stranger's card changes nothing.
      await exchangeCards(alice, stranger);
      expect(await rawAccess(alice, stranger.agentId, khDocId)).toBeUndefined();
    });

    it('access survives a same-signer reload, on both sides of the gate', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');

      // The granter restarts: its gate still admits the friend's device.
      const alice2 = await reload(alice);
      expect(await rawAccess(alice2, bob.agentId, khDocId)).toBe('Edit');
      expect(await rawAccess(alice2, friendGroupId, khDocId)).toBe('Edit');
      expect(await alice2.ops.getMyAccess(khDocId)).toBe('Admin');
      expect(await alice2.ops.getUserGroupAccess(khDocId)).toBe('Admin');

      // The friend still recognises the restarted granter after another sync.
      await syncAsBridge(alice2, bob);
      expect(await rawAccess(bob, alice2.agentId, khDocId)).toBe('Admin');

      // And the friend's own restart keeps what it was granted.
      const bob2 = await reload(bob);
      expect(await bob2.ops.getMyAccess(khDocId)).toBe('Edit');
      expect(await rawAccess(bob2, alice.agentId, khDocId)).toBe('Admin');
    });

    // Power is attenuated along a chain: a member can pass on no more than the
    // weakest link above it. Without that, admin of a nested group would read as
    // admin of every document any outer group can merely read.
    it('attenuates through nested groups: doc ─Read→ group ─Admin→ group ─Admin→ device is Read', async () => {
      const alice = await createOps();
      const carol = await createOps();
      await exchangeCards(alice, carol);
      const docId = await alice.kh.generateDocument([], new ChangeId(new Uint8Array(32)), []);
      const khDocId = b64(docId.toBytes());
      const outer = await alice.kh.generateGroup([]);
      const inner = await alice.kh.generateGroup([]);
      await alice.kh.addMember(outer.toIdentifier(), MemberedId.document(docId), Power.read());
      await alice.kh.addMember(inner.toIdentifier(), MemberedId.group(outer), Power.admin());
      await alice.kh.addMember(carol.kh.id.toIdentifier(), MemberedId.group(inner), Power.admin());

      expect(await rawAccess(alice, carol.agentId, khDocId)).toBe('Read');
      expect(await rawAccess(alice, b64(inner.toBytes()), khDocId)).toBe('Read');
      // transitiveMembers() — what KeyhiveOps reads its own power from — agrees.
      const transitive = await (await alice.kh.getDocument(docId))!.transitiveMembers();
      const carolEntry = transitive.find((m: any) => b64(m.who.id.toBytes()) === carol.agentId);
      expect(carolEntry?.can.toString()).toBe('Read');

      // And Carol's own keyhive reaches the same answer once it has the ops.
      await syncPeers(alice, carol);
      expect(await rawAccess(carol, carol.agentId, khDocId)).toBe('Read');
    });
  });

  describe('getDocMembers / getKnownFriends', () => {
    it('marks the user-group as "me" with its devices, and hides the device the group covers', async () => {
      const { ops, agentId } = await createOps();
      const { khDocId } = await ops.enableSharing('doc');
      const groupId = (await ops.getUserGroupId())!;

      const members = await ops.getDocMembers(khDocId);
      // The creating device is a root member too, but the group stands in for it.
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ agentId: groupId, type: 'group', role: 'admin', isMe: true, deviceIds: [agentId] });
    });

    it('lists a friend\'s group as a group with all of its devices', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bobPhone = await createOps();
      await linkDevices(bob, bobPhone);
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');

      const friend = memberOf(await alice.ops.getDocMembers(khDocId), friendGroupId);
      expect(friend).toMatchObject({ type: 'group', role: 'edit', isMe: false });
      // Alice never met Bob's phone: it reached her inside Bob's bundle.
      expect([...(friend as any).deviceIds].sort()).toEqual([bob.agentId, bobPhone.agentId].sort());
    });

    it('hides a device that is also a direct member when its group is present', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
      // Not something the app does (sharing is group-only), but older documents
      // and other clients can leave a device granted directly as well.
      await alice.kh.addMember(identifierOf(bob.agentId), MemberedId.document(docIdOf(khDocId)), Power.read());
      expect((await directMembers(alice, khDocId)).has(bob.agentId)).toBe(true);

      const members = await alice.ops.getDocMembers(khDocId);
      expect(memberOf(members, bob.agentId)).toBeUndefined();
      expect(memberOf(members, friendGroupId)?.role).toBe('edit');
    });

    it('lists a directly-granted device as an individual when no group covers it', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, 'read');

      const entry = memberOf(await alice.ops.getDocMembers(khDocId), bob.agentId);
      expect(entry).toMatchObject({ type: 'individual', role: 'read', isMe: false });
    });

    // The window where a document's membership has synced but the ops of one
    // member group have not: the id is in doc.members() yet is neither a group
    // nor an individual this keyhive knows. Sharing is group-only, so it is
    // shown as a group with no devices rather than dropped or called a device.
    it('reports a member that is neither a known group nor a known individual as a group with no devices', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const carol = await createOps();
      const { khDocId, friendGroupId: bobGroupId } = await shareWithFriend(alice, bob, 'edit');
      // Alice then adds Carol's group; Bob has not heard about it yet.
      const { friendGroupId: carolGroupId } = await shareWithFriend(alice, carol, 'read', khDocId);
      expect(memberOf(await bob.ops.getDocMembers(khDocId), carolGroupId)).toBeUndefined();

      // Bob receives everything Alice has EXCEPT the ops that define Carol's
      // group and Carol's device.
      const all = await alice.kh.allAgentEvents();
      const withheld = new Set<string>();
      all.membershipSources.forEach((hashes: Uint8Array[], source: Uint8Array) => {
        if (b64(source) === carolGroupId) hashes.forEach((h) => withheld.add(b64(h)));
      });
      all.prekeySources.forEach((hashes: Uint8Array[], source: Uint8Array) => {
        if (b64(source) === carol.agentId) hashes.forEach((h) => withheld.add(b64(h)));
      });
      expect(withheld.size).toBeGreaterThan(0);
      const delivered: Uint8Array[] = [];
      all.events.forEach((bytes: Uint8Array, hash: Uint8Array) => { if (!withheld.has(b64(hash))) delivered.push(bytes); });
      await bob.kh.ingestEventsBytes(delivered);

      expect(await knowsGroup(bob, carolGroupId)).toBe(false);
      expect(await knowsDevice(bob, carol.agentId)).toBe(false);
      const members = await bob.ops.getDocMembers(khDocId);
      expect(memberOf(members, carolGroupId)).toMatchObject({ type: 'group', role: 'read', isMe: false, deviceIds: [] });
      // The members it does know are unaffected.
      expect(memberOf(members, bobGroupId)).toMatchObject({ type: 'group', role: 'edit', isMe: true, deviceIds: [bob.agentId] });
      // An id it cannot resolve is not offered as someone to share with.
      expect(memberOf(await bob.ops.getKnownFriends(), carolGroupId)).toBeUndefined();

      // Once the rest arrives the same entry fills in.
      await syncPeers(alice, bob);
      expect(memberOf(await bob.ops.getDocMembers(khDocId), carolGroupId))
        .toMatchObject({ type: 'group', role: 'read', deviceIds: [carol.agentId] });
    });

    it('does not list a relay-only grant: it can carry the ciphertext but not read it', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'relay' as any);

      expect(await rawAccess(alice, friendGroupId, khDocId)).toBe('Relay');
      expect(memberOf(await alice.ops.getDocMembers(khDocId), friendGroupId)).toBeUndefined();
      expect(memberOf(await alice.ops.getKnownFriends(), friendGroupId)).toBeUndefined();
    });

    it('getKnownFriends lists the friend group a document is shared with — not our own group, not that document\'s members', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
      const aliceGroupId = (await alice.ops.getUserGroupId())!;

      const friends = await alice.ops.getKnownFriends();
      expect(friends.map((f) => f.agentId)).toEqual([friendGroupId]);
      expect(friends[0]).toMatchObject({ type: 'group', role: 'edit', isMe: false });
      // From Bob's side the friend is Alice's group.
      expect((await bob.ops.getKnownFriends()).map((f) => f.agentId)).toEqual([aliceGroupId]);

      // The "add people" picker for a document excludes who is already on it.
      expect(await alice.ops.getKnownFriends(khDocId)).toEqual([]);
      const { khDocId: other } = await alice.ops.createKeyhiveDoc();
      expect((await alice.ops.getKnownFriends(other)).map((f) => f.agentId)).toEqual([friendGroupId]);
    });

    it('getKnownFriends lists a stored friend who is on no document yet as their user-group', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bobGroupId = (await bob.ops.ensureUserGroup({ create: true }))!;
      await befriend(alice, bob);
      const aliceGroupId = (await alice.ops.ensureUserGroup({ create: true }))!;

      // The friend list (DriveSettings) stores user-group ids; our own is skipped.
      const friends = await alice.ops.getKnownFriends(undefined, [bobGroupId, aliceGroupId]);
      expect(friends).toHaveLength(1);
      expect(friends[0]).toMatchObject({ agentId: bobGroupId, type: 'group', isMe: false, deviceIds: [] });
      expect(friends[0].role).toBeUndefined();
    });
  });

  describe('getMyAccess / getUserGroupAccess', () => {
    it('are Admin for the document owner, through the device and through the group', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      expect(await ops.getMyAccess(khDocId)).toBe('Admin');
      expect(await ops.getUserGroupAccess(khDocId)).toBe('Admin');
    });

    it('report the role a friend granted', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await shareWithFriend(alice, bob, 'read');
      expect(await bob.ops.getMyAccess(khDocId)).toBe('Read');
      expect(await bob.ops.getUserGroupAccess(khDocId)).toBe('Read');
    });

    // Relay power lets a peer hold and forward ciphertext. It is not access to
    // the document, and a document must not appear on the home page because of it.
    it('are null for a relay-only grant, and the document stays off the home set', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await shareWithFriend(alice, bob, 'relay' as any);
      expect(await rawAccess(bob, bob.agentId, khDocId)).toBe('Relay'); // keyhive does report the grant

      expect(await bob.ops.getMyAccess(khDocId)).toBeNull();
      expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
      const { accessibleKhIds, reachableKhIds } = await bob.ops.enumerateUserDocs();
      expect(reachableKhIds).toContain(khDocId);
      expect(accessibleKhIds).not.toContain(khDocId);

      // And it really cannot read: no key reaches a relay.
      const message = await encrypt(alice, khDocId, 'not for relays');
      await syncPeers(alice, bob);
      await expect(decrypt(bob, khDocId, message.bytes)).rejects.toThrow('Key not found');
    });

    it('getUserGroupAccess is null without a user-group', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, 'edit'); // bob has device access but no group
      expect(await bob.ops.getMyAccess(khDocId)).toBe('Edit');
      expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
    });
  });

  describe('registerSharingGroup', () => {
    it('restores a document into khDocuments after a restart, and leaves an unknown one unregistered', async () => {
      const peer = await createOps();
      const { khDocId } = await peer.ops.enableSharing('doc-1');

      // khDocuments is in-memory: a restarted KeyhiveOps starts with none.
      const restarted = await reload(peer);
      expect(restarted.ops.khDocuments.has(khDocId)).toBe(false);
      await expect(restarted.ops.revokeMember('anyone', khDocId)).rejects.toThrow('Document not found');

      expect(await restarted.ops.registerSharingGroup(khDocId)).toBe(true);
      expect(restarted.ops.khDocuments.has(khDocId)).toBe(true);

      const stranger = await createOps();
      const { khDocId: foreign } = await stranger.ops.createKeyhiveDoc();
      expect(await restarted.ops.registerSharingGroup(foreign)).toBe(true);
      expect(restarted.ops.khDocuments.has(foreign)).toBe(false);
    });
  });

  describe('device linking', () => {
    // The handshake has two legs and the UI must tell them apart: the new device
    // shows a return link (linked=false), the original shows "Linking complete".
    it('linkDevice reports linked=false on the new device until the original adds it, then linked=true on the original', async () => {
      const original = await createOps();
      const added = await createOps();

      const { groupId, firstLeg, secondLeg } = await linkDevices(original, added);

      // Leg 1: the new device has only adopted the id — it is not a member yet.
      expect(firstLeg).toEqual({ userGroupId: groupId, linked: false });
      // Leg 2: the original (admin) added it.
      expect(secondLeg).toEqual({ userGroupId: groupId, linked: true });
      expect(await added.ops.getUserGroupId()).toBe(groupId);

      const devices = await original.ops.listGroupDevices();
      expect(deviceOf(devices, added.agentId)).toMatchObject({ role: 'admin', isMe: false });
      // The new device sees its own membership once the group ops reach it.
      expect(deviceOf(await added.ops.listGroupDevices(), added.agentId)).toMatchObject({ role: 'admin', isMe: true });
    });

    it('the new device adopts the group without waiting when the bundle carried it', async () => {
      const original = await createOps();
      const added = await createOps();
      const groupId = (await original.ops.ensureUserGroup({ create: true }))!;
      await learnContact(added, original);

      // linkDevice polls (3 s a round) for a group it cannot resolve. The bundle
      // carries the group's ops precisely so the first leg does not sit there.
      const started = Date.now();
      await added.ops.linkDevice(original.agentId, groupId);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await knowsGroup(added, groupId)).toBe(true);
    });

    it('a peer with no group on either side: the first to link creates one and adds the other', async () => {
      const first = await createOps();
      const second = await createOps();
      await learnContact(first, second);

      const result = await first.ops.linkDevice(second.agentId, null);
      expect(result.linked).toBe(true);
      expect(result.userGroupId).toBe(await first.ops.getUserGroupId());
      expect((await first.ops.listGroupDevices()).map((d) => d.agentId).sort()).toEqual([first.agentId, second.agentId].sort());
    });

    it('two devices that each already have a group converge on one id, and its owner adds the other', async () => {
      const one = await createOps();
      const two = await createOps();
      const groupOne = (await one.ops.ensureUserGroup({ create: true }))!;
      const groupTwo = (await two.ops.ensureUserGroup({ create: true }))!;
      await befriend(one, two);

      const resultOne = await one.ops.linkDevice(two.agentId, groupTwo);
      const resultTwo = await two.ops.linkDevice(one.agentId, groupOne);

      // The smaller id wins on both sides, whichever order they link in.
      const canonical = groupOne < groupTwo ? groupOne : groupTwo;
      expect(resultOne.userGroupId).toBe(canonical);
      expect(resultTwo.userGroupId).toBe(canonical);
      const owner = canonical === groupOne ? one : two;
      const joiner = owner === one ? two : one;
      expect((owner === one ? resultOne : resultTwo).linked).toBe(true);
      expect(deviceOf(await owner.ops.listGroupDevices(), joiner.agentId)?.role).toBe('admin');
    });

    it('after linking, both devices see the same documents with the same access — made before, after, and by the new device', async () => {
      const laptop = await createOps();
      const phone = await createOps();
      const { khDocId: before } = await laptop.ops.createKeyhiveDoc();
      await linkDevices(laptop, phone);
      const { khDocId: after } = await laptop.ops.createKeyhiveDoc();
      const { khDocId: byPhone } = await phone.ops.createKeyhiveDoc();
      await syncAsBridge(laptop, phone);

      for (const device of [laptop, phone]) {
        const { accessibleKhIds } = await device.ops.enumerateUserDocs();
        expect([...accessibleKhIds].sort()).toEqual([before, after, byPhone].sort());
        for (const khDocId of [before, after, byPhone]) {
          expect(await device.ops.getUserGroupAccess(khDocId)).toBe('Admin');
          expect(await device.ops.getMyAccess(khDocId)).toBe('Admin');
        }
      }
    });

    // Membership through the group is not enough on its own: the document's key
    // tree has to take the new device in, or it could list a document it cannot open.
    it('a linked device reads a document from before the link, and the two devices read each other', async () => {
      const laptop = await createOps();
      const phone = await createOps();
      const { khDocId } = await laptop.ops.createKeyhiveDoc();
      const old = await encrypt(laptop, khDocId, 'written before the phone existed');
      await linkDevices(laptop, phone);

      const cgkaMembers = await (await laptop.kh.getDocument(docIdOf(khDocId)))!.cgkaMembers();
      expect(cgkaMembers.map((id: Identifier) => b64(id.toBytes())).sort()).toEqual([laptop.agentId, phone.agentId].sort());
      expect(await decrypt(phone, khDocId, old.bytes)).toBe('written before the phone existed');

      const fromLaptop = await encrypt(laptop, khDocId, 'laptop, after the link');
      await syncAsBridge(laptop, phone);
      expect(await decrypt(phone, khDocId, fromLaptop.bytes)).toBe('laptop, after the link');

      const fromPhone = await encrypt(phone, khDocId, 'phone');
      await syncAsBridge(laptop, phone);
      expect(await decrypt(laptop, khDocId, fromPhone.bytes)).toBe('phone');
    });
  });

  describe('sharing with a friend (addMember / changeRole / revokeMember)', () => {
    it('addMember fires forceResyncAllPeers once, after syncKeyhive', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bobGroupId = (await bob.ops.ensureUserGroup({ create: true }))!;
      await befriend(alice, bob);
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      const mark = alice.fx.order.length;

      await alice.ops.addMember(bobGroupId, khDocId, 'edit');

      // forceResyncAllPeers makes the repo re-evaluate who may see the document;
      // without it the friend gets nothing until the next edit. The membership
      // ops have to be on their way first, or the re-evaluation announces a
      // document the friend's keyhive cannot yet place.
      const fired = alice.fx.order.slice(mark);
      expect(fired.filter((name) => name === 'forceResyncAllPeers')).toHaveLength(1);
      expect(fired.lastIndexOf('syncKeyhive')).toBeGreaterThanOrEqual(0);
      expect(fired.indexOf('forceResyncAllPeers')).toBeGreaterThan(fired.lastIndexOf('syncKeyhive'));
      expect(fired).toContain('persist');
    });

    // Sharing with a GROUP reaches a DEVICE only if the bridge's per-agent sync
    // sends that device the document's ops and key material. (Under alpha.58 it
    // did not: "ShareKey not found", and the friend's Share panel never showed
    // the friend.)
    it('a shared document reaches the friend\'s device over per-agent sync, and both sides read each other', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await shareWithFriend(alice, bob, 'edit'); // ends with syncAsBridge

      expect((await bob.kh.reachableDocs()).map((s: any) => b64(s.doc.docId.toBytes()))).toEqual([khDocId]);
      expect(await bob.ops.getMyAccess(khDocId)).toBe('Edit');

      const fromAlice = await encrypt(alice, khDocId, 'shared with bob\'s group');
      await syncAsBridge(alice, bob);
      expect(await decrypt(bob, khDocId, fromAlice.bytes)).toBe('shared with bob\'s group');

      const fromBob = await encrypt(bob, khDocId, 'bob edits');
      await syncAsBridge(alice, bob);
      expect(await decrypt(alice, khDocId, fromBob.bytes)).toBe('bob edits');
    });

    it('the friend sees their own group in the member list, as "me", next to the owner\'s', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
      const aliceGroupId = (await alice.ops.getUserGroupId())!;

      const onBob = await bob.ops.getDocMembers(khDocId);
      expect(memberOf(onBob, friendGroupId)).toMatchObject({ type: 'group', role: 'edit', isMe: true, deviceIds: [bob.agentId] });
      expect(memberOf(onBob, aliceGroupId)).toMatchObject({ type: 'group', role: 'admin', isMe: false, deviceIds: [alice.agentId] });
      // And the owner's panel shows the same two entries.
      const onAlice = await alice.ops.getDocMembers(khDocId);
      expect(onAlice.map((m) => [m.agentId, m.role]).sort()).toEqual(onBob.map((m) => [m.agentId, m.role]).sort());
    });

    // open-doc turns an automerge document id back into the keyhive DocumentId
    // with the same bytes; the friend must find the document that way.
    it('the friend finds the keyhive document from the id bytes alone and can register it', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, docIdBytes } = await alice.ops.createKeyhiveDoc();
      await shareWithFriend(alice, bob, 'edit', khDocId);

      const doc = await bob.kh.getDocument(new DocumentId(docIdBytes));
      expect(doc).toBeDefined();
      expect(b64(doc!.docId.toBytes())).toBe(khDocId);
      await bob.ops.registerSharingGroup(khDocId);
      expect(bob.ops.khDocuments.has(khDocId)).toBe(true);
    });

    // A group never syncs to a non-member, so the contact bundle is the ONLY
    // way a sharer learns a friend's group. If receiveContactCard stopped
    // ingesting it, this is the error the Sharing page would show.
    it('addMember rejects a group this keyhive has not learned', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bobGroupId = (await bob.ops.ensureUserGroup({ create: true }))!;
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      // Cards and a full per-agent sync, but no bundle.
      await exchangeCards(alice, bob);
      await syncAsBridge(alice, bob);
      expect(await knowsGroup(alice, bobGroupId)).toBe(false);

      await expect(alice.ops.addMember(bobGroupId, khDocId, 'edit')).rejects.toThrow('Agent not found');

      await learnContact(alice, bob);
      await expect(alice.ops.addMember(bobGroupId, khDocId, 'edit')).resolves.toBe(true);
    });

    it('addMember rejects a bare device id: sharing is group-only', async () => {
      const alice = await createOps();
      const bob = await createOps();
      await befriend(alice, bob);
      const { khDocId } = await alice.ops.createKeyhiveDoc();

      await expect(alice.ops.addMember(bob.agentId, khDocId, 'read')).rejects.toThrow('Agent not found');
      expect(await rawAccess(alice, bob.agentId, khDocId)).toBeUndefined();
    });

    it('addMember rejects an unknown document and an unknown role without changing anything', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const bobGroupId = (await bob.ops.ensureUserGroup({ create: true }))!;
      await befriend(alice, bob);
      const { khDocId } = await alice.ops.createKeyhiveDoc();

      await expect(alice.ops.addMember(bobGroupId, 'not-a-doc', 'read')).rejects.toThrow('Document not found');
      await expect(alice.ops.addMember(bobGroupId, khDocId, 'owner')).rejects.toThrow('Invalid role: owner');
      expect(await rawAccess(alice, bobGroupId, khDocId)).toBeUndefined();
    });

    it('changeRole moves a friend\'s group down and up, and the friend\'s device follows', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
      const mark = alice.fx.order.length;

      await alice.ops.changeRole(friendGroupId, khDocId, 'read');
      expect(alice.fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive', 'forceResyncAllPeers']);
      expect(memberOf(await alice.ops.getDocMembers(khDocId), friendGroupId)?.role).toBe('read');
      await syncAsBridge(alice, bob);
      expect(await bob.ops.getMyAccess(khDocId)).toBe('Read');

      await alice.ops.changeRole(friendGroupId, khDocId, 'admin');
      await syncAsBridge(alice, bob);
      expect(await bob.ops.getMyAccess(khDocId)).toBe('Admin');
    });

    it('revokeMember removes a friend\'s group; their device loses access and cannot read what is written afterwards', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
      const before = await encrypt(alice, khDocId, 'while shared');
      await syncAsBridge(alice, bob);
      expect(await decrypt(bob, khDocId, before.bytes)).toBe('while shared');
      const mark = alice.fx.order.length;

      await alice.ops.revokeMember(friendGroupId, khDocId);
      // The resync is what tells the revoked friend at all.
      expect(alice.fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive', 'forceResyncAllPeers']);
      expect(memberOf(await alice.ops.getDocMembers(khDocId), friendGroupId)).toBeUndefined();

      const after = await encrypt(alice, khDocId, 'after the revoke');
      await syncPeers(alice, bob); // even handed everything
      expect(await bob.ops.getMyAccess(khDocId)).toBeNull();
      expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
      await expect(decrypt(bob, khDocId, after.bytes)).rejects.toThrow('Key not found');

      // Nothing left to revoke or change.
      await expect(alice.ops.revokeMember(friendGroupId, khDocId)).rejects.toThrow('Member not found in document');
      await expect(alice.ops.changeRole(friendGroupId, khDocId, 'read')).rejects.toThrow('Member not found in document');
    });

    // keyhive refuses a grant above the granter's own power. changeRole is a
    // revoke followed by an add, and the revoke is not undone if the add is
    // refused — so the refusal has to come BEFORE anything is revoked.
    describe('an editor cannot hand out admin', () => {
      /** Alice owns a doc; Bob's group edits it, Carol's group reads it; Bob knows Carol. */
      async function editorSetup() {
        const alice = await createOps();
        const bob = await createOps();
        const carol = await createOps();
        const { khDocId, friendGroupId: bobGroupId } = await shareWithFriend(alice, bob, 'edit');
        const { friendGroupId: carolGroupId } = await shareWithFriend(alice, carol, 'read', khDocId);
        await syncAsBridge(alice, bob);
        await bob.ops.registerSharingGroup(khDocId);
        const roles = async (peer: Peer) =>
          (await peer.ops.getDocMembers(khDocId)).map((m) => `${m.agentId}:${m.role}`).sort();
        return { alice, bob, carol, khDocId, bobGroupId, carolGroupId, roles };
      }

      it('addMember at admin is refused and the membership is unchanged', async () => {
        const { bob, khDocId, carolGroupId, roles } = await editorSetup();
        expect(await bob.ops.getMyAccess(khDocId)).toBe('Edit');
        const before = await roles(bob);
        const mark = bob.fx.order.length;

        await expect(bob.ops.addMember(carolGroupId, khDocId, 'admin')).rejects.toThrow(/cannot grant Admin: holds only Edit/);

        expect(await roles(bob)).toEqual(before);
        expect(await rawAccess(bob, carolGroupId, khDocId)).toBe('Read');
        // Nothing changed, so nothing is announced.
        expect(bob.fx.order.slice(mark)).not.toContain('forceResyncAllPeers');
      });

      it('changeRole upward is refused with the app\'s message, and the membership is unchanged', async () => {
        const { bob, khDocId, carolGroupId, roles } = await editorSetup();
        const before = await roles(bob);
        const mark = bob.fx.order.length;

        await expect(bob.ops.changeRole(carolGroupId, khDocId, 'admin')).rejects.toThrow('You need Admin access yourself to grant it.');

        expect(await roles(bob)).toEqual(before);
        expect(bob.fx.order.slice(mark)).toEqual([]);
      });

      // The case the check-first ordering exists for: a grant the editor DID
      // issue is one it can revoke, so an unchecked changeRole would revoke it
      // and then fail to re-add — leaving the member worse off than before.
      it('changeRole upward leaves a grant the editor itself issued in place', async () => {
        const { alice, bob, khDocId, carolGroupId } = await editorSetup();
        await bob.ops.addMember(carolGroupId, khDocId, 'edit'); // within Bob's power
        expect(await rawAccess(bob, carolGroupId, khDocId)).toBe('Edit');

        await expect(bob.ops.changeRole(carolGroupId, khDocId, 'admin')).rejects.toThrow('You need Admin access yourself to grant it.');
        await expect(bob.ops.changeRole(carolGroupId, khDocId, 'owner')).rejects.toThrow('Invalid role: owner');

        expect(await rawAccess(bob, carolGroupId, khDocId)).toBe('Edit');
        await syncAsBridge(alice, bob);
        expect(memberOf(await alice.ops.getDocMembers(khDocId), carolGroupId)?.role).toBe('edit');
      });
    });
  });

  // ── User-group (a "user" = a keyhive Group of device Individuals) ──────────
  describe('user group', () => {
    it('ensureUserGroup({create}) mints and persists a group once; getUserGroupId returns it', async () => {
      const { ops, fx, kh } = await createOps();
      expect(await ops.getUserGroupId()).toBeNull();
      expect(await ops.ensureUserGroup()).toBeNull(); // not asked to create

      const id = await ops.ensureUserGroup({ create: true });
      expect(id).toBeTruthy();
      expect(await ops.getUserGroupId()).toBe(id);
      expect(await kh.hasGroup(groupIdOf(id!))).toBe(true);
      expect(fx.calls.persist.length).toBeGreaterThan(0);

      // Idempotent: a second create returns the same id rather than a new group.
      expect(await ops.ensureUserGroup({ create: true })).toBe(id);
      expect(Number((await kh.stats()).groups)).toBe(1);
    });

    it('creating the group makes it an admin of documents this device already owns', async () => {
      const peer = await createOps();
      // A document from before the group existed (an older install).
      const docId = await peer.kh.generateDocument([], new ChangeId(new Uint8Array(32)), []);
      const khDocId = b64(docId.toBytes());

      const groupId = (await peer.ops.ensureUserGroup({ create: true }))!;
      const members = await directMembers(peer, khDocId);
      expect(members.get(groupId)?.can.toString()).toBe('Admin');
      // Delegated by the device, not a root edge — the weaker form (see the
      // co-root tests), and all that can be done after creation.
      expect(b64(members.get(groupId).proof.verifyingKey)).toBe(peer.agentId);
      expect(await peer.ops.getUserGroupAccess(khDocId)).toBe('Admin');
    });

    it('addDeviceToGroup adds a device once; listGroupDevices lists self first, then it', async () => {
      const a = await createOps();
      const b = await createOps();
      await a.ops.ensureUserGroup({ create: true });
      await learnContact(a, b);

      await a.ops.addDeviceToGroup(b.agentId);
      await a.ops.addDeviceToGroup(b.agentId); // idempotent
      const devices = await a.ops.listGroupDevices();
      expect(devices.map((d) => d.agentId)).toEqual([a.agentId, b.agentId]);
      expect(devices.map((d) => d.isMe)).toEqual([true, false]);
    });

    it('addDeviceToGroup refuses a device whose contact card has not arrived', async () => {
      const a = await createOps();
      const b = await createOps();
      await a.ops.ensureUserGroup({ create: true });

      // keyhive needs the device's prekeys to bring it into the group's key agreement.
      await expect(a.ops.addDeviceToGroup(b.agentId)).rejects.toThrow(/contact card not yet synced/);
      expect(await a.ops.listGroupDevices()).toHaveLength(1);
    });

    it('addDeviceToGroup and changeDeviceRole need a group', async () => {
      const a = await createOps();
      const b = await createOps();
      await learnContact(a, b);
      await expect(a.ops.addDeviceToGroup(b.agentId)).rejects.toThrow('User group not available');
      await expect(a.ops.changeDeviceRole(b.agentId, 'read')).rejects.toThrow('User group not available');
    });

    it('listGroupDevices reports normalized roles (read/edit/admin), never a raw Power string', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);
      await a.ops.changeDeviceRole(b.agentId, 'edit');

      const devices = await a.ops.listGroupDevices();
      expect(deviceOf(devices, a.agentId)?.role).toBe('admin');
      expect(deviceOf(devices, b.agentId)?.role).toBe('edit');
    });

    it('listGroupDevices returns just self, with no access, when there is no group', async () => {
      const { ops, agentId } = await createOps();
      // No group means no membership to read — report that, do not guess 'admin'.
      expect(await ops.listGroupDevices()).toEqual([{ agentId, role: null, isMe: true, isFounder: false }]);
    });

    it('changeDeviceRole demotes a device and resyncs peers so it learns its new access', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);
      const mark = a.fx.order.length;

      await a.ops.changeDeviceRole(b.agentId, 'read');

      expect(deviceOf(await a.ops.listGroupDevices(), b.agentId)?.role).toBe('read');
      expect(a.fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive', 'forceResyncAllPeers']);
    });

    it('changeDeviceRole round-trips an ordinary linked device: demote, then re-promote', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);

      await a.ops.changeDeviceRole(b.agentId, 'read');
      expect(deviceOf(await a.ops.listGroupDevices(), b.agentId)?.role).toBe('read');
      await a.ops.changeDeviceRole(b.agentId, 'admin');
      expect(deviceOf(await a.ops.listGroupDevices(), b.agentId)?.role).toBe('admin');

      // The device itself ends up where the admin put it.
      await syncAsBridge(a, b);
      expect(deviceOf(await b.ops.listGroupDevices(), b.agentId)).toMatchObject({ role: 'admin', isMe: true });
    });

    it('changeDeviceRole rejects a device that is not in the group, and an unknown role before revoking anything', async () => {
      const a = await createOps();
      const b = await createOps();
      const stranger = await createOps();
      await linkDevices(a, b);
      await learnContact(a, stranger); // known, but not in the group

      await expect(a.ops.changeDeviceRole(stranger.agentId, 'read')).rejects.toThrow(/not found in group/);
      // The change is revoke + re-add; a role that cannot be re-added must stop it first.
      await expect(a.ops.changeDeviceRole(b.agentId, 'owner')).rejects.toThrow('Invalid role: owner');
      expect(deviceOf(await a.ops.listGroupDevices(), b.agentId)?.role).toBe('admin');
    });

    it('removeDeviceFromGroup removes an ordinary linked device', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);
      const mark = a.fx.order.length;

      await a.ops.removeDeviceFromGroup(b.agentId);

      expect((await a.ops.listGroupDevices()).map((d) => d.agentId)).toEqual([a.agentId]);
      expect(a.fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive']);
      // Removing it again is a no-op, not an error.
      await expect(a.ops.removeDeviceFromGroup(b.agentId)).resolves.toBeUndefined();
    });

    // An admin's self-revocation SUCCEEDS in keyhive, after which it holds no
    // standing to re-add itself: the device has locked itself out for good.
    it('refuses to change or remove the current device', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);

      for (const device of [a, b]) {
        await expect(device.ops.changeDeviceRole(device.agentId, 'read')).rejects.toThrow(/Cannot change access for this device/);
        await expect(device.ops.removeDeviceFromGroup(device.agentId)).rejects.toThrow(/Cannot remove this device/);
      }
      expect((await a.ops.listGroupDevices()).map((d) => d.role)).toEqual(['admin', 'admin']);
    });

    describe('the founder, and the chain of links below it', () => {
      /**
       * founder ─links→ middle ─links→ leaf: three devices of one user, each
       * linked from the one before, all admins, all fully synced.
       */
      async function chainOfThree() {
        const founder = await createOps();
        const middle = await createOps();
        const leaf = await createOps();
        const { groupId } = await linkDevices(founder, middle);
        await linkDevices(middle, leaf);
        const all = [founder, middle, leaf];
        const syncAll = async () => {
          for (let round = 0; round < 2; round++) {
            await syncPeers(founder, middle);
            await syncPeers(middle, leaf);
            await syncPeers(founder, leaf);
          }
        };
        await syncAll();
        return { founder, middle, leaf, groupId, all, syncAll };
      }

      it('listGroupDevices marks the founder and only it, and reports who linked each device', async () => {
        const { founder, middle, leaf, groupId, all } = await chainOfThree();

        // Every device reaches the same picture.
        for (const viewer of all) {
          const devices = await viewer.ops.listGroupDevices();
          expect(devices[0].agentId).toBe(viewer.agentId); // self first, whatever members() order is
          expect(devices.map((d) => d.role)).toEqual(['admin', 'admin', 'admin']);
          expect(devices.filter((d) => d.isFounder).map((d) => d.agentId)).toEqual([founder.agentId]);
          // The founder's edge was issued by the group's own key; the others by
          // the device that linked them.
          expect(deviceOf(devices, founder.agentId)?.issuerAgentId).toBe(groupId);
          expect(deviceOf(devices, middle.agentId)?.issuerAgentId).toBe(founder.agentId);
          expect(deviceOf(devices, leaf.agentId)?.issuerAgentId).toBe(middle.agentId);
        }
      });

      // members() reports ONE capability per member. When a peer admin has also
      // delegated to the founder, that can be the one it reports — a founder
      // that looks like an ordinary linked device. Being wrong here offers the
      // user the one tap that destroys the group.
      it('still marks the founder after a peer admin re-delegated it', async () => {
        const { founder, middle, groupId, all, syncAll } = await chainOfThree();
        await middle.kh.addMember(founder.kh.id.toIdentifier(), MemberedId.group(groupIdOf(groupId)), Power.admin());
        await syncAll();

        for (const viewer of all) {
          const devices = await viewer.ops.listGroupDevices();
          expect(devices.filter((d) => d.isFounder).map((d) => d.agentId)).toEqual([founder.agentId]);
        }
        await expect(middle.ops.removeDeviceFromGroup(founder.agentId)).rejects.toThrow(/created this user group/);
      });

      it('removeDeviceFromGroup and changeDeviceRole refuse the founder, from any other device', async () => {
        const { founder, middle, leaf, all } = await chainOfThree();

        for (const device of [middle, leaf]) {
          await expect(device.ops.removeDeviceFromGroup(founder.agentId))
            .rejects.toThrow('Cannot remove the device that created this user group');
          await expect(device.ops.changeDeviceRole(founder.agentId, 'read'))
            .rejects.toThrow('Cannot change access for the device that created this user group');
        }
        for (const viewer of all) {
          expect((await viewer.ops.listGroupDevices()).map((d) => d.role)).toEqual(['admin', 'admin', 'admin']);
        }
      });

      // What the guard above prevents. keyhive allows it, and there is no undo.
      it('contrast: revoking the founder with raw keyhive leaves the group with no members, for everyone', async () => {
        const { founder, middle, groupId, syncAll, all } = await chainOfThree();
        const group = MemberedId.group(groupIdOf(groupId));

        expect(await middle.kh.revokeMember(founder.kh.id.toIdentifier(), true, group)).toHaveLength(1);
        await syncAll();

        for (const viewer of all) {
          expect(await (await viewer.kh.getGroup(groupIdOf(groupId)))!.members()).toHaveLength(0);
        }
        // Nobody can repair it — not even the device that did it.
        await expect(middle.kh.addMember(founder.kh.id.toIdentifier(), group, Power.admin()))
          .rejects.toThrow(/no standing over the resource/);
      });

      it('refuses to remove or demote a device upstream of the caller — the one it was linked from', async () => {
        const { middle, leaf, all } = await chainOfThree();

        await expect(leaf.ops.removeDeviceFromGroup(middle.agentId))
          .rejects.toThrow('Cannot remove the device this one was linked from');
        await expect(leaf.ops.changeDeviceRole(middle.agentId, 'read'))
          .rejects.toThrow('Cannot change access for the device this one was linked from');

        for (const viewer of all) {
          expect((await viewer.ops.listGroupDevices()).map((d) => d.role)).toEqual(['admin', 'admin', 'admin']);
        }
      });

      // Going DOWN the chain is allowed, and must not take the rest with it:
      // removing a lost phone cannot drop the tablet that was linked from it.
      it('removing a device keeps the devices it had linked, re-issued by the remover', async () => {
        const { founder, middle, leaf, syncAll } = await chainOfThree();

        await founder.ops.removeDeviceFromGroup(middle.agentId);
        await syncAll();

        for (const viewer of [founder, leaf]) {
          const devices = await viewer.ops.listGroupDevices();
          expect(devices.map((d) => d.agentId).sort()).toEqual([founder.agentId, leaf.agentId].sort());
          expect(deviceOf(devices, leaf.agentId)).toMatchObject({ role: 'admin', issuerAgentId: founder.agentId });
        }
        // The removed device sees itself out.
        expect(deviceOf(await middle.ops.listGroupDevices(), middle.agentId)).toMatchObject({ role: null, isMe: true });
      });
    });

    // The filter used to be "is an Individual", which is false for the current
    // device on every path, so its own row was dropped and re-added with a
    // hard-coded 'admin'. A demoted device saw itself as an admin and was
    // offered manage actions keyhive then refused.
    it('a device demoted by a peer admin reports its OWN row as read, not admin', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);
      expect(deviceOf(await b.ops.listGroupDevices(), b.agentId)?.role).toBe('admin');

      await a.ops.changeDeviceRole(b.agentId, 'read');
      await syncAsBridge(a, b);

      const after = await b.ops.listGroupDevices();
      expect(after.filter((d) => d.isMe)).toHaveLength(1); // no synthetic duplicate row
      expect(deviceOf(after, b.agentId)).toMatchObject({ role: 'read', isMe: true, isFounder: false });
      // The demoting device is untouched and reads as the founder from here too.
      expect(deviceOf(after, a.agentId)).toMatchObject({ role: 'admin', isFounder: true });
    });

    it('a device removed from the group keeps its row, reporting no access', async () => {
      const a = await createOps();
      const b = await createOps();
      await linkDevices(a, b);

      await a.ops.removeDeviceFromGroup(b.agentId);
      await syncAsBridge(a, b);

      // Dropping the row would trip DeviceList's "No linked devices." empty
      // state; inventing a role would offer actions it cannot perform.
      const self = deviceOf(await b.ops.listGroupDevices(), b.agentId);
      expect(self).toMatchObject({ role: null, isMe: true, isFounder: false });
    });

    it('a device removed from the group loses the user\'s documents and cannot read what is written afterwards', async () => {
      const laptop = await createOps();
      const phone = await createOps();
      const { khDocId } = await laptop.ops.createKeyhiveDoc();
      await linkDevices(laptop, phone);
      const before = await encrypt(laptop, khDocId, 'while linked');
      await syncAsBridge(laptop, phone);
      expect(await decrypt(phone, khDocId, before.bytes)).toBe('while linked');

      await laptop.ops.removeDeviceFromGroup(phone.agentId);
      const after = await encrypt(laptop, khDocId, 'after the phone was removed');
      expect(after.newEpoch).toBe(true);
      await syncPeers(laptop, phone); // even handed everything

      expect(await phone.ops.getMyAccess(khDocId)).toBeNull();
      await expect(decrypt(phone, khDocId, after.bytes)).rejects.toThrow('Key not found');
    });

    // A dangling user-group: the id survived in the KV store but keyhive lost
    // the group (storage reset or migrated). Reported at startup; nothing here
    // may throw, or the app cannot even reach the screen that explains it.
    it('a dangling user-group id is detected, and documents can still be created without it', async () => {
      const peer = await createOps();
      expect(await peer.ops.findDanglingUserGroup()).toBeNull(); // fresh install: nothing to dangle
      await peer.ops.ensureUserGroup({ create: true });
      expect(await peer.ops.findDanglingUserGroup()).toBeNull(); // a healthy group

      const orphan = await createOps();
      const stranger = await createOps();
      const foreignGroupId = (await stranger.ops.ensureUserGroup({ create: true }))!;
      await orphan.fx.setUserGroupId(foreignGroupId);
      expect(await orphan.ops.findDanglingUserGroup()).toBe(foreignGroupId);

      const { khDocId } = await orphan.ops.createKeyhiveDoc();
      expect(await orphan.ops.getMyAccess(khDocId)).toBe('Admin');
      expect(await orphan.ops.getUserGroupAccess(khDocId)).toBeNull();
      expect(await orphan.ops.listGroupDevices()).toEqual([{ agentId: orphan.agentId, role: null, isMe: true, isFounder: false }]);
      // The bundle carries no group rather than one the receiver could never resolve.
      expect(JSON.parse(await orphan.ops.getContactCard())).not.toHaveProperty('groupId');
    });
  });

  // The home page is driven by user-group access: a document shows iff the
  // personal user-group has at least read access, and "delete" (archive)
  // revokes the user-group. The GROUP, not the device, because the creating
  // device keeps its own root edge on a document whatever happens to the group.
  describe('home-page user-group access', () => {
    it('the user-group is admin of a document it created', async () => {
      const peer = await createOps();
      const { khDocId } = await peer.ops.enableSharing('doc-1');
      const groupId = (await peer.ops.getUserGroupId())!;
      expect(await rawAccess(peer, groupId, khDocId)).toBe('Admin');
    });

    it('revoking the user-group removes ITS access while the creating device keeps its root edge', async () => {
      const peer = await createOps();
      const { khDocId } = await peer.ops.enableSharing('doc-1');
      const groupId = (await peer.ops.getUserGroupId())!;

      await peer.kh.revokeMember(identifierOf(groupId), true, MemberedId.document(docIdOf(khDocId)));

      // Gone for the group — so the document would drop off the home list…
      expect(await rawAccess(peer, groupId, khDocId)).toBeUndefined();
      // …but not for the device. This is why the home page asks about the group.
      expect(await rawAccess(peer, peer.agentId, khDocId)).toBe('Admin');
    });

    it('enumerateUserDocs lists a document the user-group can access', async () => {
      const { ops } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const { accessibleKhIds, reachableKhIds } = await ops.enumerateUserDocs();
      expect(accessibleKhIds).toEqual([khDocId]);
      expect(reachableKhIds).toEqual([khDocId]);
    });

    it('enumerateUserDocs calls nothing accessible without a user-group', async () => {
      const alice = await createOps();
      const bob = await createOps();
      const { khDocId } = await alice.ops.createKeyhiveDoc();
      await shareDocWithDevice(alice, khDocId, bob, 'edit');

      const { accessibleKhIds, reachableKhIds } = await bob.ops.enumerateUserDocs();
      expect(reachableKhIds).toEqual([khDocId]);
      expect(accessibleKhIds).toEqual([]);
    });

    it('revokeMyAccess on a document we created: off the home set, still reachable, the device keeps its edge', async () => {
      const { ops, fx } = await createOps();
      const { khDocId } = await ops.enableSharing('doc-1');
      const mark = fx.order.length;

      const result = await ops.revokeMyAccess(khDocId);

      expect(result.status).toBe('revoked');
      expect(result.grantSigs).toHaveLength(1); // the pre-revoke baseline: the co-root grant
      expect(await ops.getUserGroupAccess(khDocId)).toBeNull();
      const { accessibleKhIds, reachableKhIds } = await ops.enumerateUserDocs();
      expect(accessibleKhIds).not.toContain(khDocId);
      // Reachable-but-not-accessible is how reconcile tells "revoked" (prune)
      // from "not synced yet" (keep).
      expect(reachableKhIds).toContain(khDocId);
      expect(await ops.getMyAccess(khDocId)).toBe('Admin');
      expect(await ops.getUserGroupGrantSigs(khDocId)).toEqual([]);
      // The revocation has to reach the user's other devices.
      expect(fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive', 'forceResyncAllPeers']);
    });

    it('revokeMyAccess reports not-found for a document keyhive does not know', async () => {
      const { ops } = await createOps();
      await ops.ensureUserGroup({ create: true });
      const stranger = await createOps();
      const { khDocId: foreign } = await stranger.ops.createKeyhiveDoc();

      expect(await ops.revokeMyAccess(foreign)).toEqual({ status: 'not-found', grantSigs: [] });
    });

    it('the keyhive doc id and the automerge doc id are the same bytes (the worker\'s home-list conversion)', async () => {
      const repo = (await import('@automerge/automerge-repo')) as any;
      // The worker's conversion: keyhive doc-id bytes → automerge doc id string.
      const amDocIdFromBytes = (bytes: Uint8Array): string =>
        repo.parseAutomergeUrl(repo.stringifyAutomergeUrl(bytes)).documentId;
      const { ops } = await createOps();
      const { docIdBytes } = await ops.createKeyhiveDoc();

      const amDocId = amDocIdFromBytes(docIdBytes);
      // …and back, as khDocIdFromAm does: the mapping is lossless.
      const back: Uint8Array = repo.parseAutomergeUrl(`automerge:${amDocId}`).binaryDocumentId;
      expect(Array.from(back)).toEqual(Array.from(docIdBytes));
    });

    // The cross-device path: device A makes a document owned by the shared
    // user-group; device B, a member of that group, must enumerate it.
    it('a document created on one device after linking is on the other device\'s home set', async () => {
      const laptop = await createOps();
      const phone = await createOps();
      const { groupId } = await linkDevices(laptop, phone);
      expect(await phone.ops.getUserGroupId()).toBe(groupId);

      const { khDocId } = await laptop.ops.enableSharing('am-doc-after-link');
      await syncAsBridge(laptop, phone);

      expect(await phone.ops.getUserGroupAccess(khDocId)).toBe('Admin');
      expect((await phone.ops.enumerateUserDocs()).accessibleKhIds).toContain(khDocId);
    });

    // ── Archiving a document a friend shared ───────────────────────────────
    // keyhive lets a member revoke only what it has standing over. An admin
    // grant can be handed back; a read or edit grant cannot, and the app hides
    // the document with a local tombstone instead. Either way the caller gets
    // the outcome and the pre-revoke grant signatures, which are how a later
    // RE-share is told apart from the grant that was archived.
    describe('archiving a document a friend shared (revokeMyAccess)', () => {
      it('an admin grant is revoked: access gone, and it stays gone across sync-back and a reload', async () => {
        const alice = await createOps();
        const bob = await createOps();
        const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'admin');
        expect(await bob.ops.getUserGroupAccess(khDocId)).toBe('Admin');
        const baseline = await bob.ops.getUserGroupGrantSigs(khDocId);
        expect(baseline).toHaveLength(1);
        const mark = bob.fx.order.length;

        const result = await bob.ops.revokeMyAccess(khDocId);

        expect(result).toEqual({ status: 'revoked', grantSigs: baseline });
        expect(bob.fx.order.slice(mark)).toEqual(['persist', 'syncKeyhive', 'forceResyncAllPeers']);
        expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
        expect(await bob.ops.getMyAccess(khDocId)).toBeNull();
        expect((await bob.ops.enumerateUserDocs()).accessibleKhIds).not.toContain(khDocId);

        // Alice has not seen the revocation and keeps sending what she has:
        // that must not resurrect the grant. Then she learns of it herself.
        await pushVisibleEvents(alice, bob);
        expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
        await syncPeers(alice, bob);
        expect(await bob.ops.getUserGroupAccess(khDocId)).toBeNull();
        expect(await rawAccess(alice, friendGroupId, khDocId)).toBeUndefined();
        expect(memberOf(await alice.ops.getDocMembers(khDocId), friendGroupId)).toBeUndefined();

        // And it is durable.
        const bob2 = await reload(bob);
        expect(await bob2.ops.getUserGroupAccess(khDocId)).toBeNull();
        expect((await bob2.ops.enumerateUserDocs()).accessibleKhIds).not.toContain(khDocId);
      });

      it.each(['edit', 'read'] as const)('an %s grant cannot be handed back: no-authority, access remains, baseline returned', async (role) => {
        const alice = await createOps();
        const bob = await createOps();
        const { khDocId } = await shareWithFriend(alice, bob, role);
        const granted = await bob.ops.getUserGroupAccess(khDocId);
        const baseline = await bob.ops.getUserGroupGrantSigs(khDocId);
        expect(baseline).toHaveLength(1);
        const mark = bob.fx.order.length;

        const result = await bob.ops.revokeMyAccess(khDocId);

        expect(result).toEqual({ status: 'no-authority', grantSigs: baseline });
        // Nothing changed in keyhive, so there is nothing to push to peers.
        expect(bob.fx.order.slice(mark)).not.toContain('forceResyncAllPeers');
        expect(await bob.ops.getUserGroupAccess(khDocId)).toBe(granted);
        expect(await bob.ops.getUserGroupGrantSigs(khDocId)).toEqual(baseline);
        // Still a member as far as the owner is concerned.
        await syncPeers(alice, bob);
        expect(await alice.ops.getDocMembers(khDocId)).toHaveLength(2);
      });

      it('a re-share after a revoke is a grant whose signature is not in the baseline', async () => {
        const alice = await createOps();
        const bob = await createOps();
        const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'admin');
        const { grantSigs: baseline } = await bob.ops.revokeMyAccess(khDocId);
        await syncPeers(alice, bob);

        // Alice shares it with Bob again — the very same grant as before.
        await alice.ops.addMember(friendGroupId, khDocId, 'admin');
        await syncAsBridge(alice, bob);

        expect(await bob.ops.getUserGroupAccess(khDocId)).toBe('Admin');
        const after = await bob.ops.getUserGroupGrantSigs(khDocId);
        expect(after).toHaveLength(1);
        expect(baseline).not.toContain(after[0]); // ← what un-hides the archived document
      });

      // The tombstoned (no-authority) case keys off the same signal, so it must
      // not fire when nothing was re-shared and must fire when something was.
      it('while a grant stands, repeating it is not a re-share; changing its role is', async () => {
        const alice = await createOps();
        const bob = await createOps();
        const { khDocId, friendGroupId } = await shareWithFriend(alice, bob, 'edit');
        const { grantSigs: baseline } = await bob.ops.revokeMyAccess(khDocId); // no-authority

        await alice.ops.addMember(friendGroupId, khDocId, 'edit'); // an identical grant
        await syncAsBridge(alice, bob);
        expect(await bob.ops.getUserGroupGrantSigs(khDocId)).toEqual(baseline);

        await alice.ops.changeRole(friendGroupId, khDocId, 'admin'); // a deliberate re-share
        await syncAsBridge(alice, bob);
        const after = await bob.ops.getUserGroupGrantSigs(khDocId);
        expect(after).toHaveLength(1);
        expect(baseline).not.toContain(after[0]);
      });
    });
  });
});
