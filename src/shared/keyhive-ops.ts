import { Keyhive } from "@keyhive/keyhive/slim";
import type { MemberRole, MemberInfo, ArchiveDocResult, DeviceEntry, RelatedDevice } from './keyhive-types';
import { createLogger } from './logger';

const log = createLogger('kh');

// Re-export these so the worker can use them without duplicating
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// A self-describing envelope for a contact card. Carries the raw Individual
// contact card plus (optionally) the sender's user-group ops, so the receiver
// can resolve that group as a share target. The envelope is mandatory —
// receiveContactCard rejects a bare card string.
const CONTACT_BUNDLE_KIND = 'contact-bundle';
/**
 * Bundle format version. 2 = the card is base64 of `ContactCard.toBytes()` and
 * the events are keyhive's framed encoding (keyhive >= 0.6). Version 1 (no `v`
 * field) carried `ContactCard.toJson()` and bincode events, which this keyhive
 * cannot read — and vice versa — so a mismatch is rejected up front with a
 * message that says what to do, rather than as an opaque decode failure.
 */
const CONTACT_BUNDLE_VERSION = 2;
interface ContactBundle {
  __kind: typeof CONTACT_BUNDLE_KIND;
  v: typeof CONTACT_BUNDLE_VERSION;
  /** base64 of ContactCard.toBytes() for the sender's Individual device. */
  card: string;
  /** Sender's user-group id (base64), if they have one. */
  groupId?: string;
  /** Sender's user-group ops (base64 StaticEvent bytes), for ingestEventsBytes. */
  groupEvents?: string[];
}

/**
 * Bounds on an inbound bundle's `groupEvents` before any base64 decode or
 * keyhive ingest work. A legitimate bundle is the sender's group delegation plus
 * their devices' prekey ops — a few KB, and flat in the sender's document count
 * (see {@link KeyhiveOps.contactBundleEvents}). An attacker-supplied bundle
 * (pasted link, hostile rendezvous peer) must not force unbounded parsing/CPU.
 */
const MAX_BUNDLE_GROUP_EVENTS = 1024;
const MAX_BUNDLE_GROUP_EVENTS_BYTES = 1024 * 1024; // base64 chars across all events

/** Thrown for a well-formed bundle made by a build with a different keyhive format. */
export const CONTACT_BUNDLE_VERSION_MISMATCH =
  'This invite was made by a different version of the app. Update both devices, then share a new one.';

/**
 * Parse a contact-bundle envelope, or null if the string is not one. Throws
 * CONTACT_BUNDLE_VERSION_MISMATCH for an envelope of another format version.
 */
function parseContactBundle(cardJson: string): ContactBundle | null {
  let parsed: any;
  try {
    parsed = JSON.parse(cardJson);
  } catch {
    return null; // Not JSON / not our envelope.
  }
  if (!parsed || typeof parsed !== 'object' || parsed.__kind !== CONTACT_BUNDLE_KIND || typeof parsed.card !== 'string') {
    return null;
  }
  if (parsed.v !== CONTACT_BUNDLE_VERSION) throw new Error(CONTACT_BUNDLE_VERSION_MISMATCH);
  return parsed as ContactBundle;
}

