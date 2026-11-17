/**
 * Manual Jest mock for the worker API (src/client/ui/worker-api.ts).
 *
 * POSITIONAL: Jest finds this file only because `__mocks__/` sits directly
 * beside `worker-api.ts`. If the two ever land at different directory levels,
 * an automatic `jest.mock` of the worker API silently loads the REAL module
 * instead — which top-level-constructs a Worker and dies in jsdom.
 * Tests assert `__isMock` to turn that into a clear failure.
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
 * `common/keyhive-api` is a thin re-export of this module, so mocking here also
 * covers useAccess / the Sharing page.
 */
import { compile } from '../../../shared/jq';
import { deepAssign as realDeepAssign } from '../../../shared/deep-assign';
import type { RichTextOp, RichTextSpan } from '../../../shared/rich-text-ops';
import type { MarkerField } from '../../../shared/worker-protocol';
import type { VersionChange } from '../../../shared/version-changes';
import { applyOpsToSpans, flatTextFromSpans, shiftPositionThroughOps, spansFromFlatText } from '../doc-plugins/sentences/spans-model';

type Doc = any;
type QueryCb = (
  result: any, heads: string[], lastModified?: number,
  spans?: RichTextSpan[], cursors?: Record<string, number | null>,
  richTextFields?: MarkerField[],
) => void;
interface QuerySub {
  docId: string; filter: string; cb: QueryCb;
  spansPath?: (string | number)[];
  allRichText?: boolean;
}

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

// Automerge text cursors, emulated faithfully enough to exercise the real thing:
// a token is an opaque handle whose position SHIFTS as ops are applied (a real
// cursor tracks a character's identity), which is what lets a container test
// inject a remote edit and assert the caret was rebased. `pos: 'end'` mirrors
// getCursor(pos >= length) silently minting a sticky end cursor. The shifting
// itself lives in spans-model.ts and is pinned against real Automerge by
// spans-model.test.ts.
interface MockCursor { key: string; pos: number | 'end' }
const cursors = new Map<string, MockCursor>();
/** Token sets registered via subscribeCursors, keyed docId + path. */
const cursorSubs = new Map<string, string[]>();
let nextCursorId = 0;

const cursorKey = (docId: string, path: (string | number)[]) => docId + '|' + pathKey(path);

// Versions. The engine names every push by the document's heads and can read
// the text as of any of them; a mint that names a version is resolved against
// THAT text (see `text-cursors` in drive-engine.ts). Here a version is a counter
// per document, and a field's history is the ops applied to it — enough to
// answer the one question asked of an older version: which character did this
// index name, and where is it now?
const versions = new Map<string, number>();
/** Per document: the oldest version the op log still reaches back to. */
const logFloor = new Map<string, number>();
interface LoggedOps { after: number; lengthBefore: number; ops: RichTextOp[] }
const opLog = new Map<string, LoggedOps[]>();
const versionOf = (docId: string) => versions.get(docId) ?? 0;
const headsOf = (docId: string) => ['h' + versionOf(docId)];
const bumpVersion = (docId: string) => { const v = versionOf(docId) + 1; versions.set(docId, v); return v; };
/** A wholesale replacement: positions cannot be followed through it. */
function restartHistory(docId: string): void {
  logFloor.set(docId, bumpVersion(docId));
  for (const key of opLog.keys()) if (key.startsWith(docId + '|')) opLog.delete(key);
}
const flatLength = (docId: string, path: (string | number)[]) =>
  flatTextFromSpans(getSpans(docId, path)).length;

function shiftCursors(docId: string, path: (string | number)[], ops: RichTextOp[]): void {
  const key = cursorKey(docId, path);
  for (const [token, c] of cursors) {
    if (c.key !== key || c.pos === 'end') continue; // end cursors resolve to the live length
    const next = shiftPositionThroughOps(c.pos, ops);
    if (next === null) cursors.delete(token); // unresolvable — resolves to null below
    else c.pos = next;
  }
}

/** Apply rich-text ops to a doc's spans, rebasing every cursor into that field. */
function applyOpsToField(docId: string, path: (string | number)[], ops: RichTextOp[]): void {
  const key = cursorKey(docId, path);
  let log = opLog.get(key);
  if (!log) { log = []; opLog.set(key, log); }
  log.push({ after: bumpVersion(docId), lengthBefore: flatLength(docId, path), ops });
  shiftCursors(docId, path, ops);
  setSpans(docId, path, applyOpsToSpans(getSpans(docId, path), ops));
}

