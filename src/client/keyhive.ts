/**
 * Keyhive integration — identity, encryption, and access control.
 *
 * This module manages:
 * - Device keypair (Ed25519 via keyhive Signer, persisted in IndexedDB via WebCrypto)
 * - Keyhive instance (WASM, persisted as Archive in IndexedDB)
 * - User identity group (keyhive Group containing this device + linked devices)
 * - Per-document encryption/decryption
 * - Membership management (roles: read/write/admin)
 *
 * Runs in the web worker alongside automerge-repo.
 */

import type {
  Keyhive,
  Signer,
  CiphertextStore,
  Archive,
  Group,
  Document as KhDocument,
  Access,
  Agent,
  Membered,
  Event as KhEvent,
  ContactCard,
  Identifier,
  DocumentId as KhDocumentId,
  ChangeRef,
  Encrypted,
  SimpleCapability,
  Summary,
} from '@keyhive/keyhive';

// ── Constants ──────────────────────────────────────────────────────────
const IDB_NAME = 'keyhive-store';
const IDB_STORE = 'kv';
const SIGNER_KEY = 'keyhive-signer';
const ARCHIVE_KEY = 'keyhive-archive';
const USER_GROUP_KEY = 'keyhive-user-group-id';

// ── State ──────────────────────────────────────────────────────────────
let kh: Keyhive | null = null;
let signer: Signer | null = null;
let userGroup: Group | null = null;
let khModule: typeof import('@keyhive/keyhive') | null = null;

// Callback for keyhive events (delegations, revocations, CGKA ops).
// The worker sets this to broadcast membership changes via the auth doc.
let onKeyhiveEvent: ((event: KhEvent) => void) | null = null;

// ── IndexedDB Key-Value Store ─────────────────────────────────────────
// Web Workers don't have localStorage, so we use IndexedDB for persistence.

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Ed25519 Key Management ────────────────────────────────────────────

async function importEd25519Keypair(pkcs8Bytes: Uint8Array): Promise<CryptoKeyPair> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8Bytes.buffer as ArrayBuffer, { name: 'Ed25519' }, true, ['sign'],
  );
  // Derive public key by exporting as JWK and re-importing without 'd'
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  delete jwk.d;
  jwk.key_ops = ['verify'];
  const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['verify']);
  return { privateKey, publicKey };
}

// ── Keyhive Initialization ────────────────────────────────────────────

function handleEvent(event: KhEvent) {
  // Persist keyhive state on every event
  persistArchive();
  // Forward to worker for broadcasting via auth doc
  if (onKeyhiveEvent) onKeyhiveEvent(event);
}

async function persistArchive() {
  if (!kh) return;
  try {
    const archive = kh.toArchive();
    const bytes = archive.toBytes();
    await idbSet(ARCHIVE_KEY, bytesToBase64(bytes));
  } catch (err) {
    console.warn('[keyhive] Failed to persist archive:', err);
  }
}

