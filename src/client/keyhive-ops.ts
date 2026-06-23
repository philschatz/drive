import { Keyhive } from "@keyhive/keyhive/slim";

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

export interface MemberInfo {
  agentId: string;
  displayId: string;
  role: string;
  isIndividual: boolean;
  isGroup: boolean;
  isMe: boolean;
  /** For an individual contact, the base64 id of their user Group (share target), if known. */
  groupId?: string;
  /** This individual device is also a member of a group that has access to the doc (redundant — hidden in the UI). */
  inGroup?: boolean;
}

export class KeyhiveOps {
  kh: Keyhive; // Keyhive instance
  bridge: KeyhiveBridge;
  khDocuments = new Map<string, any>();
  inviteAccessOverrides = new Map<string, string>();
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
    if (!group) return;
    await this.addGroupAsAdmin(doc, group);
    await this.fx.persist();
    this.fx.syncKeyhive();
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
   * Link another device into the same user-group, given the peer's device agentId and
   * (optionally) the group id carried over the trusted QR channel.
   * Converges both devices onto one group, then adds the peer if we are the group admin
   * (the non-admin side fails silently and is added by the admin's reciprocal call).
   */
  async linkDevice(peerAgentIdB64: string, peerGroupId?: string | null): Promise<{ userGroupId: string | null }> {
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
    return { userGroupId: myGroupId };
  }

  /** List the devices in the personal user-group; [self] if there is no group yet. */
  async listGroupDevices(): Promise<{ agentId: string; role: string; isMe: boolean }[]> {
    const me = await this.kh.individual;
    const myAgentId = bytesToBase64(me.id.toBytes());
    const group = await this.getUserGroup();
    if (!group) {
      return [{ agentId: myAgentId, role: 'owner', isMe: true }];
    }
    const members = await group.members();
    const devices = members
      .filter((m: any) => m.who.isIndividual())
      .map((m: any) => {
        const agentId = bytesToBase64(m.who.id.toBytes());
        return { agentId, role: agentId === myAgentId ? 'owner' : m.can.toString(), isMe: agentId === myAgentId };
      });
    if (!devices.some((d: { agentId: string }) => d.agentId === myAgentId)) {
      devices.unshift({ agentId: myAgentId, role: 'owner', isMe: true });
    }
    return devices;
  }

  async getContactCard(): Promise<string> {
    const card = await this.kh.contactCard();
    const json = card.toJson();
    // toJson() may return a parsed object depending on the WASM binding version;
    // ensure we always return a JSON string for URL encoding / postMessage.
    return typeof json === 'string' ? json : JSON.stringify(json);
  }

  async receiveContactCard(cardJson: string): Promise<{ agentId: string; isOwnCard: boolean }> {
    const card = this.bridge.ContactCard.fromJson(cardJson);
    const individual = await this.kh.receiveContactCard(card);
    const agentId = bytesToBase64(individual.id.toBytes());
    const me = await this.kh.individual;
    const myId = bytesToBase64(me.id.toBytes());
    const isOwnCard = agentId === myId;
    if (!isOwnCard) {
      await this.fx.persist();
    }
    return { agentId, isOwnCard };
  }

  async getDocMembers(khDocId: string): Promise<MemberInfo[]> {
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const members = await this.kh.docMemberCapabilities(docId);
    const me = await this.kh.individual;
    const myAgentStr = me.toAgent().toString();
    const myUserGroupId = await this.fx.getUserGroupId();

    // Devices already covered by a group that has access to this doc are
    // redundant; flag them so the UI can hide them. Expand each group member to
    // its device members. A device is collected whether keyhive represents it as
    // an Individual or as the Active self-agent (the current device reads as
    // Active, not Individual — same reason listGroupDevices unshifts self), so we
    // collect every non-group sub-member. Groups whose ops haven't synced won't
    // resolve — their devices simply aren't hidden.
    const groupedDeviceIds = new Set<string>();
    for (const m of members) {
      if (!m.who.isGroup()) continue;
      const group = await this.getGroupById(bytesToBase64(m.who.id.toBytes()));
      if (!group) continue;
      const subMembers = await group.members();
      for (const gm of subMembers) {
        if (!gm.who.isGroup()) groupedDeviceIds.add(bytesToBase64(gm.who.id.toBytes()));
      }
    }

    return members.map((m: any) => {
      const agentId = bytesToBase64(m.who.id.toBytes());
      const isGroup = m.who.isGroup();
      return {
        agentId,
        displayId: m.who.toString(),
        role: m.can.toString(),
        isIndividual: m.who.isIndividual(),
        isGroup,
        // "Me" is this device or my own user-group (not every group I belong to).
        isMe: m.who.toString() === myAgentStr || (isGroup && agentId === myUserGroupId),
        // Hide any non-group member (device) already covered by a present group.
        inGroup: !isGroup && groupedDeviceIds.has(agentId),
      };
    });
  }

  async getMyAccess(khDocId: string): Promise<string | null> {
    const override = this.inviteAccessOverrides.get(khDocId);
    if (override) return override;
    const docId = new this.bridge.DocumentId(base64ToBytes(khDocId));
    const id = new this.bridge.Identifier(this.kh.id.bytes);
    const access = await this.kh.accessForDoc(id, docId);
    return access ? access.toString() : null;
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

  async generateInvite(
    docId: string,
    role: string,
  ): Promise<{ inviteKeyBytes: number[]; groupId: string; inviteSignerAgentId: string; inviterAgentIdBytes: number[] }> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found. Re-enable sharing.');
    // Sharing a document ensures the user-group exists and administers the doc.
    await this.assignGroupAsAdmin(doc);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = this.bridge.Signer.memorySignerFromBytes(seed);
    const store = this.bridge.CiphertextStore.newInMemory();
    const tempKh = await this.bridge.Keyhive.init(inviteSigner, store, () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await this.kh.receiveContactCard(inviteCard);
    // Ingest the temp keyhive's archive so its events (prekeys, identity ops)
    // are part of our keyhive and get synced to other peers.
    const tempArchive = await tempKh.toArchive();
    await this.kh.ingestArchive(tempArchive);
    const inviteSignerAgentId = bytesToBase64(inviteIndividual.id.toBytes());
    const inviteAgent = inviteIndividual.toAgent();
    const access = this.bridge.Access.tryFromString(role);
    if (!access) throw new Error(`Invalid role: ${role}`);
    await this.kh.addMember(inviteAgent, doc.toMembered(), access, []);
    await this.fx.persist();
    this.fx.syncKeyhive();
    const me = await this.kh.individual;
    const inviterAgentIdBytes = Array.from(me.id.toBytes()) as number[];
    return { inviteKeyBytes: Array.from(seed) as number[], groupId: '', inviteSignerAgentId, inviterAgentIdBytes };
  }

  /** Claim an invite using an already-initialized invite keyhive (from relay sync). */
  async claimInviteWithKeyhive(
    inviteKh: any,
    automergeDocId?: string,
  ): Promise<{ khDocId: string }> {
    const ourCard = await this.kh.contactCard();
    const ourIndividualInInviteKh = await inviteKh.receiveContactCard(ourCard);
    const ourAgentInInviteKh = ourIndividualInInviteKh.toAgent();
    const reachable = await inviteKh.reachableDocs();
    if (reachable.length === 0) throw new Error('Invite has no document access');
    const docSummaryItem = reachable[0];
    const inviteDoc = docSummaryItem.doc;
    const inviteAccess = docSummaryItem.access;
    const inviteAccessStr = inviteAccess.toString();
    await inviteKh.addMember(ourAgentInInviteKh, inviteDoc.toMembered(), inviteAccess, []);

    // Ingest CGKA events from inviteKh. When our keyhive processes the
    // CGKA Add op for us, receive_cgka_op detects active_id == added_id and
    // calls merge_cgka_invite_op, which properly sets CGKA owner_id and
    // includes our secret prekey in owner_sks.
    const eventsForUs: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(ourAgentInInviteKh);
    const eventsArr: Uint8Array[] = [];
    eventsForUs.forEach((v: Uint8Array) => eventsArr.push(v));

    // Ingest the invite archive into our existing keyhive.
    const inviteArchiveOut = await inviteKh.toArchive();
    await this.kh.ingestArchive(inviteArchiveOut);
    await this.kh.ingestEventsBytes(eventsArr);

    // Persist claim events individually so ingestKeyhiveFromStorage can
    // re-process them later once predecessors arrive from peer sync.
    // Without this, CGKA membership ops that go to "pending" (missing
    // predecessors) are lost — they only exist in WASM memory, never reach
    // the events store, and can never be served to the inviter.
    for (const eventBytes of eventsArr) {
      await this.fx.saveEventBytes(eventBytes);
    }

    const khDocId = bytesToBase64(inviteDoc.id.toBytes());
    this.inviteAccessOverrides.set(khDocId, inviteAccessStr);
    const docFromOurKh = await this.kh.getDocument(inviteDoc.doc_id);
    if (docFromOurKh) {
      this.khDocuments.set(khDocId, docFromOurKh);
    }

    // Revoke the temporary invite identity now that we have the full
    // delegation chain in our main keyhive. This rotates the key.
    // Note: the claimer can't revoke the temp invite member (insufficient authority).
    // The inviter auto-revokes it when detecting the claim via revokeClaimedInviteMembers().
    if (automergeDocId) {
      this.fx.registerDoc(automergeDocId, inviteDoc.doc_id);
    }
    await this.fx.persist();
    this.fx.syncKeyhive();
    this.fx.forceResyncAllPeers();
    if (automergeDocId) {
      this.fx.findDoc(automergeDocId);
    }
    return { khDocId };
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

  async getKnownContacts(
    excludeDocId?: string,
    contactGroupIds?: string[],
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
    // group members are surfaced as contacts; individuals (e.g. unrevoked invite
    // temp identities) are skipped.
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
          role: m.can.toString(),
          isIndividual: false,
          isGroup: true,
          isMe: false,
          groupId: agentId,
        });
      }
    }

