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

export interface KeyhiveOpsSideEffects {
  persist: () => Promise<void>;
  syncKeyhive: () => void;
  registerDoc: (automergeDocId: string, khDocId: any) => void;
  forceResyncAllPeers: () => void;
  findDoc: (docId: string) => void;
}

/** The subset of @keyhive/keyhive/slim that KeyhiveOps needs as constructors/factories. */
export interface KeyhiveBridge {
  ChangeId: new (bytes: Uint8Array) => any;
  DocumentId: new (bytes: Uint8Array) => any;
  Identifier: new (bytes: Uint8Array) => any;
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
}

export class KeyhiveOps {
  kh: Keyhive; // Keyhive instance
  bridge: KeyhiveBridge;
  khDocuments = new Map<string, any>();
  inviteAccessOverrides = new Map<string, string>();
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

  getIdentity(): { deviceId: string } {
    return { deviceId: String(this.kh.idString) };
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
    return members.map((m: any) => ({
      agentId: bytesToBase64(m.who.id.toBytes()),
      displayId: m.who.toString(),
      role: m.can.toString(),
      isIndividual: m.who.isIndividual(),
      isGroup: m.who.isGroup(),
      isMe: m.who.toString() === myAgentStr,
    }));
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
    let agent: any;
    try {
      agent = await this.findAgentByIdBytes(doc, agentIdB64);
    } catch {
      // Agent not yet a member of this doc — try global lookup
      const id = new this.bridge.Identifier(base64ToBytes(agentIdB64));
      const found = await this.kh.getAgent(id);
      if (!found) throw new Error('Agent not found');
      agent = found;
    }
    const access = this.bridge.Access.tryFromString(role);
    if (!access) throw new Error(`Invalid role: ${role}`);
    await this.kh.addMember(agent, doc.toMembered(), access, []);
    await this.fx.persist();
    this.fx.syncKeyhive();
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

  async enableSharing(automergeDocId: string): Promise<{ khDocId: string; groupId: string }> {
    const ref = new this.bridge.ChangeId(new Uint8Array(32));
    const doc = await this.kh.generateDocument([], ref, []);
    const khDocId = bytesToBase64(doc.id.toBytes());
    this.khDocuments.set(khDocId, doc);
    this.fx.registerDoc(automergeDocId, doc.doc_id);
    await this.fx.persist();
    this.fx.syncKeyhive();
    return { khDocId, groupId: '' };
  }

  async generateInvite(
    docId: string,
    role: string,
  ): Promise<{ inviteKeyBytes: number[]; groupId: string; inviteSignerAgentId: string }> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found. Re-enable sharing.');
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
    return { inviteKeyBytes: Array.from(seed) as number[], groupId: '', inviteSignerAgentId };
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

  async getKnownContacts(excludeDocId?: string, contactAgentIds?: string[]): Promise<MemberInfo[]> {
    const me = await this.kh.individual;
    const myAgentStr = me.toAgent().toString();
    const myAgentId = bytesToBase64(me.id.toBytes());
    const seen = new Map<string, MemberInfo>();

    const excludeSet = new Set<string>();
    if (excludeDocId) {
      const excludeMembers = await this.getDocMembers(excludeDocId);
      for (const m of excludeMembers) excludeSet.add(m.agentId);
    }

    const reachable = await this.kh.reachableDocs();
    for (const summary of reachable) {
      const members = await this.kh.docMemberCapabilities(summary.doc.doc_id);
      for (const m of members) {
        if (!m.who.isIndividual()) continue;
        const agentId = bytesToBase64(m.who.id.toBytes());
        if (m.who.toString() === myAgentStr) continue;
        if (excludeSet.has(agentId)) continue;
        if (!seen.has(agentId)) {
          seen.set(agentId, {
            agentId,
            displayId: m.who.toString(),
            role: m.can.toString(),
            isIndividual: true,
            isGroup: false,
            isMe: false,
          });
        }
      }
    }

    // Also include contacts from the friend list who aren't yet members of any document
    if (contactAgentIds) {
      for (const agentId of contactAgentIds) {
        if (agentId === myAgentId) continue;
        if (excludeSet.has(agentId)) continue;
        if (seen.has(agentId)) continue;
        try {
          const id = new this.bridge.Identifier(base64ToBytes(agentId));
          const agent = await this.kh.getAgent(id);
          if (agent && agent.isIndividual()) {
            seen.set(agentId, {
              agentId,
              displayId: agent.toString(),
              role: '',
              isIndividual: true,
              isGroup: false,
              isMe: false,
            });
          }
        } catch {
          // Agent not found in keyhive — skip
        }
      }
    }

    return [...seen.values()];
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
