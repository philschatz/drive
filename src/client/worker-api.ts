/**
 * Typed API for communicating with the automerge worker.
 * Query is the only read path — the full document is never sent to the browser.
 */

import { workerReady, _worker, registerWorkerMessageHandler } from '../shared/automerge';
import type { PresenceState } from '../shared/presence';
import type { PeerState } from '../shared/automerge';
import type { ValidationError } from './automerge-worker';

// Re-export for convenience
export { workerReady };

// ── jq filter constants ─────────────────────────────────────────────────────

export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then (.tasks | length) else 0 end), rowCount: (if .sheets then ((.sheets | to_entries | .[0].value.rows // {}) | length) else 0 end) }';

// ── Request/Response plumbing ───────────────────────────────────────────────

let idCounter = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

// Subscription callbacks: subId → callback
const subscriptionCallbacks = new Map<number, (result: any, heads: string[]) => void>();
// Presence callbacks: docId → callback
const presenceCallbacks = new Map<string, (peers: Record<string, PeerState<PresenceState>>) => void>();
// Validation callbacks: docId → callback
const validationCallbacks = new Map<string, (errors: ValidationError[]) => void>();

let subIdCounter = 0;

// Register our handler with the worker message router in automerge.ts
registerWorkerMessageHandler((msg) => handleWorkerApiMessage(msg));

/** Routes worker messages for the worker-api (sub-result, result, presence-update). */
function handleWorkerApiMessage(msg: any): boolean {
  if (msg.type === 'sub-result') {
    const cb = subscriptionCallbacks.get(msg.subId);
    if (cb) {
      if (msg.error) console.warn('[worker-api] sub-result error subId=%d:', msg.subId, msg.error);
      else cb(msg.result, msg.heads);
    }
    return true;
  }
  if (msg.type === 'result') {
    const p = pendingRequests.get(msg.id);
    if (p) {
      pendingRequests.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
    return true;
  }
  if (msg.type === 'presence-update') {
    const cb = presenceCallbacks.get(msg.docId);
    if (cb) cb(msg.peers);
    return true;
  }
  if (msg.type === 'validation-result') {
    const cb = validationCallbacks.get(msg.docId);
    if (cb) cb(msg.errors);
    return true;
  }
  return false;
}

function request<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return workerReady.then(() => {
    const id = ++idCounter;
    return new Promise<T>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      _worker().postMessage({ type, id, ...payload });
    });
  });
}

function fire(type: string, payload: Record<string, any> = {}): void {
  workerReady.then(() => _worker().postMessage({ type, ...payload }));
}

// ── Document mutations ──────────────────────────────────────────────────────

export function createDoc(initialJson: any): Promise<{ docId: string; khDocId: string }> {
  return request<{ docId: string; khDocId: string }>('create-doc', { initialJson });
}

/**
 * Apply a mutation to a document in the worker.
 * The function body is serialized and reconstructed in the worker via new Function().
 * All closed-over variables must be listed explicitly in `args`.
 * `deepAssign` is always available in the worker scope without listing it in args.
 *
 * @example
 * updateDoc(docId, (d) => { d.events[uid] = data; }, { uid, data });
 * updateDoc(docId, (d) => { deepAssign(d.events[uid], patch); }, { uid, patch });
 * updateDoc(docId, (d) => { delete d.tasks[uid]; }, { uid });
 */
export function updateDoc(
  docId: string,
  fn: (d: any) => void,
  args: Record<string, unknown> = {},
): Promise<void> {
  return request('update-doc', { docId, fnSource: fn.toString(), args });
}

// ── Query subscriptions ─────────────────────────────────────────────────────

/**
 * Subscribe to live jq query results for a document.
 * The callback is called immediately with the current result, then on every change.
 * Returns a cleanup function.
 */
export function subscribeQuery(
  docId: string,
  filter: string,
  onResult: (result: any, heads: string[]) => void,
): () => void {
  const subId = ++subIdCounter;
  subscriptionCallbacks.set(subId, onResult);
  fire('subscribe-query', { subId, docId, filter });
  return () => {
    subscriptionCallbacks.delete(subId);
    fire('unsubscribe-query', { subId });
  };
}

// ── Validation subscriptions ─────────────────────────────────────────────────

export type { ValidationError };

/**
 * Subscribe to validation results for a document.
 * The callback receives the first 100 errors (or empty array) on each doc change.
 * Returns a cleanup function.
 */
export function subscribeValidation(
  docId: string,
  onResult: (errors: ValidationError[]) => void,
): () => void {
  validationCallbacks.set(docId, onResult);
  fire('validate-subscribe', { docId });
  return () => {
    validationCallbacks.delete(docId);
    fire('validate-unsubscribe', { docId });
  };
}

/**
 * One-shot jq query against the live document.
 */
export function queryDoc(
  docId: string,
  filter: string,
): Promise<{ result: any; heads: string[] }> {
  return workerReady.then(() => {
    const id = ++idCounter;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      _worker().postMessage({ type: 'query', id, docId, filter });
    });
  });
}

// ── History & undo ──────────────────────────────────────────────────────────

export function getDocHistory(docId: string): Promise<Array<{ version: number; time: number }>> {
  return request('get-doc-history', { docId });
}

/**
 * Pin all subscriptions for a document to a historical version.
 * Pass null to resume live view. Worker immediately re-runs all subscriptions.
 */
export function setDocVersion(docId: string, version: number | null): void {
  fire('set-doc-version', { docId, version });
}

export function restoreDocToHeads(docId: string, heads: string[]): Promise<void> {
  return request('restore-doc-to-heads', { docId, heads });
}

/** Restore a document to a specific history version index. Clears pinned version after restore. */
export function restoreDocToVersion(docId: string, version: number): Promise<void> {
  return request('restore-doc-to-version', { docId, version });
}

// ── Presence ────────────────────────────────────────────────────────────────

export function subscribePresence(
  docId: string,
  onUpdate: (peers: Record<string, PeerState<PresenceState>>) => void,
): () => void {
  presenceCallbacks.set(docId, onUpdate);
  fire('presence-subscribe', { docId });
  return () => {
    presenceCallbacks.delete(docId);
    fire('presence-unsubscribe', { docId });
  };
}

export function setPresence(docId: string, state: Partial<PresenceState>): void {
  fire('presence-set', { docId, state });
}
