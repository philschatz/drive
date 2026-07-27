/**
 * Manual Jest mock for the worker API (src/client/worker-api.ts).
 *
 * The real module marshals every call to a Web Worker running Automerge +
 * keyhive WASM — unavailable under jsdom. This mock backs `subscribeQuery` /
 * `updateDoc` with an in-memory document store projected through the REAL jq
 * engine (src/shared/jq.ts), so editor container components (Tasks, Counters, …)
 * can be driven the same way the Playwright specs drove the live app — but in a
 * fast, single-process Jest test. Everything else is a benign stub.
 *
 * Usage from a test:
 *   jest.mock('../worker-api');
 *   import * as api from '../worker-api';
 *   beforeEach(() => (api as any).__reset());
 *   (api as any).__setDoc('doc1', { '@type': 'TaskList', name: 'X', tasks: {} });
 *
 * `shared/keyhive-api` is a thin re-export of this module, so mocking here also
 * covers useAccess / the Sharing page.
 */
import { compile } from '../../shared/jq';
import { deepAssign as realDeepAssign } from '../../shared/deep-assign';
import type { RichTextOp, RichTextSpan } from '../../shared/rich-text-ops';
import { applyOpsToSpans, flatTextFromSpans, spansFromFlatText } from '../doc-plugins/sentences/spans-model';

type Doc = any;
type QueryCb = (result: any, heads: string[], lastModified?: number, spans?: RichTextSpan[]) => void;
interface QuerySub { docId: string; filter: string; cb: QueryCb; spansPath?: (string | number)[]; }

const docs = new Map<string, Doc>();
const querySubs = new Set<QuerySub>();
// Rich-text spans per docId + path — the mock's stand-in for Automerge's mark/
// block-marker storage, backed by the pure emulation in spans-model.ts. The
// doc object itself only carries the flat text (`￼` per marker), like the
// real JSON projection.
const spansStore = new Map<string, Map<string, RichTextSpan[]>>();

const pathKey = (path: (string | number)[]) => JSON.stringify(path);

function getSpans(docId: string, path: (string | number)[]): RichTextSpan[] {
  const stored = spansStore.get(docId)?.get(pathKey(path));
  if (stored) return stored;
  let v: any = docs.get(docId);
  for (const seg of path) v = v?.[seg];
  return spansFromFlatText(typeof v === 'string' ? v : '');
}

function setSpans(docId: string, path: (string | number)[], spans: RichTextSpan[]): void {
  let m = spansStore.get(docId);
  if (!m) { m = new Map(); spansStore.set(docId, m); }
  m.set(pathKey(path), spans);
  // Mirror the flat text into the doc so jq projections stay consistent.
  let doc = docs.get(docId);
  if (!doc) { doc = {}; docs.set(docId, doc); }
  let parent = doc;
  for (const seg of path.slice(0, -1)) parent = parent[seg] ?? (parent[seg] = {});
  parent[path[path.length - 1]] = flatTextFromSpans(spans);
}

// Presence: subscribable so container tests can inject peers (__setPresence).
const presenceSubs = new Map<string, Set<(peers: Record<string, any>) => void>>();

/** Reset all in-memory state — call in beforeEach. */
export function __reset(): void {
  docs.clear();
  querySubs.clear();
  spansStore.clear();
  presenceSubs.clear();
}
/** Push a presence peer map ({ peerId: { peerId, value } }) to subscribers. */
export function __setPresence(docId: string, peers: Record<string, any>): void {
  for (const cb of presenceSubs.get(docId) ?? []) cb(peers);
}
/** Seed rich-text spans for a Peritext field (and its flat-text mirror). */
export function __setSpans(docId: string, path: (string | number)[], spans: RichTextSpan[]): void {
  setSpans(docId, path, spans);
  __notify(docId);
}
/** Read the current spans (for assertions). */
export function __getSpans(docId: string, path: (string | number)[]): RichTextSpan[] {
  return getSpans(docId, path);
}
/** Seed (or replace) a document and notify its subscribers. */
export function __setDoc(docId: string, doc: Doc): void {
  docs.set(docId, doc);
  __notify(docId);
}
/** Read the current in-memory document (for assertions). */
export function __getDoc(docId: string): Doc {
  return docs.get(docId);
}