export async function init(mod: typeof import('@keyhive/keyhive')): Promise<void> {
  khModule = mod;
  mod.setPanicHook();

  // Create or restore signer.
  // generateWebCrypto() requires `window` (unavailable in Workers), so we
  // use SubtleCrypto directly to generate/persist an Ed25519 keypair and
  // pass it to Signer.webCryptoSigner(). Falls back to memory signer if
  // the browser doesn't support Ed25519 in SubtleCrypto.
  const storedKey = await idbGet(SIGNER_KEY);
  try {
    if (storedKey && storedKey.startsWith('webcrypto:')) {
      const raw = base64ToBytes(storedKey.slice('webcrypto:'.length));
      const keypair = await importEd25519Keypair(raw);
      signer = await mod.Signer.webCryptoSigner(keypair);
    } else if (storedKey) {
      // Legacy memory signer key
      signer = mod.Signer.memorySignerFromBytes(base64ToBytes(storedKey));
    } else {
      // Try WebCrypto Ed25519 first
      const keypair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
      signer = await mod.Signer.webCryptoSigner(keypair);
      const raw = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));
      await idbSet(SIGNER_KEY, 'webcrypto:' + bytesToBase64(raw));
    }
  } catch {
    // Ed25519 not supported in SubtleCrypto — fall back to memory signer
    console.warn('[keyhive] Ed25519 SubtleCrypto unavailable, using memory signer');
    signer = mod.Signer.generateMemory();
  }

  // Create ciphertext store (in-memory; encrypted content lives in automerge docs)
  const store = mod.CiphertextStore.newInMemory();

  // Try restoring from archive
  const archived = await idbGet(ARCHIVE_KEY);
  if (archived) {
    try {
      const archive = new mod.Archive(base64ToBytes(archived));
      kh = archive.tryToKeyhive(store, signer, handleEvent);
    } catch (err) {
      console.warn('[keyhive] Failed to restore archive, creating fresh instance:', err);
      kh = await mod.Keyhive.init(signer, store, handleEvent);
    }
  } else {
    kh = await mod.Keyhive.init(signer, store, handleEvent);
  }

  // Create or restore user group
  const groupIdStr = await idbGet(USER_GROUP_KEY);
  if (groupIdStr) {
    try {
      const id = new mod.Identifier(base64ToBytes(groupIdStr));
      userGroup = kh.getGroup(id) || null;
    } catch {
      userGroup = null;
    }
  }
  if (!userGroup) {
    userGroup = await kh.generateGroup([]);
    await idbSet(USER_GROUP_KEY, bytesToBase64(userGroup.id.toBytes()));
    await persistArchive();
  }
}

// ── Public API ─────────────────────────────────────────────────────────

export function setEventHandler(handler: (event: KhEvent) => void) {
  onKeyhiveEvent = handler;
}

export function getKeyhive(): Keyhive {
  if (!kh) throw new Error('Keyhive not initialized');
  return kh;
}

export function getSigner(): Signer {
  if (!signer) throw new Error('Signer not initialized');
  return signer;
}

export function getUserGroup(): Group {
  if (!userGroup) throw new Error('User group not initialized');
  return userGroup;
}

export function getModule(): typeof import('@keyhive/keyhive') {
  if (!khModule) throw new Error('Keyhive module not loaded');
  return khModule;
}

/** Get this device's identity string (hex-encoded public key). */
export function deviceId(): string {
  if (!kh) return '';
  return kh.idString;
}

/** Get the keyhive ID for this device. */
export function deviceIdentifier(): Identifier | null {
  if (!kh) return null;
  return new (getModule().Identifier)(kh.id.bytes);
}

// ── Document Encryption ────────────────────────────────────────────────

/** Create a new keyhive-protected document. Returns the keyhive Document handle. */
export async function createProtectedDoc(initialChangeRef: Uint8Array): Promise<KhDocument> {
  const kh = getKeyhive();
  const mod = getModule();
  const ref = new mod.ChangeRef(initialChangeRef);
  return kh.generateDocument([], ref, []);
}

/** Encrypt content for a document. */
export async function encrypt(
  doc: KhDocument,
  contentRef: Uint8Array,
  predRefs: Uint8Array[],
  content: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; pcsKeyHash: Uint8Array; contentRef: Uint8Array; predRefsBytes: Uint8Array }> {
  const kh = getKeyhive();
  const mod = getModule();
  const ref = new mod.ChangeRef(contentRef);
  const preds = predRefs.map(p => new mod.ChangeRef(p));
  const result = await kh.tryEncrypt(doc, ref, preds, content);
  const encrypted = result.encrypted_content();
  return {
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    pcsKeyHash: encrypted.pcs_key_hash,
    contentRef: encrypted.content_ref,
    predRefsBytes: encrypted.pred_refs,
  };
}

/** Decrypt content from a document. */
export function decrypt(doc: KhDocument, encrypted: Encrypted): Uint8Array {
  const kh = getKeyhive();
  return kh.tryDecrypt(doc, encrypted);
}

