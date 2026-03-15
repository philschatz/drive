/**
 * Typed API for communicating with the automerge worker.
 * Query is the only read path — the full document is never sent to the browser.
 */

import { workerReady, _worker, registerWorkerMessageHandler } from '../shared/automerge';
import type { PresenceState } from '../shared/presence';
import type { PeerState } from '../shared/automerge';
import type { ValidationError } from './automerge-worker';
import { deepAssign } from '../shared/deep-assign';

// Functions that the worker provides its own copy of. Callers pass the real ref;
// updateDoc detects it by identity and sends a marker the worker substitutes.
const WORKER_FNS = new Map<unknown, string>([[deepAssign, 'deepAssign']]);

// Re-export for convenience
export { workerReady, deepAssign };

// ── jq filter constants ─────────────────────────────────────────────────────

export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then (.tasks | length) else 0 end), rowCount: (if .sheets then ((.sheets | to_entries | .[0].value.rows // {}) | length) else 0 end) }';

// ── Request/Response plumbing ───────────────────────────────────────────────

let idCounter = 0;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

// Subscription callbacks: subId → callback
const subscriptionCallbacks = new Map<number, (result: any, heads: string[], lastModified?: number) => void>();
// Presence callbacks: docId → callback
const presenceCallbacks = new Map<string, (peers: Record<string, PeerState<PresenceState>>) => void>();
// Validation callbacks: docId → callback
const validationCallbacks = new Map<string, (errors: ValidationError[]) => void>();
// Open-doc progress callbacks: request id → callback
const openDocProgressCallbacks = new Map<number, (pct: number, message: string) => void>();

let subIdCounter = 0;

// Register our handler with the worker message router in automerge.ts
registerWorkerMessageHandler((msg) => handleWorkerApiMessage(msg));

/** Routes worker messages for the worker-api (sub-result, result, presence-update). */
function handleWorkerApiMessage(msg: any): boolean {
  if (msg.type === 'sub-result') {
    const cb = subscriptionCallbacks.get(msg.subId);
    if (cb) {
      if (msg.error) console.warn('[worker-api] sub-result error subId=%d:', msg.subId, msg.error);
      else cb(msg.result, msg.heads, msg.lastModified);
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
  if (msg.type === 'open-doc-progress') {
    const cb = openDocProgressCallbacks.get(msg.id);
    if (cb) cb(msg.pct, msg.message);
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

export function createDoc(initialJson: any, secure = true): Promise<{ docId: string; khDocId?: string }> {
  return request<{ docId: string; khDocId?: string }>('create-doc', { initialJson, secure });
}

/**
 * Explicitly open/load a document, reporting progress as it loads.
 * Resolves once the document data is available in the worker.
 */
export function openDoc(
  docId: string,
  opts?: { secure?: boolean; onProgress?: (pct: number, message: string) => void },
): Promise<{ docId: string }> {
  const { secure, onProgress } = opts ?? {};
  return workerReady.then(() => {
    const id = ++idCounter;
    if (onProgress) openDocProgressCallbacks.set(id, onProgress);
    return new Promise<{ docId: string }>((resolve, reject) => {
      pendingRequests.set(id, {
        resolve: (v) => { openDocProgressCallbacks.delete(id); resolve(v); },
        reject: (e) => { openDocProgressCallbacks.delete(id); reject(e); },
      });
      _worker().postMessage({ type: 'open-doc', id, docId, secure });
    });
  });
}

/**
 * Apply a mutation to a document in the worker.
 * The function body is serialized and reconstructed in the worker via new Function().
 * All closed-over variables must be passed as extra arguments matching the callback params.
 * Worker-provided functions (like `deepAssign`) are detected and substituted automatically.
 *
 * @example
 * updateDoc(docId, (d, uid, data) => { d.events[uid] = data; }, uid, data);
 * updateDoc(docId, (d, deepAssign, uid, patch) => { deepAssign(d.events[uid], patch); }, deepAssign, uid, patch);
 * updateDoc(docId, (d, uid) => { delete d.tasks[uid]; }, uid);
 */
export function updateDoc(
  docId: string,
  fn: (d: any, ...args: any[]) => void,
  ...args: unknown[]
): Promise<void> {
  const serializedArgs = args.map(a =>
    WORKER_FNS.has(a) ? { __workerFn__: WORKER_FNS.get(a)! } : a
  );
  return request('update-doc', { docId, fnSource: fn.toString(), args: serializedArgs });
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
  onResult: (result: any, heads: string[], lastModified?: number) => void,
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

export function debugGetVersionPatches(docId: string, version: number): Promise<any[]> {
  return request('debug-get-version-patches', { docId, version });
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
