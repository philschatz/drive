# New-changes indicator on the homepage (last-viewed heads)

> Repo convention: copy this file into the repo's own `.claude/plans/` when implementation starts.

## Context

Documents sync in the background, but nothing tells the user *which* docs changed since they last looked. The homepage shows "updated X ago", but that doesn't distinguish "I edited it" from "a collaborator changed it while I wasn't looking". The feature: persist the last-viewed version (automerge heads) of each document per device, and show a "new changes" dot on the homepage for docs whose current heads differ.

### Decisions (confirmed with Phil)

1. **Viewing is inferred from query traffic** (Phil's call, superseding an earlier explicit-signal idea): `query`/`subscribe-query` gain an optional `peek: true` field. Non-peek query activity on a doc counts as viewing; the homepage summary and the source inspector/export pass `peek: true`. No view-start/end lifecycle messages: "viewing active" = the doc has ≥1 live non-peek subscription, and "view end" is just the existing unsubscribe on unmount (no action needed — heads were kept current throughout).
2. **Missing record = unseen**: docs never opened on this device (incl. newly shared, and everything at first rollout) show the indicator.
3. **Source inspector / export never counts** as viewing (its queries are peek).
4. **The worker computes the indicator state** and pushes it. It cannot ride on existing `query-result` messages: `pushToSubscriptions` skips posting when the jq result is unchanged (`if (!changed) continue`, src/shared/drive-engine.ts:553), so edits that don't move the homepage summary (e.g. renaming an event) would never reach Home.
5. Per-device local state (IDB), not synced across devices. No settings toggle, no per-field granularity.

Accepted trade-off of #1: future passive callers must remember `peek: true` or they'll silently mark docs seen. Accepted because the full call-site inventory is small (below) and the win is real — no new lifecycle messages, no `activeViews` state, view lifetime rides the existing subscription lifetime.

### Query call-site inventory (verified — every `subscribeQuery`/`queryDoc` caller)

| Caller | Classification |
|---|---|
| `DocRoute.tsx:27` — `.["@type"]` resolution, lives for the whole editor mount | **viewing** — this alone is the continuous editor-route view signal |
| `Calendar.tsx:112`, `Tasks.tsx:180`, `DataGrid.tsx:668/1034/1042` — editor content | **viewing** |
| `AllCalendars.tsx:155,223` — combined-calendar view | **viewing** (judgment call: it's a real viewing surface using the same range-limited query shape as the Calendar editor; flip to peek if Phil disagrees) |
| `Home.tsx:90` — `HOME_SUMMARY_QUERY` per listed doc | **peek** |
| `SourceViewer.tsx:266` — `'.'` snapshot (feeds Download JSON export) | **peek** |

(Engine-internal reads use `runQuery` directly, never the subscription path — unaffected. Presence/validation subscriptions are separate message types — unaffected.)

### Verified facts the design rests on

- Heads are computed only in the worker (`handle.heads()`); main thread never holds doc handles.
- Home's per-doc summary subscriptions background-open every listed doc (`OPEN_DOCS_IN_BACKGROUND = true`, drive-engine.ts:73, path :499-503), so change handlers attach and current heads become knowable once Home mounts. Peek subs still open docs — they just don't mark them viewed.
- All create/import flows navigate straight into the editor (`window.location.hash = docUrl(docId)`, Home.tsx:124, 612, 652, 678) → new docs self-mark seen via the editor's non-peek subs; no create-flow seeding needed.
- worker-api functions are auto-exposed on `window.__drive` (src/client/test-bridge.ts:19) → Playwright-drivable. Caveat: specs that poll with a non-peek `queryDoc` mark docs viewed — expose `peek` on `queryDoc` and use it in specs where dots matter.
- Multi-tab caveat (accepted): each tab has its own worker sharing IDB but not memory; viewing in tab B won't clear tab A's dot until reload. Multitab is deliberately disabled anyway (pinned `drive` peerId suffix).

## Implementation

### 1. `src/shared/storage-keys.ts` — new KEYS entry

```ts
/** Per-device seen state: automerge docId → the doc's heads (sorted) when a
 *  viewing (non-peek) query last saw it. Missing entry = never viewed = dot. */
lastViewedHeads: 'data:last-viewed-heads',
```

`data:` category (a `cache:` key would be wiped by cache clears). Single map key (`Record<docId, string[]>`), mirroring `contactNames`. Worker-owned: written only via `host.kv`. No IDB migration needed.

### 2. `src/shared/worker-protocol.ts` — peek field + one push

MainToWorker — extend the two existing read messages:

```ts
| { type: 'query'; id: number; docId: string; filter: string; peek?: boolean }
| { type: 'subscribe-query'; subId: number; docId: string; filter: string; peek?: boolean }
```

`peek: true` = "don't count this read as the user viewing the doc" (homepage summary, source inspector/export, background tooling). Default (absent) = viewing.

WorkerToMain (full-map push, styled after `contact-names-updated`; small — one boolean per listed doc):

```ts
// Absent docId = unknown (doc not loaded yet AND it has a last-viewed record) — UI shows no dot.
| { type: 'unseen-changes-updated'; unseen: Record<string, boolean> }
```

No request/response needed: worker-api caches the last push and replays to late subscribers (precedent: `lastPresence` replay, worker-client.ts:363-365).

### 3. `src/shared/drive-engine.ts` — worker-side state machine

**Exported pure helper** (for direct Jest testing):

```ts
/** Order-insensitive head-set equality. A missing record never equals. */
export function headsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}
```

**New engine state:**

```ts
private lastViewedHeads: Record<string, string[]> | null = null;  // null until init() loads it
private unseenChanges: Record<string, boolean> = {};              // last computed state (what we emit)
```

**Sub bookkeeping:** the subscription record (`{filter, post}` in `DocEntry.subscriptions` and `pendingSubs`) gains `peek?: boolean`; `subscribeQuery(docId, subId, filter, post, peek)` threads it through (worker shell passes `pm.peek`, automerge-worker.ts:172). Helper:

```ts
private hasViewingSub(entry: DocEntry): boolean {
  for (const sub of entry.subscriptions.values()) if (!sub.peek) return true;
  return false;
}
```

**Private helpers** — `emitUnseen()` (emit full map copy); `setUnseen(docId, value)` (transition-only: skip if unchanged, else mutate + emit); `persistLastViewed()` (fire-and-forget `host.kv.set(KEYS.lastViewedHeads, map)`; IDB txns from one connection commit in order); and:

```ts
/** Record the doc's current heads as viewed. */
private markViewed(docId: string, heads: string[]): void {
  if (!this.lastViewedHeads || heads.length === 0) return;  // never record "empty" as seen
  if (!headsEqual(this.lastViewedHeads[docId], heads)) {
    this.lastViewedHeads[docId] = [...heads].sort();
    this.persistLastViewed();
  }
  this.setUnseen(docId, false);
}
/** Recompute a loaded doc's flag; while a viewing sub is live, keep last-viewed current instead. */
private refreshSeenState(docId: string): void {
  if (!this.lastViewedHeads) return;                 // init not finished
  const entry = this.docRegistry.get(docId);
  if (!entry) return;
  const handle = entry.handle;
  if (handle.isReady && !handle.isReady()) return;   // heads unknown until load
  const heads: string[] = handle.heads ? handle.heads() : [];
  if (heads.length === 0) return;
  if (this.hasViewingSub(entry)) this.markViewed(docId, heads);
  else this.setUnseen(docId, !headsEqual(this.lastViewedHeads[docId], heads));
}
/** Doc left the home list (archive / revoke) — drop its seen state. */
private pruneSeenState(docId: string): void {
  if (this.lastViewedHeads && docId in this.lastViewedHeads) {
    delete this.lastViewedHeads[docId];
    this.persistLastViewed();
  }
  if (docId in this.unseenChanges) { delete this.unseenChanges[docId]; this.emitUnseen(); }
}
```

**Hook points:**

a. **`getOrCreateEntry` (drive-engine.ts:421-442)** — the choke point every change event and doc load passes through. Add `this.refreshSeenState(docId)` inside `onChange` (:426-429) — deliberately independent of `pushToSubscriptions` (which early-returns with no subs and dedups jq results). Also an initial comparison once the handle is ready (covers docs background-opened by Home's peek subs, where no change event may ever fire):

```ts
Promise.resolve(handle.isReady?.() ? undefined : handle.whenReady?.())
  .then(() => this.refreshSeenState(docId))
  .catch(() => { /* unavailable — stays unknown */ });
```

b. **engine `subscribeQuery` (:474-505)** — after attaching a sub to an existing entry (:493), call `this.refreshSeenState(docId)` so opening an editor on an already-loaded doc marks it seen immediately (the pending-subs path is covered by hook (a)'s whenReady). `unsubscribeQuery` needs **no change** — view end requires no action, heads were kept current throughout.

c. **one-shot `query` handler (:1718)** — after computing heads, `if (!msg.peek) this.markViewed(docId, heads)` (so a non-peek `queryDoc`, e.g. AllCalendars' init read, counts as viewing once).

d. **`init()`** — load the map early (next to the cache-disabled hydration, ~:782), defaulting to `{}` on error. Right after the early doc-list emit (:840), the initial push — computable without loading any doc:

```ts
// Missing record = unseen (decision #2). Docs WITH a record stay absent
// (unknown) until they load and compare — avoids dot-flash on every start.
for (const e of earlyList) if (!this.lastViewedHeads![e.id]) this.unseenChanges[e.id] = true;
this.emitUnseen();
```

e. **`reconcileHomeDocsOnce`** — add branch (after `newDocHandles.push(amDocId)`, :642): `if (!this.lastViewedHeads?.[amDocId]) this.setUnseen(amDocId, true);` (newly-shared docs dot immediately). Both removal branches (:651, :659): `this.pruneSeenState(e.id);`.

f. **`archive-doc` handler (:1361)** — `this.pruneSeenState(msg.docId);` next to the `docRegistry.delete` cleanup (~:1379).

g. **History/restore** — no special code. Restores fire `onChange` → normal path. Restoring from the editor's HistorySlider happens under live viewing subs → stays seen; restoring from SourceViewer (peek) flips the dot on — correct (it *is* a new change).

### 4. Main-thread plumbing — `worker-client.ts` + `worker-api.ts`

`worker-client.ts`: `subscribeQuery` (:340) and `queryDoc` (:320) gain an optional `opts?: { peek?: boolean }`, included in the posted message.

`worker-api.ts`:
- `subscribeQuery(docId, filter, onResult, onError?, opts?)` (:496) and `queryDoc(docId, filter, opts?)` (:522) forward `opts`.
- Unseen plumbing next to the doc-list plumbing (~:36):

```ts
let unseenChanges: Record<string, boolean> = {};
const unseenListeners = new Set<(unseen: Record<string, boolean>) => void>();

/** Subscribe to per-doc "new changes since last viewed" state; replays current snapshot. */
export function onUnseenChangesUpdated(fn: (unseen: Record<string, boolean>) => void): () => void {
  unseenListeners.add(fn);
  fn(unseenChanges);
  return () => { unseenListeners.delete(fn); };
}
export function getUnseenChanges(): Record<string, boolean> { return { ...unseenChanges }; }
```

- New case in the push-message switch next to `doc-list-updated` (:261):

```ts
case 'unseen-changes-updated':
  unseenChanges = msg.unseen;
  for (const fn of unseenListeners) fn(unseenChanges);
  break;
```

### 5. Flag the peek callers

- `Home.tsx:90`: `subscribeQuery(docId, HOME_SUMMARY_QUERY, cb, undefined, { peek: true })`
- `SourceViewer.tsx:266`: `subscribeQuery(docId, '.', cb, onError, { peek: true })`

`DocRoute.tsx` and all editors: **no changes** — their existing subscriptions are the view signal by default.

### 6. `src/client/home/Home.tsx` — dot in the row

Keep the unseen map as its own state rather than a `DocEntry` field — the three existing `setEntries` writers (doc-list merge :66, `applyQueryResult` :35, access updates :100) would each have to preserve the flag; a parallel map has one writer:

```tsx
const [unseen, setUnseen] = useState<Record<string, boolean>>(() => getUnseenChanges());
useEffect(() => onUnseenChangesUpdated(setUnseen), []);
```

Dot inside the name link (:816-818, already `flex items-center gap-1`), styled like the header connection dot (:730-734):

```tsx
{entry.name || 'Untitled'}
{!noEntryAccess && unseen[entry.documentId] && (
  <span data-testid="unseen-dot"
        className="w-2 h-2 rounded-full shrink-0 bg-sky-500"
        title="New changes since you last viewed this document" />
)}
```

No optimistic clear on click (the editor's non-peek sub clears it in the worker; snapshot replay is current when the user returns). No sort change. Home's summary-callback `_heads` stays ignored — single source of truth is the worker push.

### Edge-case dispositions

- Remote edits while doc open in editor → `onChange` → viewing sub live → `markViewed` → stays seen.
- Tab close without unsubscribe → harmless (continuous marking while subs were live; worker dies with tab).
- Brand-new doc → create flows land in the editor → non-peek subs mark seen. (Minor artifact: during a long xlsx import the new row may briefly dot until navigation.)
- Editor week/sheet navigation briefly swaps content subs → no gap: DocRoute's `@type` sub persists for the whole mount.
- Unsupported-`@type` doc page → DocRoute's `@type` sub marks it seen. Accepted (user opened it; keeps the rule uniform).
- No-access rows → dot suppressed (`!noEntryAccess`). Loading rows may dot (missing record = unseen — intended).
- Docs with a record that never load → absent from map → no dot (unknown ≠ unseen; no dot-flash at startup).
- Multi-tab drift → accepted, heals on reload.
- Cache clear survives (`data:` key); full data reset re-dots everything (consistent with decision #2).

## Tests

**Jest — new `tests/last-viewed.test.ts`** (pattern: `tests/rendezvous-bounds.test.ts` — `new DriveEngine({...} as any)` with in-memory KV + emit recorder; FakeHandle with `on/heads/isReady/whenReady/doc` + `fireChange()`):

1. `headsEqual`: order-insensitive; missing record never equals; length mismatch.
2. Non-peek subscribe on a ready doc → sorted heads recorded under `KEYS.lastViewedHeads`, emits `{d1: false}`.
3. Change while a non-peek sub is live → last-viewed re-recorded, no `unseen: true` emission.
4. Change with only a **peek** sub live → exactly one `unseen-changes-updated` with `{d1: true}` across two consecutive changes (transition-only dedupe), and KV record untouched.
5. One-shot `query` with `peek: true` doesn't mark; without it, marks viewed.
6. Missing record + ready handle entry → `unseen: true` (decision #2).
7. `pruneSeenState` drops the KV record + emits map without the doc.

**Playwright — new `src/client/tests-pw/ui/unseen-dot.spec.ts`** (single-browser, `openApp` harness):

1. Create a task list via UI → lands in editor; capture docId from hash.
2. Go to `#/` → row has **no** `[data-testid=unseen-dot]` (Home's peek summary didn't clear or set anything; doc was viewed in step 1).
3. While on Home, mutate via bridge with a change *invisible to the summary query* — add a **completed** task via `window.__drive.updateDoc` (completed tasks are excluded from `taskCount`, so the jq result is unchanged — proves the push bypasses the dedup at drive-engine.ts:553) → dot appears.
4. Click into the doc, return to `#/` → dot gone.

(Don't poll doc contents with non-peek `queryDoc` in this spec — it would mark the doc viewed.) Skip a two-browser remote-change spec: remote sync takes the same `handle.on('change')` path step 3 exercises.

## Implementation order

storage-keys.ts → worker-protocol.ts → drive-engine.ts → automerge-worker.ts (pass `pm.peek`) → worker-client.ts / worker-api.ts → Home.tsx + SourceViewer.tsx peek flags → Home.tsx dot → Jest tests → Playwright spec. Commit directly on main (repo convention).

## Verification

- `npm run test:unit` (new tests, no regressions vs known-failing baseline)
- `npx tsc --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`
- `npx playwright test src/client/tests-pw/ui/unseen-dot.spec.ts`
- Manual (own vite instance, not Phil's port-3000 dev server): two browser profiles sharing a doc — A on Home, B edits → dot appears on A without reload; A opens the doc while B keeps editing, A returns Home → no dot; A opens only View Source → dot stays; fresh share → dot before first open; archive a dotted doc → its entry gone from IDB `data:last-viewed-heads`.