// ── Access Control ─────────────────────────────────────────────────────

/** Grant access to a member. */
export async function addMember(
  agent: Agent,
  doc: Membered,
  access: string,
  otherDocs: KhDocument[] = [],
): Promise<void> {
  const kh = getKeyhive();
  const mod = getModule();
  const accessLevel = mod.Access.tryFromString(access);
  if (!accessLevel) throw new Error(`Invalid access level: ${access}`);
  await kh.addMember(agent, doc, accessLevel, otherDocs);
  await persistArchive();
}

/** Revoke a member's access. Triggers key rotation via BeeKEM. */
export async function revokeMember(
  agent: Agent,
  doc: Membered,
  retainOthers = true,
): Promise<void> {
  const kh = getKeyhive();
  await kh.revokeMember(agent, retainOthers, doc);
  await persistArchive();
}

/** Change a member's role (revoke + re-add at new level). */
export async function changeRole(
  agent: Agent,
  doc: Membered,
  newRole: string,
  otherDocs: KhDocument[] = [],
): Promise<void> {
  await revokeMember(agent, doc, true);
  await addMember(agent, doc, newRole, otherDocs);
}

/** Get all members and their roles for a document. */
export function getDocMembers(docId: KhDocumentId): SimpleCapability[] {
  const kh = getKeyhive();
  return kh.docMemberCapabilities(docId);
}

/** Get this device's access level for a document. */
export function getMyAccess(docId: KhDocumentId): string | null {
  const kh = getKeyhive();
  const id = new (getModule().Identifier)(kh.id.bytes);
  const access = kh.accessForDoc(id, docId);
  return access ? access.toString() : null;
}

/** List all documents this device can access. */
export function listAccessibleDocs(): Summary[] {
  const kh = getKeyhive();
  return kh.reachableDocs();
}

// ── Contact Cards (Identity Exchange) ──────────────────────────────────

/** Generate a contact card for this device (for sharing with others). */
export async function generateContactCard(): Promise<string> {
  const kh = getKeyhive();
  const card = await kh.contactCard();
  return card.toJson();
}

/** Receive a contact card from another device/user. */
export async function receiveContactCard(json: string): Promise<Agent> {
  const kh = getKeyhive();
  const mod = getModule();
  const card = mod.ContactCard.fromJson(json);
  const individual = kh.receiveContactCard(card);
  await persistArchive();
  return individual.toAgent();
}

// ── Invite Flow ────────────────────────────────────────────────────────

/**
 * Generate an invite for a document.
 * Creates an ephemeral signer, grants it access, and returns the
 * private key bytes for encoding into a URL fragment.
 */
export async function generateInvite(
  doc: KhDocument,
  role: string,
): Promise<{ inviteKeyBytes: Uint8Array; inviteAgent: Agent }> {
  const mod = getModule();
  const inviteSigner = mod.Signer.generateMemory();
  // Create a temporary keyhive for the invite key to get its contact card
  const store = mod.CiphertextStore.newInMemory();
  const tempKh = await mod.Keyhive.init(inviteSigner, store, () => {});
  const inviteCard = await tempKh.contactCard();

  // Receive the invite's contact card in our main keyhive
  const kh = getKeyhive();
  const inviteIndividual = kh.receiveContactCard(inviteCard);
  const inviteAgent = inviteIndividual.toAgent();

  // Grant the invite key access to the document
  const accessLevel = mod.Access.tryFromString(role);
  if (!accessLevel) throw new Error(`Invalid role: ${role}`);
  await kh.addMember(inviteAgent, doc.toAgent() as any, accessLevel, []);
  await persistArchive();

  return {
    inviteKeyBytes: inviteSigner.verifyingKey, // TODO: need secret key bytes
    inviteAgent,
  };
}

// ── Persistence ────────────────────────────────────────────────────────

export { persistArchive };
