/**
 * Shared harness for the keyhive suite (src/shared/keyhive-ops.test.ts): the
 * real keyhive WASM, a real KeyhiveOps with
 * recording side effects, and two kinds of helper.
 *
 * - Stand-ins for the parts of the app these suites do not boot: the network
 *   (`syncAsBridge`, `syncPeers`, `exchangeCards`) and the bridge's storage
 *   (`reload`). These are raw keyhive calls, not product code paths; where one
 *   does something the app never does, its comment says so.
 * - The app's own multi-step flows, driven through KeyhiveOps exactly as the UI
 *   drives them (`learnContact`, `befriend`, `linkDevices`, `shareWithFriend`),
 *   so a test can start from "two friends share a document" in one line.
 */
import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import {
  Archive,
  ChangeId,
  CiphertextStore,
  ContactCard,
  DocumentId,
  Encrypted,
  GroupId,
  Identifier,
  IndividualId,
  Keyhive,
  MemberedId,
  Power,
  Signer,
} from '@keyhive/keyhive/slim';
import {
  KeyhiveOps,
  bytesToBase64,
  base64ToBytes,
  type KeyhiveBridge,
  type KeyhiveOpsSideEffects,
} from '../../src/shared/keyhive-ops';
import type { MemberRole } from '../../src/shared/keyhive-types';

initKeyhiveWasm();

/** The constructors KeyhiveOps needs, straight from the real package. */
export const bridge: KeyhiveBridge = {
  ChangeId,
  DocumentId,
  Identifier,
  GroupId,
  IndividualId,
  MemberedId,
  Power,
  ContactCard,
};

export type RecordingSideEffects = KeyhiveOpsSideEffects & {
  /** One entry per call, by side-effect name. */
  calls: Record<'persist' | 'syncKeyhive' | 'forceResyncAllPeers', unknown[][]>;
  /** Every side effect in the order it fired — for tests that pin an ordering. */
  order: string[];
};

/**
 * Side effects that record instead of acting, and hold the user-group id the
 * way the app's KV store does.
 */
export function noopSideEffects(): RecordingSideEffects {
  const calls: RecordingSideEffects['calls'] = { persist: [], syncKeyhive: [], forceResyncAllPeers: [] };
  const order: string[] = [];
  let userGroupId: string | null = null;
  const record = (name: keyof RecordingSideEffects['calls']) => { calls[name].push([]); order.push(name); };
  return {
    calls,
    order,
    persist: async () => { record('persist'); },
    syncKeyhive: () => { record('syncKeyhive'); },
    forceResyncAllPeers: () => { record('forceResyncAllPeers'); },
    getUserGroupId: async () => userGroupId,
    setUserGroupId: async (id) => { userGroupId = id; },
  };
}

/** One device: a keyhive, the KeyhiveOps over it, and what a test needs to poke at both. */
export interface Peer {
  ops: KeyhiveOps;
  kh: Keyhive;
  fx: RecordingSideEffects;
  signer: Signer;
  /**
   * `event.toBytes()` for every event this keyhive emitted, in order. The bridge
   * writes exactly these to storage as they happen, so a slice of this array is
   * "what reached disk after the last archive save" (see {@link reload}).
   */
  emitted: Uint8Array[];
  /** `event.variant` for each entry of `emitted` (e.g. "DELEGATED", "CGKA_OPERATION"). */
  emittedVariants: string[];
  /** base64 of the device's individual id — what the app calls its agentId. */
  agentId: string;
}

/** The event handler a keyhive is booted with, and the two arrays it fills. */
function eventRecorder() {
  const emitted: Uint8Array[] = [];
  const emittedVariants: string[] = [];
  const handler = (event: any) => { emitted.push(event.toBytes()); emittedVariants.push(String(event.variant)); };
  return { emitted, emittedVariants, handler };
}

function makePeer(
  kh: Keyhive, signer: Signer, fx: RecordingSideEffects, rec: { emitted: Uint8Array[]; emittedVariants: string[] },
): Peer {
  return {
    ops: new KeyhiveOps(kh, bridge, fx), kh, fx, signer,
    emitted: rec.emitted, emittedVariants: rec.emittedVariants,
    agentId: bytesToBase64(kh.id.toBytes()),
  };
}

/** A fresh device with no group, no documents and no contacts. */
export async function createOps(signer: Signer = Signer.generateMemory()): Promise<Peer> {
  const rec = eventRecorder();
  const kh = await Keyhive.init(signer, CiphertextStore.newInMemory(), rec.handler);
  return makePeer(kh, signer, noopSideEffects(), rec);
}

type HasKeyhive = { kh: Keyhive };