function resolveCursors(docId: string, path: (string | number)[]): Record<string, number | null> | undefined {
  const key = cursorKey(docId, path);
  const tokens = cursorSubs.get(key);
  if (!tokens?.length) return undefined;
  const len = flatLength(docId, path);
  const out: Record<string, number | null> = {};
  for (const t of tokens) {
    const c = cursors.get(t);
    if (c && c.key === key) out[t] = c.pos === 'end' ? len : c.pos;
    // Legacy static 'c:<n>' tokens, so tests that hand-write a cursor still work.
    else out[t] = t.startsWith('c:') ? Number(t.slice(2)) : null;
  }
  return out;
}

// Presence: subscribable so container tests can inject peers (__setPresence).
const presenceSubs = new Map<string, Set<(peers: Record<string, any>) => void>>();

/** Marker so a test can prove it got THIS module and not the real worker-api. */
export const __isMock = true;

/** Reset all in-memory state — call in beforeEach. */
export function __reset(): void {
  docs.clear();
  querySubs.clear();
  spansStore.clear();
  presenceSubs.clear();
  cursors.clear();
  cursorSubs.clear();
  versions.clear();
  logFloor.clear();
  opLog.clear();
  heldPushes = null;
  docList = [];
  docListSubs.clear();
  unseenFlags = {};
  unseenSubs.clear();
  histories.clear();
  patches.clear();
  versionChanges.clear();
  pinnedVersion = null;
}
/** Push a presence peer map ({ peerId: { peerId, value } }) to subscribers. */
export function __setPresence(docId: string, peers: Record<string, any>): void {
  for (const cb of presenceSubs.get(docId) ?? []) cb(peers);
}
/** Seed rich-text spans for a Peritext field (and its flat-text mirror). */
export function __setSpans(docId: string, path: (string | number)[], spans: RichTextSpan[]): void {
  setSpans(docId, path, spans);
  restartHistory(docId);
  __notify(docId);
}
/** Read the current spans (for assertions). */
export function __getSpans(docId: string, path: (string | number)[]): RichTextSpan[] {
  return getSpans(docId, path);
}
/** The cursor tokens currently registered for a field (for assertions). */
export function __getCursorSubs(docId: string, path: (string | number)[]): string[] {
  return cursorSubs.get(cursorKey(docId, path)) ?? [];
}
/**
 * Apply ops as if a PEER had made the edit: spans change and every cursor in the
 * field is rebased, then subscribers are notified — but no local write is
 * registered, so the container's in-flight-write deferral does not swallow it.
 * This is how a test drives a concurrent remote edit.
 */
export function __applyRemoteOps(docId: string, path: (string | number)[], ops: RichTextOp[]): void {
  applyOpsToField(docId, path, ops);
  __notify(docId);
}
/** Seed (or replace) a document and notify its subscribers. */
export function __setDoc(docId: string, doc: Doc): void {
  docs.set(docId, doc);
  restartHistory(docId);
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
/**
 * One push to one subscriber, with its payload fixed NOW: like the engine's, it
 * describes the document as it was when the push was made, however much later
 * it is delivered.
 */
function preparePush(s: QuerySub): () => void {
  const result = project(s.filter, docs.get(s.docId));
  const heads = headsOf(s.docId);
  // A FRESH array per delivery, for the same reason `project` clones (above):
  // the engine calls Automerge.spans() anew on every push and posts whenever
  // the resolved cursors changed, so a pure cursor registration re-pushes
  // identical content in a new array and the subscriber re-renders. Handing
  // out the stored array by identity made setState bail on Object.is, so the
  // mock silently lost the mid-edit re-render the real app has.
  const spans = s.spansPath ? getSpans(s.docId, s.spansPath).map(v => ({ ...v })) : undefined;
  const resolved = s.spansPath ? resolveCursors(s.docId, s.spansPath) : undefined;
  const fields = s.allRichText ? allRichTextFields(s.docId) : undefined;
  return () => { if (querySubs.has(s)) s.cb(result, heads, undefined, spans, resolved, fields); };
}

// A worker that is ahead of what it has shown. Pushes are messages: the worker
// can have applied several edits — and answered a request against the newest —
// before the page has handled the push for the first. `__holdPushes` makes that
// state reachable: pushes queue (one entry per notification) instead of being
// delivered, while requests such as getTextCursors still answer from the
// current document.
let heldPushes: Array<() => void> | null = null;
function post(pushes: Array<() => void>): void {
  const run = () => { for (const push of pushes) push(); };
  if (heldPushes) heldPushes.push(run);
  else run();
}
/** Stop delivering pushes; they queue until released. */
export function __holdPushes(): void { heldPushes ??= []; }
/** Deliver the oldest queued push. False when there was none. */
export function __deliverNext(): boolean {
  const next = heldPushes?.shift();
  next?.();
  return !!next;
}
/** Deliver everything queued, in order, and go back to delivering immediately. */
export function __releasePushes(): void {
  const queued = heldPushes ?? [];
  heldPushes = null;
  for (const run of queued) run();
}

/**
 * The mock's stand-in for the engine's whole-document walk: every seeded field
 * that carries markers. The engine discovers these by asking Automerge about
 * each string; here `spansStore` already IS the set of rich-text fields, so the
 * filter is the same ("has a block or a non-empty marks") but the search isn't.
 */
function allRichTextFields(docId: string): MarkerField[] {
  const out: MarkerField[] = [];
  for (const [key, spans] of spansStore.get(docId) ?? []) {
    const rich = spans.some(s =>
      s.type === 'block' || (s.type === 'text' && s.marks && Object.keys(s.marks).length > 0));
    if (rich) out.push({ path: JSON.parse(key), spans: spans.map(v => ({ ...v })) });
  }
  return out;
}
function __notify(docId: string): void {
  post([...querySubs].filter(s => s.docId === docId).map(preparePush));
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
  opts?: { peek?: boolean; meta?: boolean; spansPath?: (string | number)[]; allRichText?: boolean },
): () => void {
  const sub: QuerySub = { docId, filter, cb, spansPath: opts?.spansPath, allRichText: opts?.allRichText };
  querySubs.add(sub);
  post([preparePush(sub)]); // deliver current state immediately
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
    ? (_d: Doc, path: (string | number)[], ops: RichTextOp[]) => applyOpsToField(docId, path, ops)
    : a);
  const before = versionOf(docId);
  fn(doc, ...bound);
  if (versionOf(docId) === before) bumpVersion(docId); // a write that touched no rich text
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
// The real projection verbatim, not '.', because Home reads named fields off the
// result (`type`, `name`, the per-type counts) — and this mock runs the real jq
// engine, so a stand-in would test a shape the worker never sends. Keep in sync
// with worker-api.ts.
export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then [.tasks[] | select(.progress != "completed" and .progress != "cancelled")] | length else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end), recipeCount: (if .recipes then (.recipes | length) else 0 end) }';

