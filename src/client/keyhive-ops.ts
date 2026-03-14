
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
  Archive: new (bytes: Uint8Array) => any;
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
  kh: any; // Keyhive instance
  bridge: KeyhiveBridge;
  khDocuments = new Map<string, any>();
  inviteAccessOverrides = new Map<string, string>();
  private fx: KeyhiveOpsSideEffects;

  constructor(
    kh: any,
    bridge: KeyhiveBridge,
    sideEffects: KeyhiveOpsSideEffects,
  ) {
    this.kh = kh;
    this.bridge = bridge;
    this.fx = sideEffects;
  }

  getIdentity(): { deviceId: string } {
    return { deviceId: this.kh.idString };
  }

  async getContactCard(): Promise<string> {
    const card = await this.kh.contactCard();
    return card.toJson();
  }

  async receiveContactCard(cardJson: string): Promise<{ agentId: string }> {
    const card = this.bridge.ContactCard.fromJson(cardJson);
    const individual = await this.kh.receiveContactCard(card);
    await this.fx.persist();
    return { agentId: individual.id.toString() };
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
    const agent = await this.findAgentByIdBytes(doc, agentIdB64);
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
  ): Promise<{ inviteKeyBytes: number[]; archiveBytes: number[]; groupId: string; inviteSignerAgentId: string }> {
    const doc = this.khDocuments.get(docId);
    if (!doc) throw new Error('Document not found. Re-enable sharing.');
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const inviteSigner = this.bridge.Signer.memorySignerFromBytes(seed);
    const store = this.bridge.CiphertextStore.newInMemory();
    const tempKh = await this.bridge.Keyhive.init(inviteSigner, store, () => {});
    const inviteCard = await tempKh.contactCard();
    const inviteIndividual = await this.kh.receiveContactCard(inviteCard);
    const inviteSignerAgentId = bytesToBase64(inviteIndividual.id.toBytes());
    const inviteAgent = inviteIndividual.toAgent();
    const access = this.bridge.Access.tryFromString(role);
    if (!access) throw new Error(`Invalid role: ${role}`);
    await this.kh.addMember(inviteAgent, doc.toMembered(), access, []);
    const archive = await this.kh.toArchive();
    const archiveBytes: number[] = Array.from(archive.toBytes());
    await this.fx.persist();
    this.fx.syncKeyhive();
    return { inviteKeyBytes: Array.from(seed) as number[], archiveBytes, groupId: '', inviteSignerAgentId };
  }

  async claimInvite(
    inviteSeed: number[],
    archiveBytes: number[],
    automergeDocId?: string,
  ): Promise<{ khDocId: string }> {
    const seed = new Uint8Array(inviteSeed);
    const inviteSigner = this.bridge.Signer.memorySignerFromBytes(seed);
    const tempStore = this.bridge.CiphertextStore.newInMemory();
    const inviterArchive = new this.bridge.Archive(new Uint8Array(archiveBytes));
    const inviteKh = await inviterArchive.tryToKeyhive(tempStore, inviteSigner, () => {});
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

    // Ingest the invite archive into our existing keyhive. This adds the
    // individuals, delegation chain, and document structure — but NOT CGKA state.
    const inviteArchiveOut = await inviteKh.toArchive();
    await this.kh.ingestArchive(inviteArchiveOut);

    // Ingest CGKA events from inviteKh. When our keyhive processes the
    // CGKA Add op for us, receive_cgka_op detects active_id == added_id and
    // calls merge_cgka_invite_op, which properly sets CGKA owner_id and
    // includes our secret prekey in owner_sks.
    const eventsForUs: Map<Uint8Array, Uint8Array> = await inviteKh.eventsForAgent(ourAgentInInviteKh);
    const eventsArr: Uint8Array[] = [];
    eventsForUs.forEach((v: Uint8Array) => eventsArr.push(v));
    await this.kh.ingestEventsBytes(eventsArr);

    const khDocId = bytesToBase64(inviteDoc.id.toBytes());
    this.inviteAccessOverrides.set(khDocId, inviteAccessStr);
    const docFromOurKh = await this.kh.getDocument(inviteDoc.doc_id);
    if (docFromOurKh) {
      this.khDocuments.set(khDocId, docFromOurKh);
    }
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
