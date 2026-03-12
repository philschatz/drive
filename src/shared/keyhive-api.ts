/**
 * Main-thread API for keyhive operations.
 * Sends messages to the worker and returns promises for responses.
 */

import { keyhiveReady } from './automerge';

// The worker reference — we grab it from automerge.ts's module scope.
// Since this module is imported after automerge.ts sets up the worker,
// we use a lazy getter pattern.
let _worker: Worker | null = null;

function getWorker(): Worker {
  if (!_worker) throw new Error('Keyhive API not initialized. Call initKeyhiveApi(worker) first.');
  return _worker;
}

export function initKeyhiveApi(worker: Worker) {
  _worker = worker;
}

// ── Request/Response plumbing ──────────────────────────────────────────

let idCounter = 0;
const pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>();

export function handleKeyhiveResponse(msg: { type: string; id: number; result?: any; error?: string }) {
  if (msg.type !== 'kh-result') return false;
  const p = pending.get(msg.id);
  if (!p) return true;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
  return true;
}

function request<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return keyhiveReady.then(() => {
    const id = ++idCounter;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ type, id, ...payload });
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────

export interface DeviceInfo {
  agentId: string;
  role: string;
  isMe?: boolean;
}

export interface IdentityInfo {
  deviceId: string;
  devices: DeviceInfo[];
}

export interface MemberInfo {
  agentId: string;
  displayId: string;
  role: string;
  isIndividual: boolean;
  isGroup: boolean;
  isMe: boolean;
}

/** Get this device's identity and linked devices. */
export function getIdentity(): Promise<IdentityInfo> {
  return request('kh-get-identity');
}

/** Generate a contact card (JSON string) for sharing with others. */
export function getContactCard(): Promise<string> {
  return request('kh-get-contact-card');
}

/** Receive a contact card from another device/user. Returns the agent ID. */
export function receiveContactCard(cardJson: string): Promise<{ agentId: string }> {
  return request('kh-receive-contact-card', { cardJson });
}

/** Get all members and roles for a document. Each member has an `isMe` flag. */
export function getDocMembers(khDocId: string): Promise<MemberInfo[]> {
  return request('kh-get-doc-members', { khDocId });
}

/** Get this device's access level for a document. */
export function getMyAccess(khDocId: string): Promise<string | null> {
  return request('kh-get-my-access', { khDocId });
}

/** List all devices linked to this user's identity group. */
export function listDevices(): Promise<DeviceInfo[]> {
  return request('kh-list-devices');
}

/** Add a member to a document with a specific role. */
export function addMember(agentId: string, docId: string, role: string): Promise<void> {
  return request('kh-add-member', { agentId, docId, role });
}

/** Revoke a member from a document (triggers key rotation). */
export function revokeMember(agentId: string, docId: string): Promise<void> {
  return request('kh-revoke-member', { agentId, docId });
}

/** Change a member's role (revoke + re-add, triggers key rotation). */
export function changeRole(agentId: string, docId: string, newRole: string): Promise<void> {
  return request('kh-change-role', { agentId, docId, newRole });
}

/** Generate an invite link for a document. Returns seed bytes + inviter archive for URL encoding. */
export function generateInvite(docId: string, groupId: string, role: string): Promise<{ inviteKeyBytes: number[]; archiveBytes: number[]; groupId: string; inviteSignerAgentId: string }> {
  return request('kh-generate-invite', { docId, groupId, role });
}

/** Claim an invite using the seed bytes and inviter archive from the invite URL. */
export function claimInvite(inviteSeed: number[], archiveBytes: number[], automergeDocId: string): Promise<{ khDocId: string }> {
  return request('kh-claim-invite', { inviteSeed, archiveBytes, automergeDocId });
}

/** Enable sharing on a document by creating a keyhive Document. */
export function enableSharing(automergeDocId: string): Promise<{ khDocId: string; groupId: string }> {
  return request('kh-enable-sharing', { automergeDocId });
}

/** Register a previously-created sharing group so the worker can find it after reload. */
export function registerSharingGroup(khDocId: string, groupId: string): Promise<void> {
  return request('kh-register-sharing-group', { khDocId, groupId });
}

/** Register an automerge→keyhive doc mapping for access enforcement. Fire-and-forget. */
export function registerDocMapping(automergeDocId: string, khDocId: string): void {
  try {
    getWorker().postMessage({ type: 'kh-register-doc-mapping', automergeDocId, khDocId });
  } catch { /* ignore if worker not ready */ }
}