export function openDoc(): Promise<void> { return Promise.resolve(); }
/** Same `{ result, heads }` shape as the real one (worker-api.ts). */
export function queryDoc(docId: string, filter: string): Promise<{ result: any; heads: string[] }> {
  return Promise.resolve({ result: project(filter, docs.get(docId)), heads: [] });
}
export function createDoc(): Promise<{ docId: string }> { return Promise.resolve({ docId: 'doc-mock' }); }
export function archiveDoc(): Promise<{ status: string }> { return Promise.resolve({ status: 'ok' }); }
export function exportBackup(): Promise<any> { return Promise.resolve({ format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: new Date().toISOString(), docs: [], settings: {} }); }
export function importBackup(): Promise<any> { return Promise.resolve({ imported: 0, skipped: [], reload: true, skippedFriends: 0 }); }
// Keyhive-format reset: a healthy engine by default (no reset pending, none past).
export function getResetRequired(): null { return null; }
export function useResetRequired(): null { return null; }
export function exportLegacyBackup(): Promise<any> { return Promise.reject(new Error('Nothing to export: this device has no pre-upgrade documents.')); }
export function getPreResetInfo(): Promise<null> { return Promise.resolve(null); }
export function resetKeyhive(): Promise<void> { return Promise.resolve(); }

// Version history + per-version operations. Seedable rather than hard-coded to
// `[]`, so the surfaces built on them (the source inspector's changes sheet) are
// testable at all; unseeded, they still answer "no history", which is what every
// other consumer expects.
const histories = new Map<string, Array<{ version: number; time: number }>>();
const patches = new Map<string, any[]>();
const versionChanges = new Map<string, VersionChange[]>();

/** Seed a document's version list (as `Automerge.getHistory` reports it). */
export function __setHistory(docId: string, entries: Array<{ version: number; time: number }>): void {
  histories.set(docId, entries);
}
/** Seed the patches one version produced (`version - 1` → `version`). */
export function __setPatches(docId: string, version: number, list: any[]): void {
  patches.set(docId + '@' + version, list);
}
let pinnedVersion: number | null = null;
/** The version the view has pinned, or null for the live latest (for assertions). */
export function __getPinnedVersion(): number | null { return pinnedVersion; }

export function getDocHistory(docId: string): Promise<Array<{ version: number; time: number }>> {
  return Promise.resolve(histories.get(docId) ?? []);
}
export function setDocVersion(_docId: string, version: number | null): void { pinnedVersion = version; }
export function restoreDocToVersion(): Promise<void> { return Promise.resolve(); }
export function restoreDocToHeads(): Promise<void> { return Promise.resolve(); }
export function debugGetVersionPatches(docId: string, version: number): Promise<any[]> {
  return Promise.resolve(patches.get(docId + '@' + version) ?? []);
}
/** Seed what one version changed (as `get-version-changes` would describe it). */
export function __setVersionChanges(docId: string, version: number, changes: VersionChange[]): void {
  versionChanges.set(docId + '@' + version, changes);
}
export function getVersionChanges(docId: string, version: number): Promise<VersionChange[]> {
  return Promise.resolve(versionChanges.get(docId + '@' + version) ?? []);
}

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

