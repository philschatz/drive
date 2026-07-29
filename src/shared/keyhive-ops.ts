import { Keyhive } from "@keyhive/keyhive/slim";
import type { MemberRole, MemberInfo, ArchiveDocResult } from './keyhive-types';

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
// can resolve that group as a share target. Backward-compatible: a raw card
// string (no envelope) is still accepted by receiveContactCard.
const CONTACT_BUNDLE_KIND = 'contact-bundle';
interface ContactBundle {
  __kind: typeof CONTACT_BUNDLE_KIND;
  /** Raw ContactCard.toJson() string for the sender's Individual device. */
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

/** Parse a contact-bundle envelope, or null if the string is not one. */
function parseContactBundle(cardJson: string): ContactBundle | null {
  try {
    const parsed = JSON.parse(cardJson);
    if (parsed && typeof parsed === 'object' && parsed.__kind === CONTACT_BUNDLE_KIND && typeof parsed.card === 'string') {
      return parsed as ContactBundle;
    }
  } catch {
    // Not JSON / not our envelope.
  }
  return null;
}

export function errMsg(err: any): string {
  if (!err) return 'Unknown error';
  if (typeof err.message === 'function') return err.message();
  return err.message || String(err);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface KeyhiveOpsSideEffects {
  persist: () => Promise<void>;
  syncKeyhive: () => void;
  registerDoc: (automergeDocId: string, khDocId: any) => void;
  forceResyncAllPeers: () => void;
  findDoc: (docId: string) => void;
  saveEventBytes: (eventBytes: Uint8Array) => Promise<void>;
  /** Read the persisted personal user-group id (base64), or null if none. */
  getUserGroupId: () => Promise<string | null>;
  /** Persist the personal user-group id (base64). */
  setUserGroupId: (id: string) => Promise<void>;
}

/** The subset of @keyhive/keyhive/slim that KeyhiveOps needs as constructors/factories. */
export interface KeyhiveBridge {
  ChangeId: new (bytes: Uint8Array) => any;
  DocumentId: new (bytes: Uint8Array) => any;
  Identifier: new (bytes: Uint8Array) => any;
  GroupId: { fromBytes(bytes: Uint8Array): any };
  Signer: { memorySignerFromBytes(bytes: Uint8Array): any };
  CiphertextStore: { newInMemory(): any };
  Keyhive: { init(signer: any, store: any, cb: () => void): Promise<any> };
  Access: { tryFromString(s: string): any | undefined };
  ContactCard: { fromJson(json: string): any };
}

/** Normalize a keyhive Access string (e.g. "Admin") into a MemberRole. */
function toMemberRole(can: string): MemberRole {
  switch (can.toLowerCase()) {
    case 'admin': return 'admin';
    case 'edit': return 'edit';
    default: return 'read';
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

  async getIdentity(): Promise<{ deviceId: string; agentId: string; userGroupId: string | null }> {
    const me = await this.kh.individual;
    return {
      deviceId: String(this.kh.idString),
      agentId: bytesToBase64(me.id.toBytes()),
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
      const gid = this.bridge.GroupId.fromBytes(base64ToBytes(idB64));
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
      const group = await this.kh.generateGroup([]);
      id = bytesToBase64(group.groupId.toBytes());
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
   * Make the personal user-group an admin co-owner of a document (idempotent).
   * The creating device cannot be removed (its root delegation is permanent in
   * keyhive), but the group as admin means all of the user's devices administer
   * the doc via group membership.
   */
  private async addGroupAsAdmin(doc: any, group: any): Promise<void> {
    const groupIdB64 = bytesToBase64(group.groupId.toBytes());
    const members = await this.kh.docMemberCapabilities(doc.doc_id);
    if (members.some((m: any) => bytesToBase64(m.who.id.toBytes()) === groupIdB64)) {
      return; // already a member
    }
    const admin = this.bridge.Access.tryFromString('admin');
    if (!admin) return;
    await this.kh.addMember(group.toAgent(), doc.toMembered(), admin, []);
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
      console.warn(`[kh] assignGroupAsAdmin: user-group ${groupId.slice(0, 8)} not loadable`);
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
        const doc = await this.kh.getDocument(summary.doc.doc_id);
        if (doc) await this.addGroupAsAdmin(doc, group);
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
    if (members.some((m: any) => bytesEqual(m.who.id.toBytes(), targetBytes))) {
      return true; // already a member
    }
    const id = new this.bridge.Identifier(targetBytes);
    const agent = await this.kh.getAgent(id);
    if (!agent) throw new Error('Device agent not found (contact card not yet synced)');
    const access = this.bridge.Access.tryFromString('admin');
    if (!access) throw new Error('Invalid access');
    await this.kh.addMember(agent, group.toMembered(), access, []);
    await this.fx.persist();
    this.fx.syncKeyhive();
    return true;
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
    const me = await this.kh.individual;
    const myBytes = me.id.toBytes();
    const peerBytes = base64ToBytes(peerAgentIdB64);
    const members = await group.members();
    const isMember = (b: Uint8Array) => members.some((m: any) => bytesEqual(m.who.id.toBytes(), b));
    return isMember(myBytes) && isMember(peerBytes);
  }

  async removeDeviceFromGroup(deviceAgentIdB64: string): Promise<void> {
    const group = await this.getUserGroup();
    if (!group) return;
    const targetBytes = base64ToBytes(deviceAgentIdB64);
    const members = await group.members();
    const found = members.find((m: any) => bytesEqual(m.who.id.toBytes(), targetBytes));
    if (!found) return;
    await this.kh.revokeMember(found.who, true, group.toMembered());
    await this.fx.persist();
    this.fx.syncKeyhive();
  }

  /**
   * Change a device's access level within the personal user-group: revoke + re-add
   * with a new Access, the same idiom as the doc-level changeRole but targeting
   * group.toMembered(). Admin-only. forceResyncAllPeers so the affected device
   * learns its new access. NOTE: the founding device's root delegation is permanent
   * in keyhive, so demoting the device that created the group (including the current
   * device when it is the founder) does not actually reduce its access.
   */
  async changeDeviceRole(deviceAgentIdB64: string, newRole: string): Promise<void> {
    const group = await this.getUserGroup();
    if (!group) throw new Error('User group not available');
    const targetBytes = base64ToBytes(deviceAgentIdB64);
    const members = await group.members();
    const found = members.find((m: any) => bytesEqual(m.who.id.toBytes(), targetBytes));
    if (!found) throw new Error('Device not found in group');
    const access = this.bridge.Access.tryFromString(newRole);
    if (!access) throw new Error(`Invalid role: ${newRole}`);
    // Reuse the resolved member handle for both revoke and re-add, exactly like the
    // doc-level changeRole. A fresh kh.getAgent(Identifier) lookup throws "Identifier
    // not found" for devices whose Individual isn't globally retrievable (the current
    // device, rendezvous-linked devices) — and it would run only after revokeMember
    // already applied, leaving the change half-done.
    await this.kh.revokeMember(found.who, true, group.toMembered());
    await this.kh.addMember(found.who, group.toMembered(), access, []);
    await this.fx.persist();
    this.fx.syncKeyhive();
    this.fx.forceResyncAllPeers();
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
      // Neither side has a group (e.g. paste flow with a legacy peer) — create one.
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
   * List the devices in the personal user-group; [self] if there is no group yet.
   * Roles are normalized to a MemberRole (read/edit/admin) so the UI can drive a
   * controlled role Select and derive admin-ness (see DeviceList). The current
   * device reports its real role when it appears as a member; when it doesn't (it
   * can read as the Active self-agent rather than an Individual member) it founded/
   * administers the group, so we surface it as admin.
   */
  async listGroupDevices(): Promise<{ agentId: string; role: MemberRole; isMe: boolean }[]> {
    const me = await this.kh.individual;
    const myAgentId = bytesToBase64(me.id.toBytes());
    const group = await this.getUserGroup();
    if (!group) {
      return [{ agentId: myAgentId, role: 'admin', isMe: true }];
    }
    const members = await group.members();
    const devices = members
      .filter((m: any) => m.who.isIndividual())
      .map((m: any) => {
        const agentId = bytesToBase64(m.who.id.toBytes());
        return { agentId, role: toMemberRole(m.can.toString()), isMe: agentId === myAgentId };
      });
    if (!devices.some((d: { agentId: string }) => d.agentId === myAgentId)) {
      devices.unshift({ agentId: myAgentId, role: 'admin', isMe: true });
    }
    return devices;
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
   * Approximate by ~120 bytes, and only ever shown as "~N": the existing card is
   * typically an `AddKeyOp` (one share key) from the init-time prekey pool while a
   * real card is a `RotateKeyOp` (old + new), and a 32-byte key renders as a JSON
   * array of decimal numbers. `groupEvents` — the part that used to vary by orders
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
    const json = card.toJson();
    // toJson() may return a parsed object depending on the WASM binding version;
    // ensure we always have a JSON string for URL encoding / postMessage.
    const rawCard = typeof json === 'string' ? json : JSON.stringify(json);

    const bundle: ContactBundle = { __kind: CONTACT_BUNDLE_KIND, card: rawCard };
    const group = await this.getUserGroup();
    if (group) {
      const groupId = bytesToBase64(group.groupId.toBytes());
      bundle.groupId = groupId;
      // The delegation that defines our group (and names us its admin) lives in
      // our *Individual's* membership ops — NOT in the group agent's events — so
      // we gather events for both: the individual (carries the group delegation)
      // and the group (its own membership ops).
      const myId = bytesToBase64((await this.kh.individual).id.toBytes());
      bundle.groupEvents = await this.contactBundleEvents(new Set([myId, groupId]), myId);
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
   * `skipPrekeysFor` drops one agent's prekey ops. Pass our own device id: every
   * `kh.contactCard()` call runs `generate_private_prekey`, which rotates twice
   * and leaves two permanent ops in our prekey history — so this term grew by
   * ~480 B on every single visit to the invite screen, exchange or not, forever.
   * They are also redundant: our current prekey rides in the bundle's `card`,
   * which `receiveContactCard` ingests. Other agents' prekey ops are kept — a
   * receiver adding our *group* to a doc must encrypt to our other devices too.
   */
  private async contactBundleEvents(agentIds: Set<string>, skipPrekeysFor?: string): Promise<string[]> {
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
    // Prekey sources are keyed by agent: our own device, our other devices, and
    // our groups' transitive members. Drop our own (see `skipPrekeysFor` above) —
    // the rest are bounded by who we are rather than by what we have or how often
    // we have opened the invite screen.
    collect(all.agentPrekeySources, all.prekeySources, (id) => id !== skipPrekeysFor);
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

    const card = this.bridge.ContactCard.fromJson(bundle.card);
    const individual = await this.kh.receiveContactCard(card);
    const agentId = bytesToBase64(individual.id.toBytes());
    const me = await this.kh.individual;
    const myId = bytesToBase64(me.id.toBytes());
    const isOwnCard = agentId === myId;

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

  async getDocMembers(khDocId: string): Promise<MemberInfo[]> {
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const members = await this.kh.docMemberCapabilities(docId);
    const me = await this.kh.individual;
    const myAgentStr = me.toAgent().toString();
    const myUserGroupId = await this.fx.getUserGroupId();

    // Expand each group doc-member to its device members. A device is collected
    // whether keyhive represents it as an Individual or as the Active self-agent
    // (the current device reads as Active, not Individual — same reason
    // listGroupDevices unshifts self), so we collect every non-group sub-member.
    // Groups whose ops haven't synced won't resolve — they report no devices.
    // Used both to filter out devices already covered by a group and to report
    // each group's device list/count to the UI.
    const groupDevices = new Map<string, string[]>();
    for (const m of members) {
      if (!m.who.isGroup()) continue;
      const gid = bytesToBase64(m.who.id.toBytes());
      const group = await this.getGroupById(gid);
      if (!group) continue;
      const subMembers = await group.members();
      const ids = new Set<string>();
      for (const gm of subMembers) {
        if (!gm.who.isGroup()) ids.add(bytesToBase64(gm.who.id.toBytes()));
      }
      groupDevices.set(gid, [...ids]);
    }
    const groupedDeviceIds = new Set<string>([...groupDevices.values()].flat());

    return members
      .map((m: any): MemberInfo => {
        const agentId = bytesToBase64(m.who.id.toBytes());
        const isGroup = m.who.isGroup();
        const base = {
          agentId,
          displayId: m.who.toString(),
          role: toMemberRole(m.can.toString()),
          // "Me" is this device or my own user-group (not every group I belong to).
          isMe: m.who.toString() === myAgentStr || (isGroup && agentId === myUserGroupId),
        };
        return isGroup
          ? { ...base, type: 'group', deviceIds: groupDevices.get(agentId) ?? [] }
          : { ...base, type: 'individual' };
      })
      // Hide devices already covered by a present group — the group stands in for them.
      .filter((m: MemberInfo) => !(m.type === 'individual' && groupedDeviceIds.has(m.agentId)));
  }

  async getMyAccess(khDocId: string): Promise<string | null> {
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const id = new this.bridge.Identifier(this.kh.id.bytes);
    const access = await this.kh.accessForDoc(id, docId);
    return access ? access.toString() : null;
  }

  /**
   * This user's access to a doc via their personal user-group (resolves group
   * membership), or null. This is the home page's ownership lens: we check the
   * user-group, not the device, so revoking the group can actually archive a
   * self-created doc — the creating device's root delegation is permanent.
   */
  async getUserGroupAccess(khDocId: string): Promise<string | null> {
    const groupId = await this.fx.getUserGroupId();
    if (!groupId) return null;
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const id = new this.bridge.Identifier(base64ToBytes(groupId));
    const access = await this.kh.accessForDoc(id, docId);
    return access ? access.toString() : null;
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
    const agent = await this.resolveShareAgent(doc, agentIdB64);
    const access = this.bridge.Access.tryFromString(role);
    if (!access) throw new Error(`Invalid role: ${role}`);
    await this.kh.addMember(agent, doc.toMembered(), access, []);
    await this.fx.persist();
    this.fx.syncKeyhive();
    // Trigger automerge-repo to re-sync so the new member receives the doc data.
    // This is safe: the network adapter drops doc messages while keyhiveSynced=false,
    // so keyhive handshake completes first, then encrypted doc data flows.
    this.fx.forceResyncAllPeers();
    return true;
  }

  async revokeMember(agentIdB64: string, docId: string): Promise<true> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found');
    const agent = await this.findAgentByIdBytes(doc, agentIdB64);
    await this.kh.revokeMember(agent, true, doc.toMembered());
    await this.fx.persist();
    this.fx.syncKeyhive();
    // Re-run the share handshake so the revocation (and rotated keys) propagate
    // to connected peers — including the revoked member, so they learn they no
    // longer have access. Without this only the local view updates (see addMember).
    this.fx.forceResyncAllPeers();
    return true;
  }

  async changeRole(agentIdB64: string, docId: string, newRole: string): Promise<true> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found');
    const agent = await this.findAgentByIdBytes(doc, agentIdB64);
    await this.kh.revokeMember(agent, true, doc.toMembered());
    const access = this.bridge.Access.tryFromString(newRole);
    if (!access) throw new Error(`Invalid role: ${newRole}`);
    await this.kh.addMember(agent, doc.toMembered(), access, []);
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
    const ref = new this.bridge.ChangeId(new Uint8Array(32));
    const doc = await this.kh.generateDocument([], ref, []);
    const khDocId = bytesToBase64(doc.id.toBytes());
    this.khDocuments.set(khDocId, doc);
    // The user-group administers every document this user creates.
    await this.assignGroupAsAdmin(doc);
    return { khDocId, docIdBytes: doc.doc_id.toBytes() };
  }

  /**
   * Enable sharing on an automerge document.
   * If docIdBytes is provided, looks up the keyhive doc that already has
   * that doc_id (used when the automerge doc was created with the keyhive
   * doc_id as its ID). Otherwise creates a new keyhive document.
   */
  async enableSharing(automergeDocId: string, existingDocIdBytes?: Uint8Array): Promise<{ khDocId: string; groupId: string }> {
    let doc: any;
    if (existingDocIdBytes) {
      try {
        const docId = new this.bridge.DocumentId(existingDocIdBytes);
        doc = await this.kh.getDocument(docId);
      } catch {
        // Bytes don't correspond to a known keyhive document — fall through
      }
    }
    if (!doc) {
      const ref = new this.bridge.ChangeId(new Uint8Array(32));
      doc = await this.kh.generateDocument([], ref, []);
    }
    const khDocId = bytesToBase64(doc.id.toBytes());
    this.khDocuments.set(khDocId, doc);
    this.fx.registerDoc(automergeDocId, doc.doc_id);
    // The user-group administers every document this user shares.
    await this.assignGroupAsAdmin(doc);
    await this.fx.persist();
    this.fx.syncKeyhive();
    return { khDocId, groupId: '' };
  }

  registerDocMapping(automergeDocId: string, khDocId: string): void {
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    this.fx.registerDoc(automergeDocId, docId);
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
    const me = await this.kh.individual;
    const myAgentStr = me.toAgent().toString();
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
        members = await this.kh.docMemberCapabilities(summary.doc.doc_id);
      } catch {
        // CGKA state may be incomplete for some docs (e.g. after revoke+re-add) — skip
        continue;
      }
      for (const m of members) {
        if (!m.who.isGroup()) continue;
        if (m.who.toString() === myAgentStr) continue;
        const agentId = bytesToBase64(m.who.id.toBytes());
        if (agentId === myGroupId) continue;
        if (excludeSet.has(agentId)) continue;
        if (seen.has(agentId)) continue;
        seen.set(agentId, {
          agentId,
          displayId: m.who.toString(),
          role: toMemberRole(m.can.toString()),
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
          displayId: group ? group.toAgent().toString() : groupId,
          type: 'group',
          isMe: false,
          deviceIds: [],
        });
      }
    }

    return [...seen.values()];
  }

  /**
   * base64 signatures of the direct delegations granting the user-group access
   * to a doc. A deliberate (re-)share always mints a fresh delegation (addMember
   * has no already-member check), so a signature absent from a recorded set marks
   * a grant issued later — the home page's "un-hide a deleted doc on re-share"
   * signal. Returns [] when there is no group, no doc, or no direct grant, and on
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
        const idBytes: Uint8Array = c.who.id.toBytes();
        if (idBytes.length === targetBytes.length && idBytes.every((b: number, i: number) => b === targetBytes[i])) {
          sigs.push(bytesToBase64(c.proof.signature));
        }
      }
      return sigs;
    } catch (err) {
      console.warn('[kh] getUserGroupGrantSigs failed:', err);
      return [];
    }
  }

  /**
   * Revoke the current user's own access to a document — the keyhive half of
   * the home page "archive" action.
   * Revokes the personal **user-group** (not the device): the group is never the
   * permanent root-creating device, so this actually drops the doc from every
   * device's home view. Even a grant issued by a contact is normally revokable —
   * keyhive's transitive-membership fallback lets a device revoke a delegation to
   * a group it belongs to — but real-world state can still refuse (partial CGKA
   * state, WASM rekey traps), so the outcome is reported instead of swallowed:
   * the caller tombstones the doc either way and keys its message off `status`.
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
        const groupAgent = await this.findAgentByIdBytes(doc, groupId);
        await this.kh.revokeMember(groupAgent, true, doc.toMembered());
        status = 'revoked';
      } catch (err) {
        console.warn('[kh] revokeMyAccess: self-revoke failed:', err);
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
   * Resolve a base64 id to the Agent to add to a document ACL.
   * Sharing is group-only: resolve a user Group (so all of a user's devices get
   * access), or an agent already a member of this document. Anything else is
   * rejected — we no longer share with a bare Individual device.
   */
  private async resolveShareAgent(doc: any, idB64: string): Promise<any> {
    // 1. A user Group (mine or a contact's) — the preferred share target. Resolves
    //    once the contact's group ops have been ingested (see receiveContactCard).
    const group = await this.getGroupById(idB64);
    if (group) return group.toAgent();
    // 2. A group known to our keyhive via global lookup (covers a contact group
    //    whose ops we hold but getGroup can't map). Restricted to groups —
    //    sharing is group-only, so a bare individual is never a valid target.
    try {
      const agent = await this.kh.getAgent(new this.bridge.Identifier(base64ToBytes(idB64)));
      if (agent && agent.isGroup()) return agent;
    } catch {
      // not resolvable globally — fall through
    }
    // 3. Already a member of this document.
    try {
      return await this.findAgentByIdBytes(doc, idB64);
    } catch {
      // not a member and not a group — reject
    }
    throw new Error('Agent not found');
  }

  /** Look up an Agent from docMemberCapabilities by matching Identifier bytes (base64). */
  private async findAgentByIdBytes(doc: any, agentIdB64: string): Promise<any> {
    const targetBytes = base64ToBytes(agentIdB64);
    const members = await this.kh.docMemberCapabilities(doc.doc_id);
    for (const m of members) {
      const memberBytes: Uint8Array = m.who.id.toBytes();
      if (memberBytes.length === targetBytes.length && memberBytes.every((b: number, i: number) => b === targetBytes[i])) {
        return m.who;
      }
    }
    throw new Error('Member not found in document');
  }
}