function project(filter: string, doc: Doc): any {
  try {
    // Project against a fresh clone so every result has new object references —
    // the real worker returns an immutable snapshot per change, so consumers
    // that bail on `Object.is(prev, next)` (setState) re-render. Mutating in
    // place and projecting the live doc would return the same refs and stall.
    const snapshot = doc == null ? {} : JSON.parse(JSON.stringify(doc));
    return compile(filter)(snapshot)[0] ?? null;
  } catch {
    return null;
  }
}
function deliver(s: QuerySub): void {
  s.cb(
    project(s.filter, docs.get(s.docId)), ['h'], undefined,
    s.spansPath ? getSpans(s.docId, s.spansPath) : undefined,
  );
}
function __notify(docId: string): void {
  for (const s of querySubs) {
    if (s.docId === docId) deliver(s);
  }
}

// --- The functions the editor containers actually exercise ------------------

export const deepAssign = realDeepAssign;

/** Worker-substituted rich-text bridge (see the real worker-api). The mock
 * swaps it per-call in updateDoc for an emulation bound to that docId. */
export const richText: (d: any, path: (string | number)[], ops: RichTextOp[]) => void =
  () => { throw new Error('richText must be passed as an updateDoc argument'); };

export function subscribeQuery(
  docId: string,
  filter: string,
  cb: QueryCb,
  _onError?: (error: string) => void,
  opts?: { peek?: boolean; meta?: boolean; spansPath?: (string | number)[] },
): () => void {
  const sub: QuerySub = { docId, filter, cb, spansPath: opts?.spansPath };
  querySubs.add(sub);
  deliver(sub); // deliver current state immediately
  return () => { querySubs.delete(sub); };
}

export function updateDoc(
  docId: string,
  fn: (d: Doc, ...args: any[]) => void,
  ...args: any[]
): Promise<void> {
  let doc = docs.get(docId);
  if (!doc) { doc = {}; docs.set(docId, doc); }
  // deepAssign is passed by identity and works on plain objects as-is; richText
  // is substituted with the docId-bound spans emulation (like the worker does).
  const bound = args.map(a => a === richText
    ? (_d: Doc, path: (string | number)[], ops: RichTextOp[]) =>
        setSpans(docId, path, applyOpsToSpans(getSpans(docId, path), ops))
    : a);
  fn(doc, ...bound);
  __notify(docId);
  return Promise.resolve();
}

// --- Benign stubs for the rest of the surface ------------------------------
// Async getters resolve empty; on*/subscribe* return a no-op unsubscribe;
// use* hooks return stable constants; access resolves to 'admin' so canEdit.

const noop = (): void => {};
const unsub = (): (() => void) => noop;

export const workerReady = Promise.resolve();
export const keyhiveReady = Promise.resolve();
export const HOME_SUMMARY_QUERY = '.';

export function openDoc(): Promise<void> { return Promise.resolve(); }
export function queryDoc(docId: string, filter: string): Promise<any> {
  return Promise.resolve(project(filter, docs.get(docId)));
}
export function createDoc(): Promise<{ docId: string }> { return Promise.resolve({ docId: 'doc-mock' }); }
export function archiveDoc(): Promise<{ status: string }> { return Promise.resolve({ status: 'ok' }); }

export function getDocHistory(): Promise<Array<{ version: number; time: number }>> { return Promise.resolve([]); }
export function setDocVersion(): void {}
export function restoreDocToVersion(): Promise<void> { return Promise.resolve(); }
export function restoreDocToHeads(): Promise<void> { return Promise.resolve(); }
export function debugGetVersionPatches(): Promise<any[]> { return Promise.resolve([]); }

export function subscribeValidation(_docId: string, cb: (e: any[]) => void): () => void {
  cb([]);
  return noop;
}

export function subscribePresence(docId: string, cb: (peers: Record<string, any>) => void): () => void {
  let subs = presenceSubs.get(docId);
  if (!subs) { subs = new Set(); presenceSubs.set(docId, subs); }
  subs.add(cb);
  return () => { subs!.delete(cb); };
}
export function setPresence(): void {}