/**
 * Mint cursor tokens for flat-text positions (see the MockCursor notes above).
 * With `heads`, the positions are indices into THAT version's text: the token
 * names the character that was there, wherever it has moved to since.
 */
export function getTextCursors(
  docId: string, path: (string | number)[], positions: number[], heads?: string[],
): Promise<string[]> {
  const key = cursorKey(docId, path);
  const named = heads?.length === 1 && /^h\d+$/.test(heads[0]) ? Number(heads[0].slice(1)) : undefined;
  const since = named !== undefined && named >= (logFloor.get(docId) ?? 0)
    ? (opLog.get(key) ?? []).filter(e => e.after > named)
    : [];
  const len = since.length ? since[0].lengthBefore : flatLength(docId, path);
  const ops = since.flatMap(e => e.ops);
  return Promise.resolve(positions.map(p => {
    const token = 'a' + (++nextCursorId);
    if (p >= len) cursors.set(token, { key, pos: 'end' });
    else {
      const now = shiftPositionThroughOps(Math.max(0, p), ops);
      if (now !== null) cursors.set(token, { key, pos: now }); // else unresolvable, like a foreign token
    }
    return token;
  }));
}

/** Replace the set of tokens resolved into positions on every query-result. */
export function subscribeCursors(docId: string, path: (string | number)[], tokens: string[]): void {
  const key = cursorKey(docId, path);
  if (tokens.length === 0) cursorSubs.delete(key);
  else cursorSubs.set(key, [...tokens]);
  __notify(docId); // a new subscription needs its first positions
}
export function setPresenceTiming(): Promise<void> { return Promise.resolve(); }

export function getWorkerPeerId(): string { return 'peer-mock'; }
export function getWorkerUserGroupId(): string | null { return null; }
export function getWorkerError(): string | null { return null; }
export function onWorkerError(): () => void { return noop; }
export function onKeyhiveStateChanged(): () => void { return noop; }

export function getMyAccess(): Promise<string | null> { return Promise.resolve('admin'); }
export function getDocMembers(): Promise<{ members: any[] }> { return Promise.resolve({ members: [] }); }
export function getKnownFriends(): Promise<any[]> { return Promise.resolve([]); }
export function getMyAccessLevel(): Promise<string | null> { return Promise.resolve('admin'); }

export function usePeerTransports(): Record<string, any> { return {}; }
export function onP2pStatus(): () => void { return noop; }
export function getDirectPeers(): string[] { return []; }
export function getConnectedPeers(): string[] { return []; }
export function usePeerList(): string[] { return []; }
export function useConnectionStatus(): boolean { return true; }
export function useWsStatus(): boolean { return true; }
/** Under the mock there is no tab transport, so report the single-tab case. */
export function useTabRole(): 'unknown' | 'leader' | 'follower' { return 'leader'; }
export function whenWsConnected(): Promise<void> { return Promise.resolve(); }

// Doc list + unseen flags: subscribable, so a Home test can drive the two pushes
// the real worker owns (the list itself, and the per-doc new-changes flags — which
// travel on their own channel precisely because they must be able to change when
// the summary projection does not).
let docList: any[] = [];
const docListSubs = new Set<(list: any[]) => void>();
let unseenFlags: Record<string, boolean> = {};
const unseenSubs = new Set<(u: Record<string, boolean>) => void>();

export function getDocList(): Promise<any[]> { return Promise.resolve(docList); }
export function fetchDocList(): Promise<any[]> { return Promise.resolve(docList); }
export function onDocListUpdated(fn: (list: any[]) => void): () => void {
  docListSubs.add(fn);
  fn(docList);
  return () => { docListSubs.delete(fn); };
}
export function onUnseenChangesUpdated(fn: (u: Record<string, boolean>) => void): () => void {
  unseenSubs.add(fn);
  fn(unseenFlags);
  return () => { unseenSubs.delete(fn); };
}
export function getUnseenChanges(): Record<string, boolean> { return { ...unseenFlags }; }

/** Push a doc list ({ id, type, name }[]) as the worker's doc-list update. */
export function __setDocList(list: Array<{ id: string; type?: string; name?: string }>): void {
  docList = list;
  for (const fn of docListSubs) fn(docList);
}
/** Push the worker's per-doc unseen-changes flags. */
export function __setUnseen(unseen: Record<string, boolean>): void {
  unseenFlags = unseen;
  for (const fn of unseenSubs) fn(getUnseenChanges());
}
export function onDeviceNamesUpdated(): () => void { return noop; }
export function onFriendNamesUpdated(): () => void { return noop; }

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