/** Everything `from` knows goes to `to`. Returns how many events `to` could not apply yet. */
export async function pushEvents(from: HasKeyhive, to: HasKeyhive): Promise<number> {
  const all = await from.kh.allAgentEvents();
  const pending = await to.kh.ingestEventsBytes([...all.events.values()]);
  return pending.length;
}

/**
 * Brute-force two-way sync between two keyhives: each side ingests every event
 * the other holds. Stands in for the bridge's keyhive sync, which sends a peer
 * a subset; use it where the test is about what the state means once it has
 * arrived, not about which events travel.
 *
 * Three passes, not two: the first a→b can leave events parked that only apply
 * once b→a has delivered what they depend on.
 *
 * Deliberately NOT `Keyhive.ingestArchive`: under keyhive >= 0.6 that imports
 * the other replica's secret keys, so two "peers" synced that way are no longer
 * two peers.
 */
export async function syncPeers(a: HasKeyhive, b: HasKeyhive): Promise<void> {
  await pushEvents(a, b);
  await pushEvents(b, a);
  await pushEvents(a, b);
}

/**
 * What `from` would send `to` over the bridge: the events keyhive says that
 * DEVICE may see (`eventsForAgent`) plus the device's own key ops — the same two
 * sets the bridge's `getEventHashesForAgent` unions. Returns how many events
 * `to` could not apply yet.
 */
export async function pushVisibleEvents(from: HasKeyhive, to: HasKeyhive): Promise<number> {
  const recipient = await from.kh.getPrincipal(to.kh.id.toIdentifier());
  const events = new Map<string, Uint8Array>();
  const collect = (bytes: Uint8Array, hash: Uint8Array) => { events.set(hash.toString(), bytes); };
  (await from.kh.eventsForAgent(recipient)).forEach(collect);
  (await recipient.keyOps()).forEach(collect);
  const pending = await to.kh.ingestEventsBytes([...events.values()]);
  return pending.length;
}

/**
 * Two-way sync limited to what the bridge would transfer (see
 * {@link pushVisibleEvents}). Use it where the test is about the right events
 * reaching a device — a share, a device link — so that a change in what keyhive
 * considers visible to a peer shows up as a failure rather than being papered
 * over by {@link syncPeers} handing over everything.
 */
export async function syncAsBridge(a: HasKeyhive, b: HasKeyhive): Promise<void> {
  await pushVisibleEvents(a, b);
  await pushVisibleEvents(b, a);
  await pushVisibleEvents(a, b);
}

/**
 * Raw contact-card exchange, both ways. A keyhive must hold a device's card
 * before events that mention that device are any use to it. The product path is
 * `ops.receiveContactCard(await other.ops.getContactCard())`, which also carries
 * the sender's user-group; this is the bare minimum for tests working below it.
 */
export async function exchangeCards(a: HasKeyhive, b: HasKeyhive): Promise<void> {
  await a.kh.receiveContactCard(ContactCard.fromBytes((await b.kh.contactCard()).toBytes()));
  await b.kh.receiveContactCard(ContactCard.fromBytes((await a.kh.contactCard()).toBytes()));
}

/** The keyhive DocumentId for the app's base64 doc id. */
export function docIdOf(khDocId: string): DocumentId {
  return new DocumentId(base64ToBytes(khDocId));
}

/** The Identifier for a base64 id (device, group or document). */
export function identifierOf(idB64: string): Identifier {
  return new Identifier(base64ToBytes(idB64));
}

/**
 * Grant a peer's DEVICE direct access to a document, then sync the two.
 *
 * TEST-ONLY. The product shares with user-groups, never with a bare device
 * (`KeyhiveOps.addMember` rejects one). The cross-peer encryption tests are
 * about key agreement between two devices, and a direct grant is the shortest
 * honest way to put two devices in one document's tree.
 */
export async function shareDocWithDevice(owner: Peer, khDocId: string, peer: Peer, role: string): Promise<void> {
  const power = Power.tryFromString(role);
  if (!power) throw new Error(`Invalid role: ${role}`);
  await exchangeCards(owner, peer);
  await owner.kh.addMember(peer.kh.id.toIdentifier(), MemberedId.document(docIdOf(khDocId)), power);
  await syncPeers(owner, peer);
}

// ── The app's own flows, through KeyhiveOps ─────────────────────────────────

/**
 * `learner` receives `subject`'s contact bundle — the one step behind both
 * "add a friend" and "learn a device". The bundle carries the subject's
 * user-group when it has one.
 */
export async function learnContact(learner: Peer, subject: Peer) {
  return learner.ops.receiveContactCard(await subject.ops.getContactCard());
}

/** Two users add each other as friends (a bundle each way). */
export async function befriend(a: Peer, b: Peer): Promise<void> {
  await learnContact(a, b);
  await learnContact(b, a);
}