export function errMsg(err: any): string {
  if (!err) return 'Unknown error';
  if (typeof err.message === 'function') return err.message();
  if (err.message) return err.message;
  // Some keyhive errors are bare wasm objects with no message (e.g.
  // CannotParseIdentifier); name the class instead of printing "[object Object]".
  const text = String(err);
  return text === '[object Object]' ? (err.name || err.constructor?.name || 'Unknown error') : text;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface KeyhiveOpsSideEffects {
  persist: () => Promise<void>;
  syncKeyhive: () => void;
  forceResyncAllPeers: () => void;
  /** Read the persisted personal user-group id (base64), or null if none. */
  getUserGroupId: () => Promise<string | null>;
  /** Persist the personal user-group id (base64). */
  setUserGroupId: (id: string) => Promise<void>;
}

/**
 * The subset of @keyhive/keyhive/slim that KeyhiveOps needs as constructors/factories.
 *
 * keyhive >= 0.6 addresses everything by id: `addMember`/`revokeMember` take an
 * `Identifier` and a `MemberedId`, `generateGroup`/`generateDocument` return
 * ids, and a `Group`/`Document` handle is a live view obtained from `getGroup`
 * / `getDocument`. There are no Agent/Peer/Membered handles any more.
 */
export interface KeyhiveBridge {
  ChangeId: new (bytes: Uint8Array) => any;
  DocumentId: new (bytes: Uint8Array) => any;
  Identifier: new (bytes: Uint8Array) => any;
  /** Validates the bytes as a curve point; throws on anything else. */
  GroupId: new (bytes: Uint8Array) => any;
  IndividualId: new (bytes: Uint8Array) => any;
  MemberedId: { document(docId: any): any; group(groupId: any): any };
  /** Access levels: relay < read < edit < admin. `tryFromString` is case-insensitive. */
  Power: { tryFromString(s: string): any | undefined; admin(): any };
  ContactCard: { fromBytes(bytes: Uint8Array): any };
}

/**
 * Normalize a keyhive Power string (e.g. "Admin") into a MemberRole, or null
 * for a power that grants no access to content ("Relay" may carry ciphertext
 * but cannot read it).
 */
function toMemberRole(can: string): MemberRole | null {
  switch (can.toLowerCase()) {
    case 'admin': return 'admin';
    case 'edit': return 'edit';
    case 'read': return 'read';
    default: return null;
  }
}

export class KeyhiveOps {
  kh: Keyhive; // Keyhive instance
  bridge: KeyhiveBridge;
  khDocuments = new Map<string, any>();
  /** Cached personal user-group handle, keyed by its base64 id. */
  private userGroup: any = null;
  private userGroupIdCache: string | null = null;
  private fx: KeyhiveOpsSideEffects;

  constructor(
    kh: Keyhive,
    bridge: KeyhiveBridge,
    sideEffects: KeyhiveOpsSideEffects,
  ) {
    this.kh = kh;
    this.bridge = bridge;
    this.fx = sideEffects;
  }

  // ---- keyhive vocabulary (ids in, ids out) ----

  /** This device's individual id bytes — its agentId. */
  private selfIdBytes(): Uint8Array { return this.kh.id.toBytes(); }
  private selfId(): string { return bytesToBase64(this.selfIdBytes()); }
  private identifier(bytes: Uint8Array): any { return new this.bridge.Identifier(bytes); }
  private groupMembered(group: any): any { return this.bridge.MemberedId.group(group.groupId); }
  private docMembered(doc: any): any { return this.bridge.MemberedId.document(doc.docId); }

  /** A Power for a role string, or a thrown "Invalid role". */
  private power(role: string): any {
    const power = this.bridge.Power.tryFromString(role);
    if (!power) throw new Error(`Invalid role: ${role}`);
    return power;
  }

  /** Whether these id bytes name a Group this keyhive knows. */
  private async isKnownGroup(bytes: Uint8Array): Promise<boolean> {
    try { return await this.kh.hasGroup(new this.bridge.GroupId(bytes)); }
    catch { return false; }
  }

  /** Whether these id bytes name an Individual this keyhive knows (self included). */
  private async isKnownIndividual(bytes: Uint8Array): Promise<boolean> {
    try { return await this.kh.hasIndividual(new this.bridge.IndividualId(bytes)); }
    catch { return false; }
  }

  /** This device's own power over a document or group, through any route. */
  private async ownPowerOver(membered: any): Promise<any | undefined> {
    const caps = membered.transitiveMembers ? await membered.transitiveMembers() : [];
    const mine = this.selfId();
    for (const m of caps) if (bytesToBase64(m.who.id.toBytes()) === mine) return m.can;
    return undefined;
  }

  async getIdentity(): Promise<{ deviceId: string; agentId: string; userGroupId: string | null }> {
    return {
      deviceId: String(this.kh.idString),
      agentId: this.selfId(),
      userGroupId: await this.fx.getUserGroupId(),
    };
  }

  // ---- User group (a "user" = a keyhive Group of device Individuals) ----

  async getUserGroupId(): Promise<string | null> {
    return this.fx.getUserGroupId();
  }

  /** Resolve a Group handle by its base64 id, or null if its ops haven't synced yet. */
  private async getGroupById(idB64: string): Promise<any | null> {
    try {
      const gid = new this.bridge.GroupId(base64ToBytes(idB64));
      const group = await this.kh.getGroup(gid);
      return group ?? null;
    } catch {
      return null;
    }
  }

  /** Poll for a group's ops to sync in, forcing keyhive sync between attempts. */
  private async waitForGroup(idB64: string, timeoutMs = 60000, intervalMs = 3000): Promise<any | null> {
    let group = await this.getGroupById(idB64);
    const start = Date.now();
    while (!group && Date.now() - start < timeoutMs) {
      this.fx.syncKeyhive();
      await new Promise((r) => setTimeout(r, intervalMs));
      group = await this.getGroupById(idB64);
    }
    return group;
  }

  /** Get the cached/resolved personal user-group handle, or null if none / not yet synced. */
  private async getUserGroup(): Promise<any | null> {
    const id = await this.fx.getUserGroupId();
    if (!id) return null;
    if (this.userGroup && this.userGroupIdCache === id) return this.userGroup;
    const group = await this.getGroupById(id);
    if (group) {
      this.userGroup = group;
      this.userGroupIdCache = id;
    }
    return group;
  }

  /**
   * Ensure this device has a personal user-group id.
   * - adoptGroupId: persist that id (a freshly-linked device adopting the host's group).
   * - create: mint a new group owned by this device (admin) if none exists yet.
   * - waitForSync: poll kh.getGroup until the adopted group's ops arrive.
   * Returns the resolved group id, or null if none and not creating.
   */
  async ensureUserGroup(opts: { create?: boolean; adoptGroupId?: string; waitForSync?: boolean } = {}): Promise<string | null> {
    let id = await this.fx.getUserGroupId();

    if (!id && opts.adoptGroupId) {
      id = opts.adoptGroupId;
      await this.fx.setUserGroupId(id);
    }

    if (!id && opts.create) {
      const groupId = await this.kh.generateGroup([]);
      const group = await this.kh.getGroup(groupId);
      id = bytesToBase64(groupId.toBytes());
      this.userGroup = group;
      this.userGroupIdCache = id;
      await this.fx.setUserGroupId(id);
      // The user-group administers the user's documents: make it an admin of
      // every document this device already owns/can reach.
      await this.adoptGroupOwnershipForAllDocs(group);
      await this.fx.persist();
      this.fx.syncKeyhive();
      return id;
    }

    if (!id) return null;

    if (opts.waitForSync) {
      const group = await this.waitForGroup(id);
      if (group) {
        this.userGroup = group;
        this.userGroupIdCache = id;
      }
    }
    return id;
  }

  /**
   * Make the personal user-group an admin of a document (idempotent).
   *
   * Documents this app creates already name the group as a co-root (see
   * {@link mintDocument}), so this is only for the leftovers: a document made
   * while the group could not be loaded, or made before the group existed.
   * A delegated admin is weaker than a co-root — it lasts only as long as the
   * device that issued it keeps its own standing — which is exactly why new
   * documents do not rely on it.
   *
   * Granting Admin takes Admin. On a document this device can only read or
   * edit there is nothing to do, and keyhive would refuse (escalation).
   */
  private async addGroupAsAdmin(doc: any, group: any): Promise<void> {
    const groupIdB64 = bytesToBase64(group.groupId.toBytes());
    const members = await doc.members();
    if (members.some((m: any) => bytesToBase64(m.who.toBytes()) === groupIdB64)) {
      return; // already a direct member
    }
    const admin = this.bridge.Power.admin();
    const mine = await this.ownPowerOver(doc);
    if (!mine || !mine.atLeast(admin)) return;
    await this.kh.addMember(group.groupId.toIdentifier(), this.docMembered(doc), admin);
  }

  /** Ensure the user-group exists, then make it an admin of the given document. */
  private async assignGroupAsAdmin(doc: any): Promise<void> {
    const groupId = await this.ensureUserGroup({ create: true });
    if (!groupId) return;
    const group = await this.getGroupById(groupId);
    if (!group) {
      // Dangling user-group (id persisted but group missing from keyhive). This is
      // detected at startup (findDanglingUserGroup → data-warning banner); bail rather
      // than leaving the doc owned only by this device.
      log.warn(`assignGroupAsAdmin: user-group ${groupId.slice(0, 8)} not loadable`);
      return;
    }
    await this.addGroupAsAdmin(doc, group);
    await this.fx.persist();
    this.fx.syncKeyhive();
  }

  /**
   * Detect a dangling user-group: an id is persisted but its group is missing from
   * keyhive (e.g. keyhive storage was migrated/reset while the IDB user-group-id
   * survived). Returns the dangling id, or null when no id is set (fresh install) or
   * the group resolves normally. Callers surface this and skip reconcileHomeDocs — a
   * dangling group can administer no docs, so reconcile would see zero accessible docs
   * and prune the whole home list.
   */
  async findDanglingUserGroup(): Promise<string | null> {
    const id = await this.fx.getUserGroupId();
    if (!id) return null; // fresh install — no group yet, nothing dangling
    const group = await this.getGroupById(id);
    return group ? null : id;
  }

  /** Add the user-group as admin to every document this device can reach. */
  private async adoptGroupOwnershipForAllDocs(group: any): Promise<void> {
    const reachable = await this.kh.reachableDocs();
    for (const summary of reachable) {
      try {
        await this.addGroupAsAdmin(summary.doc, group);
      } catch {
        // skip docs with incomplete CGKA state
      }
    }
  }

  /** Add a device (by its individual agentId) to the personal user-group. Idempotent; admin-only. */
  async addDeviceToGroup(deviceAgentIdB64: string): Promise<true> {
    const group = await this.getUserGroup();
    if (!group) throw new Error('User group not available');
    const targetBytes = base64ToBytes(deviceAgentIdB64);
    const members = await group.members();
    if (members.some((m: any) => bytesEqual(m.who.toBytes(), targetBytes))) {
      return true; // already a member
    }
    // keyhive needs the device's prekeys to bring it into the group's key
    // agreement, and those arrive with its contact card.
    if (!(await this.isKnownIndividual(targetBytes))) {
      throw new Error('Device agent not found (contact card not yet synced)');
    }
    await this.kh.addMember(this.identifier(targetBytes), this.groupMembered(group), this.bridge.Power.admin());
    await this.fx.persist();
    this.fx.syncKeyhive();
    return true;
  }

  /**
   * Refuse to revoke the current device's own membership.
   *
   * Not defensive tidiness — an admin's self-revocation *succeeds*, and the
   * follow-up `addMember` of a role change then fails because the signer holds
   * no standing any more: the device has locked itself out with no way back.
   * The UI never offers this (DeviceOptionsSheet excludes `isMe`), but the
   * kh-change-device-role / kh-remove-device RPCs are reachable directly.
   */
  private async assertNotSelf(deviceAgentIdB64: string, verb: string): Promise<void> {
    if (bytesEqual(this.selfIdBytes(), base64ToBytes(deviceAgentIdB64))) {
      throw new Error(`Cannot ${verb} this device from its own user group.`);
    }
  }

  /**
   * The devices holding a ROOT edge on a group: the ones its key itself
   * delegated to, at creation. Read from the group's membership ops rather than
   * from `members()`, which reports one capability per member (its strongest
   * route) and so can show a founder through a later, non-root delegation.
   */
  private async founderIds(group: any): Promise<Set<string>> {
    const groupId = bytesToBase64(group.groupId.toBytes());
    const founders = new Set<string>();
    const ops: Map<Uint8Array, any> = await this.kh.membershipOpsForAgent(await group.toPrincipal());
    ops.forEach((event) => {
      const signed = event.asSignedDelegation?.();
      const d = signed?.delegation;
      if (!d) return;
      if (bytesToBase64(d.issuer.toBytes()) === groupId && bytesToBase64(d.subject.toBytes()) === groupId) {
        founders.add(bytesToBase64(d.delegate.toBytes()));
      }
    });
    return founders;
  }

  /**
   * Refuse to revoke a device whose removal would take others down with it.
   *
   * In keyhive a delegation is live only while its issuer still has standing.
   * A group's authority starts at the device(s) its key delegated to when it
   * was created, and every later link hangs off the device that made it. So:
   *
   * - Revoking a **founder** kills every delegation beneath it. keyhive permits
   *   it — any admin may — and the group is left with NO members, for everyone,
   *   with no one able to add any. (Measured: the revoker itself then gets "no
   *   standing over the resource".) There is no undo.
   * - Revoking the device this one was **linked by** (or any device further up
   *   that chain) revokes this device's own standing along with it.
   *
   * keyhive enforces neither, so this is the only thing between a tap and a
   * destroyed user group. Removing a founder for real means making a new group.
   */
  private async assertManageable(group: any, deviceAgentIdB64: string, verb: string): Promise<void> {
    if ((await this.founderIds(group)).has(deviceAgentIdB64)) {
      throw new Error(`Cannot ${verb} the device that created this user group: every other device's access depends on it.`);
    }
    const issuerOf = new Map<string, string>();
    for (const m of await group.members()) {
      issuerOf.set(bytesToBase64(m.who.toBytes()), bytesToBase64(m.proof.verifyingKey));
    }
    const seen = new Set<string>();
    for (let cur: string | undefined = this.selfId(); cur && !seen.has(cur); cur = issuerOf.get(cur)) {
      seen.add(cur);
      if (issuerOf.get(cur) === deviceAgentIdB64) {
        throw new Error(`Cannot ${verb} the device this one was linked from: this device's own access depends on it.`);
      }
    }
  }

  /**
   * Whether both this device and the peer are members of the user-group.
   * The device-link handshake is complete once both sides are members: the new
   * device adopts the group id first (not yet a member), then the original/admin
   * device adds it on its reciprocal call. Used to tell the two handshake legs
   * apart in the UI.
   */
  private async bothDevicesInGroup(peerAgentIdB64: string): Promise<boolean> {
    const group = await this.getUserGroup();
    if (!group) return false;
    const peerBytes = base64ToBytes(peerAgentIdB64);
    const members = await group.members();
    const isMember = (b: Uint8Array) => members.some((m: any) => bytesEqual(m.who.toBytes(), b));
    return isMember(this.selfIdBytes()) && isMember(peerBytes);
  }

  async removeDeviceFromGroup(deviceAgentIdB64: string): Promise<void> {
    await this.assertNotSelf(deviceAgentIdB64, 'remove');
    const group = await this.getUserGroup();
    if (!group) return;
    const targetBytes = base64ToBytes(deviceAgentIdB64);
    const members = await group.members();
    if (!members.some((m: any) => bytesEqual(m.who.toBytes(), targetBytes))) return;
    await this.assertManageable(group, deviceAgentIdB64, 'remove');
    await this.kh.revokeMember(this.identifier(targetBytes), true, this.groupMembered(group));
    await this.fx.persist();
    this.fx.syncKeyhive();
  }

  /**
   * Change a device's access level within the personal user-group: revoke + re-add
   * with a new Power, the same idiom as the doc-level changeRole but targeting the
   * group. Admin-only. forceResyncAllPeers so the affected device learns its new
   * access.
   *
   * What is refused, all surfaced by DeviceOptionsSheet rather than discovered
   * as a failed call:
   * - the current device ({@link assertNotSelf});
   * - a founding device, or one this device's own link descends from
   *   ({@link assertManageable} — `DeviceEntry.isFounder` / `issuerAgentId`).
   *
   * The change is two keyhive operations, and the revoke is not undone if the
   * re-add fails. So everything the re-add could object to is checked FIRST: the
   * role parses, this device holds at least the power it is about to grant
   * (keyhive rejects an escalation), and the target's prekeys are known.
   */
  async changeDeviceRole(deviceAgentIdB64: string, newRole: string): Promise<void> {
    await this.assertNotSelf(deviceAgentIdB64, 'change access for');
    const group = await this.getUserGroup();
    if (!group) throw new Error('User group not available');
    const targetBytes = base64ToBytes(deviceAgentIdB64);
    const members = await group.members();
    if (!members.some((m: any) => bytesEqual(m.who.toBytes(), targetBytes))) throw new Error('Device not found in group');
    const power = this.power(newRole);
    await this.assertManageable(group, deviceAgentIdB64, 'change access for');
    await this.assertCanGrant(group, power);
    if (!(await this.isKnownIndividual(targetBytes))) throw new Error('Device agent not found (contact card not yet synced)');
    const target = this.identifier(targetBytes);
    await this.kh.revokeMember(target, true, this.groupMembered(group));
    await this.kh.addMember(target, this.groupMembered(group), power);
    await this.fx.persist();
    this.fx.syncKeyhive();
    this.fx.forceResyncAllPeers();
  }

  /** Throw unless this device holds at least `power` over a document or group. */
  private async assertCanGrant(membered: any, power: any): Promise<void> {
    const mine = await this.ownPowerOver(membered);
    if (!mine || !mine.atLeast(power)) {
      throw new Error(`You need ${power.toString()} access yourself to grant it.`);
    }
  }

  /**
   * Link another device into the same user-group, given the peer's device agentId and
   * (optionally) the group id carried over the trusted QR channel.
   * Converges both devices onto one group, then adds the peer if we are the group admin
   * (the non-admin side fails silently and is added by the admin's reciprocal call).
   */
  async linkDevice(peerAgentIdB64: string, peerGroupId?: string | null): Promise<{ userGroupId: string | null; linked: boolean }> {
    let myGroupId = await this.fx.getUserGroupId();

    if (!myGroupId && peerGroupId) {
      // Fresh device adopting the peer's group; the peer (admin) adds us.
      myGroupId = await this.ensureUserGroup({ adoptGroupId: peerGroupId, waitForSync: true });
    } else if (myGroupId && peerGroupId && myGroupId !== peerGroupId) {
      // Both sides already have a group — converge on the lexicographically smaller id.
      const canonical = myGroupId < peerGroupId ? myGroupId : peerGroupId;
      if (canonical !== myGroupId) {
        await this.fx.setUserGroupId(canonical);
        this.userGroup = null;
        this.userGroupIdCache = null;
        myGroupId = await this.ensureUserGroup({ waitForSync: true });
      }
    } else if (!myGroupId && !peerGroupId) {
      // Neither side has a group (the peer sent no group id) — create one.
      myGroupId = await this.ensureUserGroup({ create: true });
    }

    try {
      await this.addDeviceToGroup(peerAgentIdB64);
    } catch {
      // Not the admin, or the peer's contact card hasn't synced yet — the admin side
      // performs the add via its own reciprocal linkDevice call.
    }

    // The handshake is complete once both devices are members of the group. On
    // the new device's first leg, this device isn't a member yet (the admin adds
    // it on its reciprocal call), so this is false and the UI shows a return link.
    const linked = await this.bothDevicesInGroup(peerAgentIdB64);
    return { userGroupId: myGroupId, linked };
  }

  /**
   * List the devices in the personal user-group, each with its real access.
   *
   * The filter is "not a known group", NOT "a known individual": a device whose
   * prekeys have not reached this keyhive yet is still a device, and dropping
   * it would hide a member that is really there.
   *
   * `role: null` means no membership to report — revoked, or the group isn't
   * readable (no group yet, or its ops haven't synced). It is never a guess.
   */
  async listGroupDevices(): Promise<DeviceEntry[]> {
    const myAgentId = this.selfId();
    const noAccess = (agentId: string): DeviceEntry =>
      ({ agentId, role: null, isMe: agentId === myAgentId, isFounder: false });

    const group = await this.getUserGroup();
    if (!group) return [noAccess(myAgentId)];

    // A founder holds a root edge: its delegation was issued by the group's own
    // key at creation. Revoking it destroys the group (see assertManageable), so
    // the UI treats a founder's access as permanent.
    const founders = await this.founderIds(group);
    const members = await group.members();
    const devices: DeviceEntry[] = [];
    for (const m of members) {
      const idBytes: Uint8Array = m.who.toBytes();
      if (await this.isKnownGroup(idBytes)) continue;
      const agentId = bytesToBase64(idBytes);
      devices.push({
        agentId,
        role: toMemberRole(m.can.toString()),
        isMe: agentId === myAgentId,
        isFounder: founders.has(agentId),
        // Who signed the delegation this row reports — the device that linked
        // it, or (for a founder) the group's own key.
        issuerAgentId: bytesToBase64(m.proof.verifyingKey),
      });
    }

    // Absent from members(): revoked by a peer admin, or mid-link before the
    // admin's reciprocal add has arrived. Keep a row so the screen still shows
    // "This device" (dropping it would trip DeviceList's "No linked devices."
    // empty state), but report no access rather than inventing admin.
    if (!devices.some((d) => d.agentId === myAgentId)) devices.push(noAccess(myAgentId));

    // members() is a HashMap walk, so its order is arbitrary. The old unshift
    // guaranteed self came first and the UI still reads as though it does.
    return devices.sort((x, y) => Number(y.isMe) - Number(x.isMe));
  }

  /**
   * A contact bundle for a real exchange.
   *
   * MINTS a fresh prekey: `kh.contactCard()` picks one of our live prekeys,
   * rotates it to produce the key the card publishes, then rotates again so that
   * published key leaves our advertised pool immediately. That is the point —
   * the key in a card is issued to exactly one contact and never handed to
   * another, so a leaked card burns only that one channel. Call this only when an
   * exchange is actually happening; use {@link previewContactCard} to show a size
   * without minting.
   */
  async getContactCard(): Promise<string> {
    return this.buildContactBundle(await this.kh.contactCard());
  }

  /**
   * A stand-in bundle the same shape and (near enough) size as the real one,
   * built WITHOUT minting a prekey — for showing a transfer size before anyone
   * has joined. Never send this: `kh.getExistingContactCard()` returns an
   * already-published prekey op rather than rotating, so it conveys no key
   * reserved for the receiver.
   *
   * Returns the bundle rather than a byte count so the caller can wrap it in the
   * same envelope it will really send and measure that exactly — the envelope
   * nests this string as a JSON *string*, so its overhead scales with the card's
   * quote count and is not a constant.
   *
   * Approximate by a few dozen bytes, and only ever shown as "~N": the existing
   * card is typically an add-key op (one share key) from the init-time prekey pool
   * while a real card is a rotate-key op (old + new). `groupEvents` — the part that used to vary by orders
   * of magnitude — is exact. The authoritative figure is the one `rdvSendPayload`
   * reports at the 'sending' step.
   */
  async previewContactCard(): Promise<string> {
    return this.buildContactBundle(await this.kh.getExistingContactCard());
  }

  /**
   * Wrap a contact card in a self-describing "contact bundle". Sharing is
   * group-only, so a friend needs the receiver to be able to resolve our
   * *user-group* — but a raw contact card only conveys this device's Individual.
   * Attach the user-group's ops (when one exists) so the receiver can ingest them
   * and resolve the group as a share target without waiting on relay reachability
   * (a group never syncs to a non-member otherwise). We never create a group
   * here — only bundle one that already exists.
   */
  private async buildContactBundle(card: any): Promise<string> {
    const bundle: ContactBundle = {
      __kind: CONTACT_BUNDLE_KIND,
      v: CONTACT_BUNDLE_VERSION,
      card: bytesToBase64(card.toBytes()),
    };
    const group = await this.getUserGroup();
    if (group) {
      const groupId = bytesToBase64(group.groupId.toBytes());
      bundle.groupId = groupId;
      // The delegation that defines our group (and names us its admin) lives in
      // our *Individual's* membership ops — NOT in the group agent's events — so
      // we gather events for both: the individual (carries the group delegation)
      // and the group (its own membership ops).
      const myId = this.selfId();
      // Our OTHER devices — the only agents whose prekeys the receiver needs
      // from us (see contactBundleEvents).
      const otherDevices = new Set<string>();
      for (const m of await group.transitiveMembers()) otherDevices.add(bytesToBase64(m.who.id.toBytes()));
      otherDevices.delete(myId);
      bundle.groupEvents = await this.contactBundleEvents(new Set([myId, groupId]), otherDevices);
    }
    return JSON.stringify(bundle);
  }

  /**
   * The events a receiver needs to resolve us as a share target: the membership
   * ops defining our user-group (and naming our devices in it) plus the prekey
   * ops needed to encrypt to those devices.
   *
   * Deliberately NOT `eventsForAgent`, which also returns
   * `cgka_ops_reachable_by_agent` — every CGKA epoch of every document we can
   * reach, never pruned. Those are per-document BeeKEM secrets for *our* docs: a
   * receiver is not a member of them and can never use them, but they made the
   * card grow without bound with our document count and editing history (a fresh
   * account's card was ~3 KB, an established one 350 KB — past the rendezvous
   * wire cap). When we later share a doc with this contact, `addMember` mints
   * that doc's CGKA ops and they arrive over normal keyhive sync.
   *
   * `allAgentEvents()` keeps membership, prekey and CGKA ops in separate indices
   * over one deduplicated hash→bytes map, so we simply never walk the CGKA one.
   * It still *computes* them inside the wasm; a narrow binding that skips that
   * work is a follow-up — this only stops us putting them on the wire.
   *
   * `prekeyOwners` names the only agents whose prekey ops are shipped: our OTHER
   * devices, because a receiver adding our *group* to a doc must encrypt to each
   * of them. Two things are deliberately left out.
   *
   * - Our own device: every `kh.contactCard()` call runs
   *   `generate_private_prekey`, which rotates twice and leaves two permanent ops
   *   in our prekey history — so this term grew by ~480 B on every single visit
   *   to the invite screen, exchange or not, forever. They are also redundant:
   *   our current prekey rides in the bundle's `card`, which `receiveContactCard`
   *   ingests.
   * - Everyone else. Under keyhive >= 0.6 the prekey sources reported for us and
   *   for our group include every device that shares a document with us, so
   *   "all but our own" put our friends' device ids and prekey histories into a
   *   card we hand to people we do not know yet, and grew it with every friend.
   */
  private async contactBundleEvents(agentIds: Set<string>, prekeyOwners: Set<string>): Promise<string[]> {
    const all = await this.kh.allAgentEvents();
    // Every map here is keyed by a Uint8Array *object*, so `get()` by value can
    // never match (reference identity). Re-key each one through base64 once.
    const rekey = (m: Map<any, any>): Map<string, any> => {
      const out = new Map<string, any>();
      m.forEach((value, key) => out.set(bytesToBase64(key), value));
      return out;
    };

    const hashes = new Set<string>();
    const collect = (agentIndex: Map<any, any>, sources: Map<any, any>, keepSource?: (id: string) => boolean) => {
      const byAgent = rekey(agentIndex);
      const bySource = rekey(sources);
      for (const agentId of agentIds) {
        for (const sourceId of byAgent.get(agentId) ?? []) {
          const source = bytesToBase64(sourceId);
          if (keepSource && !keepSource(source)) continue;
          for (const hash of bySource.get(source) ?? []) {
            hashes.add(bytesToBase64(hash));
          }
        }
      }
    };
    // Membership sources are keyed by group id, document id, or (for revocations)
    // agent id. Keep only our own group and device: a per-document ACL delegation
    // tells the receiver which docs we own, which they do not need to add our
    // group to *their* doc — and shipping them made this term scale with our
    // document count too. Our group's source carries the full proof closure of
    // the delegations that define it, including any parent groups.
    collect(all.agentMembershipSources, all.membershipSources, (id) => agentIds.has(id));
    // Prekey sources are keyed by agent, and reach well past our own devices —
    // to everyone in a document we can reach. Keep only `prekeyOwners` (see
    // above), so this term is bounded by who we are rather than by what we have,
    // who we share with, or how often we have opened the invite screen.
    collect(all.agentPrekeySources, all.prekeySources, (id) => prekeyOwners.has(id));
    // all.agentCgkaSources / all.cgkaSources are deliberately never traversed.

    const events = rekey(all.events);
    const out: string[] = [];
    for (const hash of hashes) {
      const bytes: Uint8Array | undefined = events.get(hash);
      if (bytes) out.push(bytesToBase64(bytes));
    }
    return out;
  }

  async receiveContactCard(cardJson: string): Promise<{ agentId: string; isOwnCard: boolean; groupId?: string }> {
    const bundle = parseContactBundle(cardJson);
    if (!bundle) throw new Error('Invalid contact card (expected a contact bundle)');

    // fromBytes verifies the card's signature; a tampered card throws here.
    const card = this.bridge.ContactCard.fromBytes(base64ToBytes(bundle.card));
    const individualId = await this.kh.receiveContactCard(card);
    const agentId = bytesToBase64(individualId.toBytes());
    const isOwnCard = agentId === this.selfId();

    if (!isOwnCard) {
      // Ingest the contact's user-group ops so we can later resolve their group
      // as a share target (addMember). Skip our own group (a no-op). Fail fast on
      // a bad payload rather than silently recording a half-usable contact.
      const myGroupId = await this.fx.getUserGroupId();
      if (bundle.groupEvents?.length && bundle.groupId !== myGroupId) {
        const events = bundle.groupEvents;
        // Non-string entries count as over-limit — they could never decode.
        const totalBytes = events.reduce((n, e) => n + (typeof e === 'string' ? e.length : Number.POSITIVE_INFINITY), 0);
        if (events.length > MAX_BUNDLE_GROUP_EVENTS || totalBytes > MAX_BUNDLE_GROUP_EVENTS_BYTES) {
          throw new Error(`Contact card group ops too large (${events.length} events, ${totalBytes} bytes)`);
        }
        await this.kh.ingestEventsBytes(events.map(base64ToBytes));
      }
      await this.fx.persist();
    }
    return { agentId, isOwnCard, groupId: bundle?.groupId };
  }

  /**
   * Who a document is shared with: its DIRECT members — user-groups and any
   * individually-added devices — each with its role.
   *
   * Read from `doc.members()`, not `kh.docMemberCapabilities()`: the latter is
   * the flattened set of individuals whose prekeys we hold (who can decrypt),
   * and has no groups in it. The sharing UI is about who was granted access, and
   * grants are made to groups.
   *
   * An id that is neither a group nor an individual this keyhive knows is
   * reported as a group with no devices. Sharing is group-only, so that is what
   * it almost certainly is — a friend's group whose own ops have not synced yet.
   */
  async getDocMembers(khDocId: string): Promise<MemberInfo[]> {
    const doc = await this.kh.getDocument(new this.bridge.DocumentId(base64ToBytes(khDocId)));
    const caps: any[] = doc ? await doc.members() : [];
    const myAgentId = this.selfId();
    const myUserGroupId = await this.fx.getUserGroupId();

    const entries: { agentId: string; displayId: string; role: MemberRole | null; isGroup: boolean }[] = [];
    for (const c of caps) {
      const idBytes: Uint8Array = c.who.toBytes();
      const isGroup = (await this.isKnownGroup(idBytes)) || !(await this.isKnownIndividual(idBytes));
      entries.push({
        agentId: bytesToBase64(idBytes),
        displayId: c.who.toString(),
        role: toMemberRole(c.can.toString()),
        isGroup,
      });
    }

    // Expand each group member to its devices: used both to hide a device that
    // a present group already covers and to report each group's device list to
    // the UI. A group whose ops haven't synced resolves to nothing — no devices.
    const groupDevices = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.isGroup) continue;
      const group = await this.getGroupById(e.agentId);
      if (!group) continue;
      const ids = new Set<string>();
      for (const gm of await group.members()) {
        const gmBytes: Uint8Array = gm.who.toBytes();
        if (!(await this.isKnownGroup(gmBytes))) ids.add(bytesToBase64(gmBytes));
      }
      groupDevices.set(e.agentId, [...ids]);
    }
    const groupedDeviceIds = new Set<string>([...groupDevices.values()].flat());

    return entries
      // A relay-only grant carries ciphertext but cannot read it: not a member to show.
      .filter((e) => e.role !== null)
      .map((e): MemberInfo => {
        const base = {
          agentId: e.agentId,
          displayId: e.displayId,
          role: e.role as MemberRole,
          // "Me" is this device or my own user-group (not every group I belong to).
          isMe: e.agentId === myAgentId || (e.isGroup && e.agentId === myUserGroupId),
        };
        return e.isGroup
          ? { ...base, type: 'group', deviceIds: groupDevices.get(e.agentId) ?? [] }
          : { ...base, type: 'individual' };
      })
      // Hide devices already covered by a present group — the group stands in for them.
      .filter((m: MemberInfo) => !(m.type === 'individual' && groupedDeviceIds.has(m.agentId)));
  }

  /** A Power as the access string the UI reads ("Admin"/"Edit"/"Read"), or null for none. */
  private accessString(power: any | undefined): string | null {
    // Relay-only is not access to the document: it cannot read it.
    return power && power.isReader ? power.toString() : null;
  }

  async getMyAccess(khDocId: string): Promise<string | null> {
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    return this.accessString(await this.kh.accessForDoc(this.kh.id.toIdentifier(), docId));
  }

  /**
   * This user's access to a doc via their personal user-group (resolves group
   * membership), or null. This is the home page's ownership lens: we check the
   * user-group, not the device, so revoking the group can actually archive a
   * self-created doc — the creating device keeps its own root edge regardless.
   */
  async getUserGroupAccess(khDocId: string): Promise<string | null> {
    const groupId = await this.fx.getUserGroupId();
    if (!groupId) return null;
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    return this.accessString(await this.kh.accessForDoc(this.identifier(base64ToBytes(groupId)), docId));
  }

  /**
   * One pass over reachableDocs() for the home-page reconcile.
   * - `accessibleKhIds`: docs the user-group has at least read access to — the
   *   home set (excludes relay-visible docs the user can't actually access).
   * - `reachableKhIds`: every doc reachable in the keyhive graph (a superset).
   * The caller uses the difference to tell a *revoked* doc (reachable but no
   * group access → prune) from a *not-yet-synced* one (not reachable → keep).
   */
  async enumerateUserDocs(): Promise<{ accessibleKhIds: string[]; reachableKhIds: string[] }> {
    const groupId = await this.fx.getUserGroupId();
    const reachable = await this.kh.reachableDocs();
    const reachableKhIds: string[] = [];
    const accessibleKhIds: string[] = [];
    for (const summary of reachable) {
      const khDocId = bytesToBase64(summary.doc.id.toBytes());
      reachableKhIds.push(khDocId);
      if (groupId && (await this.getUserGroupAccess(khDocId))) accessibleKhIds.push(khDocId);
    }
    return { accessibleKhIds, reachableKhIds };
  }

  async addMember(agentIdB64: string, docId: string, role: string): Promise<true> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found');
    // Sharing a document ensures the user-group exists and administers the doc.
    await this.assignGroupAsAdmin(doc);
    const target = await this.resolveShareTarget(doc, agentIdB64);
    await this.kh.addMember(target, this.docMembered(doc), this.power(role));
    await this.fx.persist();
    this.fx.syncKeyhive();
    // Re-evaluate the share gate so the new member's devices are announced the
    // document and it syncs to them (see khAccessCheck in keyhive-repo.ts).
    this.fx.forceResyncAllPeers();
    return true;
  }

  async revokeMember(agentIdB64: string, docId: string): Promise<true> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found');
    const target = await this.directMember(doc, agentIdB64);
    await this.kh.revokeMember(target, true, this.docMembered(doc));
    await this.fx.persist();
    this.fx.syncKeyhive();
    // Re-run the share handshake so the revocation (and rotated keys) propagate
    // to connected peers — including the revoked member, so they learn they no
    // longer have access. Without this only the local view updates (see addMember).
    this.fx.forceResyncAllPeers();
    return true;
  }

  /**
   * Change a member's role on a document: revoke, then re-add at the new power.
   * The revoke is not undone if the re-add fails, so what the re-add could
   * object to is checked first (see changeDeviceRole).
   */
  async changeRole(agentIdB64: string, docId: string, newRole: string): Promise<true> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found');
    const target = await this.directMember(doc, agentIdB64);
    const power = this.power(newRole);
    await this.assertCanGrant(doc, power);
    await this.kh.revokeMember(target, true, this.docMembered(doc));
    await this.kh.addMember(target, this.docMembered(doc), power);
    await this.fx.persist();
    this.fx.syncKeyhive();
    this.fx.forceResyncAllPeers();
    return true;
  }

  /**
   * Create a keyhive document for sharing and return it.
   * Does NOT register the automerge→keyhive mapping (caller does that once
   * the automerge document ID is known).
   */
  async createKeyhiveDoc(): Promise<{ khDocId: string; docIdBytes: Uint8Array }> {
    const doc = await this.mintDocument();
    const khDocId = bytesToBase64(doc.docId.toBytes());
    this.khDocuments.set(khDocId, doc);
    // Covers the fallback where the group could not be made a co-root.
    await this.assignGroupAsAdmin(doc);
    return { khDocId, docIdBytes: doc.docId.toBytes() };
  }

  /**
   * Mint a keyhive document with the personal user-group as a CO-ROOT.
   *
   * A document's authority starts at its root edges: the creating device always
   * gets one, and so does every id passed as a coparent. Naming the group there
   * is what makes the user's documents belong to the user rather than to one
   * device. The alternative — create alone, then delegate admin to the group —
   * leaves the group's access hanging off the creating device: revoke that
   * device from the document and the group's delegation dies with it, leaving
   * the document with no members at all (measured; encrypt then fails "Group has
   * no members"). A root edge can only be minted at creation, so this cannot be
   * repaired afterwards.
   *
   * Falls back to no coparent when the group cannot be loaded (a dangling
   * user-group — reported at startup), so creating a document still works.
   */
  private async mintDocument(): Promise<any> {
    const groupId = await this.ensureUserGroup({ create: true });
    const group = groupId ? await this.getGroupById(groupId) : null;
    if (groupId && !group) log.warn(`mintDocument: user-group ${groupId.slice(0, 8)} not loadable; creating without it`);
    const ref = new this.bridge.ChangeId(new Uint8Array(32));
    const docId = await this.kh.generateDocument(group ? [group.groupId.toIdentifier()] : [], ref, []);
    const doc = await this.kh.getDocument(docId);
    if (!doc) throw new Error('keyhive did not return the document it just created');
    return doc;
  }

  /**
   * Enable sharing on an automerge document.
   * If docIdBytes is provided, looks up the keyhive doc that already has
   * that doc_id (used when the automerge doc was created with the keyhive
   * doc_id as its ID). Otherwise creates a new keyhive document.
   */
  async enableSharing(automergeDocId: string, existingDocIdBytes?: Uint8Array): Promise<{ khDocId: string }> {
    let doc: any;
    if (existingDocIdBytes) {
      try {
        const docId = new this.bridge.DocumentId(existingDocIdBytes);
        doc = await this.kh.getDocument(docId);
      } catch {
        // Bytes don't correspond to a known keyhive document — fall through
      }
    }
    if (!doc) doc = await this.mintDocument();
    const khDocId = bytesToBase64(doc.docId.toBytes());
    this.khDocuments.set(khDocId, doc);
    // The user-group administers every document this user shares.
    await this.assignGroupAsAdmin(doc);
    await this.fx.persist();
    this.fx.syncKeyhive();
    return { khDocId };
  }

  async registerSharingGroup(khDocId: string): Promise<true> {
    if (!this.khDocuments.has(khDocId)) {
      const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
      const doc = await this.kh.getDocument(docId);
      if (doc) {
        this.khDocuments.set(khDocId, doc);
      }
    }
    return true;
  }

  async getKnownFriends(
    excludeDocId?: string,
    friendGroupIds?: string[],
  ): Promise<MemberInfo[]> {
    const myGroupId = await this.fx.getUserGroupId();
    const seen = new Map<string, MemberInfo>();

    const excludeSet = new Set<string>();
    if (excludeDocId) {
      const excludeMembers = await this.getDocMembers(excludeDocId);
      for (const m of excludeMembers) excludeSet.add(m.agentId);
    }

    // Group members already sharing a document. Sharing is group-only, so only
    // group members are surfaced as contacts; bare individuals are skipped.
    const reachable = await this.kh.reachableDocs();
    for (const summary of reachable) {
      let members: any[];
      try {
        // Direct members: the groups a doc was shared with (see getDocMembers).
        members = await summary.doc.members();
      } catch {
        // Membership state may be incomplete for some docs — skip
        continue;
      }
      for (const m of members) {
        const idBytes: Uint8Array = m.who.toBytes();
        const agentId = bytesToBase64(idBytes);
        if (agentId === myGroupId) continue;
        if (excludeSet.has(agentId)) continue;
        if (seen.has(agentId)) continue;
        if (!(await this.isKnownGroup(idBytes))) continue;
        const role = toMemberRole(m.can.toString());
        if (!role) continue;
        seen.set(agentId, {
          agentId,
          displayId: m.who.toString(),
          role,
          type: 'group',
          isMe: false,
          deviceIds: [],
        });
      }
    }

    // Also include contacts from the friend list who aren't yet members of any
    // document. A stored contact is always a user-group (its id is the group id).
    if (friendGroupIds) {
      for (const groupId of friendGroupIds) {
        if (groupId === myGroupId) continue;
        if (excludeSet.has(groupId)) continue;
        if (seen.has(groupId)) continue;
        const group = await this.getGroupById(groupId);
        seen.set(groupId, {
          agentId: groupId,
          displayId: group ? group.id.toString() : groupId,
          type: 'group',
          isMe: false,
          deviceIds: [],
        });
      }
    }

    return [...seen.values()];
  }

  /**
   * Every device this one currently has a relationship with, by device key
   * (base64 agentId): this user's other devices, and the devices of each friend
   * (`friendGroupIds`, the roster) and of each group sharing a document with
   * this user. This device itself is not listed.
   *
   * It is the answer to "is this a device I know?" — which a proved key alone
   * is not: the secure channel shows a peer holds the key in its peerId, and
   * anyone can mint a key. A direct connection, a discovery token and "another
   * user is online" are all decided from this map.
   *
   * A device leaves the map when its user stops being a friend and shares no
   * document any more, or when it is removed from its user's group. Several
   * keyhive calls: callers cache it (see `relations` in keyhive-repo.ts).
   */
  async relatedDevices(friendGroupIds: string[] = []): Promise<Map<string, RelatedDevice>> {
    const out = new Map<string, RelatedDevice>();
    const me = this.selfId();
    const myGroupId = await this.fx.getUserGroupId();
    if (myGroupId) {
      for (const d of await this.listGroupDevices()) {
        if (d.role && !d.isMe) out.set(d.agentId, { groupId: myGroupId, own: true });
      }
    }
    for (const g of await this.getKnownFriends(undefined, friendGroupIds)) {
      const group = await this.getGroupById(g.agentId);
      if (!group) continue;
      let members: any[];
      try { members = await group.members(); } catch { continue; } // membership not synced yet
      for (const m of members) {
        const idBytes: Uint8Array = m.who.toBytes();
        if (await this.isKnownGroup(idBytes)) continue;
        const agentId = bytesToBase64(idBytes);
        if (agentId === me || out.has(agentId)) continue;
        out.set(agentId, { groupId: g.agentId, own: false });
      }
    }
    return out;
  }

  /**
   * base64 signature of the direct delegation granting the user-group access to
   * a doc (at most one: `members()` reports a member's strongest route). A share
   * after a revoke mints a new delegation with a new signature, so a signature
   * absent from a recorded set marks a grant issued later — the home page's
   * "un-hide a deleted doc on re-share" signal. Returns [] when there is no group, no doc, or no direct grant, and on
   * error (partial CGKA/op state can make member enumeration throw): an empty
   * baseline disables re-share detection rather than mis-firing it.
   */
  async getUserGroupGrantSigs(khDocId: string): Promise<string[]> {
    try {
      const groupId = await this.fx.getUserGroupId();
      if (!groupId) return [];
      const doc = await this.kh.getDocument(new this.bridge.DocumentId(base64ToBytes(khDocId)));
      if (!doc) return [];
      const targetBytes = base64ToBytes(groupId);
      const caps = await doc.members();
      const sigs: string[] = [];
      for (const c of caps) {
        const idBytes: Uint8Array = c.who.toBytes();
        if (idBytes.length === targetBytes.length && idBytes.every((b: number, i: number) => b === targetBytes[i])) {
          sigs.push(bytesToBase64(c.proof.signature));
        }
      }
      return sigs;
    } catch (err) {
      log.warn('getUserGroupGrantSigs failed:', err);
      return [];
    }
  }

  /**
   * Revoke the current user's own access to a document — the keyhive half of
   * the home page "archive" action.
   * Revokes the personal **user-group** (not the device), so the doc drops from
   * every device's home view.
   *
   * keyhive lets a member revoke only what it has standing over: an **admin**
   * of the doc can revoke the group's grant, a reader or editor cannot (it
   * throws "no standing to revoke that member"). So leaving a doc someone shared
   * read-only or edit-only does not change keyhive at all — `no-authority` —
   * and the caller hides it with a tombstone instead. The outcome is reported
   * rather than swallowed: the caller tombstones either way and keys its
   * message off `status`.
   * `grantSigs` is the pre-revoke re-share-detection baseline (getUserGroupGrantSigs).
   */
  async revokeMyAccess(khDocId: string): Promise<ArchiveDocResult> {
    const khDocIdObj = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const doc = await this.kh.getDocument(khDocIdObj);
    if (!doc) return { status: 'not-found', grantSigs: [] };
    const groupId = await this.fx.getUserGroupId();
    const grantSigs = groupId ? await this.getUserGroupGrantSigs(khDocId) : [];
    let status: ArchiveDocResult['status'] = 'no-authority';
    if (groupId) {
      try {
        // Nothing revoked (the group holds no direct grant here) is not a revoke.
        const revoked: any[] = await this.kh.revokeMember(
          this.identifier(base64ToBytes(groupId)), true, this.docMembered(doc));
        if (revoked.length > 0) status = 'revoked';
      } catch (err) {
        log.warn('revokeMyAccess: self-revoke failed:', err);
      }
    }
    await this.fx.persist();
    this.fx.syncKeyhive();
    if (status === 'revoked') {
      // Re-run the share handshake so the revocation (and rotated keys) reach
      // connected peers — the user's other devices and the sharer (see revokeMember).
      this.fx.forceResyncAllPeers();
    }
    return { status, grantSigs };
  }

  /**
   * Resolve a base64 id to the Identifier to add to a document.
   * Sharing is group-only: a user Group this keyhive knows (so all of a user's
   * devices get access — it resolves once the contact's group ops have been
   * ingested, see receiveContactCard), or an id that is already a direct member
   * of this document. Anything else is rejected — a bare Individual device is
   * never a share target.
   */
  private async resolveShareTarget(doc: any, idB64: string): Promise<any> {
    const bytes = base64ToBytes(idB64);
    if (await this.isKnownGroup(bytes)) return this.identifier(bytes);
    try {
      return await this.directMember(doc, idB64);
    } catch {
      // not a member and not a group — reject
    }
    throw new Error('Agent not found');
  }

  /** The Identifier of a DIRECT member of a document, by base64 id; throws if it is not one. */
  private async directMember(doc: any, agentIdB64: string): Promise<any> {
    const targetBytes = base64ToBytes(agentIdB64);
    for (const m of await doc.members()) {
      if (bytesEqual(m.who.toBytes(), targetBytes)) return m.who;
    }
    throw new Error('Member not found in document');
  }
}