    // Also include contacts from the friend list who aren't yet members of any
    // document. A stored contact is always a user-group (its id is the group id).
    if (contactGroupIds) {
      for (const groupId of contactGroupIds) {
        if (groupId === myGroupId) continue;
        if (excludeSet.has(groupId)) continue;
        if (seen.has(groupId)) continue;
        const group = await this.getGroupById(groupId);
        seen.set(groupId, {
          agentId: groupId,
          displayId: group ? group.toAgent().toString() : groupId,
          role: '',
          isIndividual: false,
          isGroup: true,
          isMe: false,
          groupId,
        });
      }
    }

    return [...seen.values()];
  }

  /** Self-revoke from a document's ACL. Fetches the doc fresh from keyhive. */
  async leaveDoc(docId: string): Promise<void> {
    const khDocIdObj = new this.bridge.DocumentId(base64ToBytes(docId));
    const doc = await this.kh.getDocument(khDocIdObj);
    if (!doc) return;
    const me = await this.kh.individual;
    const agentId = bytesToBase64(me.id.toBytes());
    const agent = await this.findAgentByIdBytes(doc, agentId);
    await this.kh.revokeMember(agent, true, doc.toMembered());
    await this.fx.persist();
    this.fx.syncKeyhive();
  }

  /**
   * Resolve a base64 id to the Agent to add to a document ACL.
   * Sharing is group-only: resolve a user Group (so all of a user's devices get
   * access), or an agent already a member of this document. Anything else is
   * rejected — we no longer share with a bare Individual device.
   */
  private async resolveShareAgent(doc: any, idB64: string): Promise<any> {
    // 1. A user Group (mine or a contact's) — the only valid share target.
    const group = await this.getGroupById(idB64);
    if (group) return group.toAgent();
    // 2. Already a member of this document.
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