/**
 * The two legs of the QR device link, in the order the app runs them: the new
 * device opens the original's link (learns it, adopts its group id), then the
 * original opens the return link (learns the new device, adds it to the group).
 * Ends with a bridge-style sync so the new device sees its own membership.
 */
export async function linkDevices(original: Peer, added: Peer) {
  const groupId = (await original.ops.ensureUserGroup({ create: true }))!;
  await learnContact(added, original);
  const firstLeg = await added.ops.linkDevice(original.agentId, groupId);
  const fromAdded = await learnContact(original, added);
  const secondLeg = await original.ops.linkDevice(added.agentId, fromAdded.groupId ?? null);
  await syncAsBridge(original, added);
  return { groupId, firstLeg, secondLeg };
}

/**
 * `owner` shares a document with `friend` the way the Sharing page does: they
 * are friends, and the owner adds the friend's USER-GROUP at `role`. Creates the
 * document unless one is given. Ends with a bridge-style sync.
 */
export async function shareWithFriend(owner: Peer, friend: Peer, role: MemberRole, khDocId?: string) {
  const friendGroupId = (await friend.ops.ensureUserGroup({ create: true }))!;
  await befriend(owner, friend);
  const docId = khDocId ?? (await owner.ops.createKeyhiveDoc()).khDocId;
  await owner.ops.addMember(friendGroupId, docId, role);
  await syncAsBridge(owner, friend);
  return { khDocId: docId, friendGroupId };
}

// ── Storage stand-in ─────────────────────────────────────────────────────────

export interface ReloadOptions {
  /** Archive to boot from. Default: the peer's state right now. */
  archive?: Uint8Array;
  /** Stored prekey secrets (`kh.exportPrekeySecrets()`), imported after the events. */
  prekeySecrets?: Uint8Array;
  /** Events that reached storage after `archive` was saved. */
  events?: Uint8Array[];
}

/**
 * Restart a device: a new Keyhive from an archive with the SAME signer, wrapped
 * in a new KeyhiveOps that shares the peer's side effects (so its persisted
 * user-group id survives, as it does in the app's KV store).
 *
 * Follows the bridge's boot order (`loadOrCreateKeyhive`): archive, then the
 * stored events, then the stored prekey secrets. With no options this is a
 * clean restart from fully-saved state; pass an older archive plus the events
 * emitted since to model a restart from state that was only partly saved.
 */
export async function reload(peer: Peer, opts: ReloadOptions = {}): Promise<Peer> {
  const archive = opts.archive ?? (await peer.kh.toArchive()).toBytes();
  const rec = eventRecorder();
  const kh = await new Archive(archive).tryToKeyhive(CiphertextStore.newInMemory(), peer.signer, rec.handler);
  if (opts.events?.length) await kh.ingestEventsBytes(opts.events);
  if (opts.prekeySecrets) await kh.importPrekeySecrets(opts.prekeySecrets);
  return makePeer(kh, peer.signer, peer.fx, rec);
}

/** A content ref no other message shares — what the engine uses for presence payloads. */
export function randomRef(): ChangeId {
  return new ChangeId(crypto.getRandomValues(new Uint8Array(32)));
}

export interface Ciphertext {
  /** `Encrypted.toBytes()` — what goes on the wire. */
  bytes: Uint8Array;
  /**
   * Whether this encrypt started a new key epoch: it emitted a CGKA operation,
   * which every other member must ingest before it can decrypt `bytes`.
   */
  newEpoch: boolean;
  /**
   * Whether keyhive's result carried an `updateOp()`. NOT the same thing as
   * `newEpoch`: keyhive 0.8.0 leaves it unset for some rotations (see "a new
   * key epoch is not always reported by updateOp()" in keyhive-ops.test.ts), so
   * no test should treat it as the signal that key material was minted.
   */
  updateOp: boolean;
}

/**
 * Encrypt for a document the way the engine does for presence (fresh content
 * ref, no predecessors).
 */
export async function encrypt(peer: Peer, khDocId: string, plaintext: string | Uint8Array): Promise<Ciphertext> {
  const content = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const mark = peer.emittedVariants.length;
  const result = await peer.kh.tryEncrypt(docIdOf(khDocId), randomRef(), [], content);
  return {
    bytes: result.encryptedContent().toBytes(),
    newEpoch: peer.emittedVariants.slice(mark).includes('CGKA_OPERATION'),
    updateOp: !!result.updateOp(),
  };
}

/** Decrypt wire bytes produced by {@link encrypt}; rejects if this keyhive holds no key for them. */
export async function decrypt(peer: HasKeyhive, khDocId: string, bytes: Uint8Array): Promise<string> {
  const out = await peer.kh.tryDecrypt(docIdOf(khDocId), Encrypted.fromBytes(bytes));
  return new TextDecoder().decode(out);
}