// Automerge text cursors, emulated as index-encoding strings ('c:<n>'). Real
// cursors are opaque and shift with edits; mock docs are static per test.
export function getTextCursors(_docId: string, _path: (string | number)[], positions: number[]): Promise<string[]> {
  return Promise.resolve(positions.map(p => 'c:' + p));
}
export function getTextCursorPositions(_docId: string, _path: (string | number)[], cursors: string[]): Promise<(number | null)[]> {
  return Promise.resolve(cursors.map(c => (c.startsWith('c:') ? Number(c.slice(2)) : null)));
}
export function setPresenceTiming(): Promise<void> { return Promise.resolve(); }

export function getWorkerPeerId(): string { return 'peer-mock'; }
export function getWorkerUserGroupId(): string | null { return null; }
export function getWorkerError(): string | null { return null; }
export function onWorkerError(): () => void { return noop; }
export function onKeyhiveStateChanged(): () => void { return noop; }

export function getMyAccess(): Promise<string | null> { return Promise.resolve('admin'); }
export function getDocMembers(): Promise<{ members: any[] }> { return Promise.resolve({ members: [] }); }
export function getKnownContacts(): Promise<any[]> { return Promise.resolve([]); }
export function getMyAccessLevel(): Promise<string | null> { return Promise.resolve('admin'); }

export function usePeerTransports(): Record<string, any> { return {}; }
export function onP2pStatus(): () => void { return noop; }
export function getPeerTransport(): any { return { transport: 'relay' }; }
export function getDirectPeers(): string[] { return []; }
export function getConnectedPeers(): string[] { return []; }
export function usePeerList(): string[] { return []; }
export function useConnectionStatus(): boolean { return true; }
export function useWsStatus(): boolean { return true; }
export function whenWsConnected(): Promise<void> { return Promise.resolve(); }

export function getDocList(): Promise<any[]> { return Promise.resolve([]); }
export function fetchDocList(): Promise<any[]> { return Promise.resolve([]); }
export function onDocListUpdated(): () => void { return noop; }
export function onUnseenChangesUpdated(): () => void { return noop; }
export function getUnseenChanges(): Record<string, boolean> { return {}; }
export function onDeviceNamesUpdated(): () => void { return noop; }
export function onContactNamesUpdated(): () => void { return noop; }

export function getIdentity(): Promise<any> { return Promise.resolve({ agentId: 'peer-mock' }); }
export function getContactCard(): Promise<string> { return Promise.resolve(''); }
export function receiveContactCard(): Promise<any> { return Promise.resolve({}); }
export function getSettingsMode(): Promise<any> { return Promise.resolve({ mode: 'local', hasUserGroup: false }); }
export function enableSettingsSync(): Promise<void> { return Promise.resolve(); }
export function getReachableSettingsDoc(): Promise<string | null> { return Promise.resolve(null); }
export function setDebugEnabled(): Promise<void> { return Promise.resolve(); }
export function clearAllCaches(): Promise<void> { return Promise.resolve(); }
export function deleteAllData(): Promise<void> { return Promise.resolve(); }

export function ensureUserGroup(): Promise<{ userGroupId: string | null }> { return Promise.resolve({ userGroupId: null }); }
export function linkDevice(): Promise<any> { return Promise.resolve({ userGroupId: null, linked: false }); }
export function getLinkPayload(): Promise<any> { return Promise.resolve({}); }
export function listDevices(): Promise<any[]> { return Promise.resolve([]); }
export function removeDevice(): Promise<void> { return Promise.resolve(); }
export function changeDeviceRole(): Promise<void> { return Promise.resolve(); }
export function addMember(): Promise<any> { return Promise.resolve({}); }
export function revokeMember(): Promise<any> { return Promise.resolve({}); }
export function changeRole(): Promise<any> { return Promise.resolve({}); }

export function rendezvousCreateShare(): Promise<any> { return Promise.resolve({ rendezvousId: '', key: '', payloadBytes: 0 }); }
export function rendezvousReceive(): Promise<any> { return Promise.resolve({}); }
export function rendezvousCreateDeviceLink(): Promise<any> { return Promise.resolve({ rendezvousId: '', key: '', payloadBytes: 0 }); }
export function rendezvousJoinDeviceLink(): Promise<{ ok: boolean }> { return Promise.resolve({ ok: false }); }
export function rendezvousCancel(): void {}
export function onRendezvousEvent(): () => void { return noop; }

export function sendHfPort(): void {}
