# Multi-tab document editing via a leader-owned engine

## Context

Today a second tab of the app is deliberately crippled. All tabs share one peerId
(`<agentId>-drive`), so the relay rejects the second tab's join
([relay.ts:290-295](../../code/mine/drive/src/relay/relay.ts#L290-L295)), and
`src/client/ui/multi-tab.ts` exists purely to detect the extra tab and show a
"this tab won't sync" banner ([Notifications.tsx:42-55](../../code/mine/drive/src/client/ui/components/Notifications.tsx#L42-L55)).

That was the right call, because *two engines per device is genuinely unsafe*, not
merely unsupported:

- **The keyhive archive is a single fixed IDB key.** The slot is
  `["keyhive-db","/archives/",hex(sha256(peerIdSuffix))]` and the suffix is pinned to
  the constant `'drive'` ([drive-engine.ts:955-961](../../code/mine/drive/src/shared/drive-engine.ts#L955-L961)).
  Each instance writes a *full snapshot* of its own state there, and boot deletes
  non-pending `/ops/` chunks. Two writers ⇒ silent op loss.
- **CGKA leaf secrets live only in WASM memory + that archive**
  ([keyhive-repo.ts:265-303](../../code/mine/drive/src/shared/keyhive-repo.ts#L265-L303)). A clobbered
  rotation is unrecoverable — every peer ciphertext fails with "Key not found" forever.
- Engine-owned IDB state is whole-value read-modify-write with no CAS:
  `KEYS.docIds` (lost doc on concurrent create) and `lastViewedHeads` (continuous
  clobber of seen-state).

So the fix is not "let two engines coexist" — it is **exactly one engine per device,
shared by every tab**. That is the user's instinct, and it also fixes the three IDB
hazards above for free.

`SharedWorker` is the obvious vehicle but is ruled out: **Chrome for Android does not
support `SharedWorker` at all**, and module-type SharedWorker is explicitly excluded
there. This worker must be `{type:'module'}` (top-level `await` + dynamic imports),
and this is a mobile-first PWA.

**Chosen design:** the tab that wins the *existing* Web Lock boots today's dedicated
`Worker` unchanged and acts as a router; other tabs RPC to it over `BroadcastChannel`.
Works in every browser. A dedicated Worker cannot outlive its tab and the lock
releases exactly when the tab dies, so there is **no two-engine window**.

**v1 scope:** every tab edits live. Own-tab presence and freeze-proof leadership are
explicitly deferred (see Deferred).

## The seam that makes this cheap

`WorkerClient` already depends on nothing but `postMessage`
([worker-client.ts:18-20](../../code/mine/drive/src/client/shared/worker-client.ts#L18-L20)), and
`worker-api.ts` is the **only** file that binds a concrete `Worker`. Nothing in
`src/shared/drive-engine.ts`, `src/client/worker/automerge-worker.ts`, or
`src/shared/worker-protocol.ts` changes — the engine keeps seeing one client.

## Implementation

### 1. `src/client/ui/tab-transport.ts` (new)

```ts
export interface WorkerTransport {
  postMessage(msg: any, transfer?: Transferable[]): void;  // satisfies WorkerLike
  onMessage(cb: (msg: WorkerToMain) => void): void;
  onFatal(cb: (message: string) => void): void;
  /** Runs when this tab owns the engine; `post` reaches the Worker directly. */
  onLeader(cb: (post: (msg: any, transfer?: Transferable[]) => void) => void): void;
  shutdown(): Promise<void>;   // replaces worker.terminate() for deleteAllData
}
export function makeWorkerTransport(): WorkerTransport;
```

Leadership resolution is async but `worker-api.ts` is synchronous at module scope, so
the transport **buffers outbound `postMessage` until its channel is live**. Harmless:
`WorkerClient` gates every send on `workerReady`, which only resolves once the real
worker emits `ready`.

Reuse `watchTabLeadership` from [multi-tab.ts](../../code/mine/drive/src/client/ui/multi-tab.ts)
as-is — `onChange(false)` already means "you are the leader". Rewrite only its header
comment. On promotion, the transport boots the Worker and starts the router; on
`onChange(true)` it becomes a BroadcastChannel client.

### 2. `src/client/ui/tab-router.ts` (new) — leader side

Sits between **all** `WorkerClient`s (including the leader's own, as client 0) and the
single Worker. State:

- `clients: Map<number, (msg) => void>` — 0 = local, others post over BroadcastChannel
- `idMap: Map<globalId, {clientId, localId}>` — one monotonic counter; rewrite `id` on
  requests and `subId` on query subs inbound, reverse outbound. This also **fixes the
  latent collision** where [hf-worker.ts:64](../../code/mine/drive/src/client/ui/doc-plugins/datagrid/hf-worker.ts#L64)
  and [worker-client.ts:69](../../code/mine/drive/src/client/shared/worker-client.ts#L69) both mint
  `subId = 1` into the engine's flat `subIdToDocId`
  ([drive-engine.ts:112](../../code/mine/drive/src/shared/drive-engine.ts#L112)).
- `docSubs: Map<docId, Set<clientId>>` for presence + validation, which are keyed by
  `docId` and carry no id. Forward only the first `subscribe-*` and last
  `unsubscribe-*`; fan `update-presence`/`update-validation` out to subscribed clients.
  **Lift the identical refcount logic already in
  [worker-client.ts:387-427](../../code/mine/drive/src/client/shared/worker-client.ts#L387-L427)** into a
  shared helper rather than writing it twice.
- `rdvOwner: Map<rendezvousId, clientId>` so a QR flow's `kh-rdv-event` lands in the
  tab that started it, not every tab.

Outbound routing table:
- **unicast by id** — `result`, `query-result`, `open-doc-progress`
- **unicast by docId sub set** — `update-presence`, `update-validation`
- **unicast by rdv owner** — `kh-rdv-event`
- **broadcast** — `ready`, `kh-ready`, `kh-error`, `error`, `data-warning`, `kh-trace`,
  `peer-connected`, `peer-disconnected`, `ws-status`, `p2p-status`,
  `doc-list-updated`, `unseen-changes-updated`, `friend-names-updated`,
  `device-names-updated`, `kh-state-changed`

Lifecycle: `hello` → router assigns a clientId and replays `ready`/`kh-ready` (a
follower joining a warm leader must not hang on its gates). `bye` on `pagehide`, plus
a heartbeat sweep, drops a departed client's subs (`unsubscribe-query` per sub,
presence refcount decrement) so a closed tab can't leak a live subscription.

### 3. `src/client/shared/tab-channel.ts` (new)

Envelope types only: `{ from, to: number | '*', kind: 'req'|'res'|'hello'|'welcome'|'bye'|'beat'|'wipe'|'wiped', payload }`.
Types in `shared/`, the router in `ui/` — the router references the worker path via
`new URL(...)`, which is not an import and so stays inside the layering rules that
`tests/layering.test.ts` enforces.

### 4. `src/client/ui/worker-api.ts` (modified)

- [:144-147](../../code/mine/drive/src/client/ui/worker-api.ts#L144-L147) `new Worker(...)` → `makeWorkerTransport()`; pass the transport to `new WorkerClient(...)` unchanged.
- [:322](../../code/mine/drive/src/client/ui/worker-api.ts#L322), [:391](../../code/mine/drive/src/client/ui/worker-api.ts#L391), [:397](../../code/mine/drive/src/client/ui/worker-api.ts#L397) `worker.onmessage`/`onerror`/`onmessageerror` → `transport.onMessage` / `onFatal`. The switch body is untouched.
- [:195-202](../../code/mine/drive/src/client/ui/worker-api.ts#L195-L202) WebRTC bridge → move inside `transport.onLeader(post => …)`. Only the leader owns `RTCPeerConnection`s, which is required anyway: `signal-out` stamps one `senderId` and `webrtc-relay-adapter.ts` has a single `port` slot. Followers never start a bridge, so the port-swap black-hole in that adapter cannot occur.
- `deleteAllData()` [:571-608](../../code/mine/drive/src/client/ui/worker-api.ts#L571-L608): `worker.terminate()` is unavailable to a follower. Replace with: broadcast `wipe` → every other tab calls `closeDb()` and renders a terminal "data deleted, reload" state (it must *not* reopen the DB); `await transport.shutdown()` (router terminates the Worker; a follower asks the leader to); then today's `deleteDatabase` loop; then broadcast `wiped` and reload. Keep the existing 5 s `onblocked` safety net.

### 5. DataGrid / HyperFormula (modified)

`hf-port` transfers a `MessagePort` into the Worker
([worker-api.ts:957-961](../../code/mine/drive/src/client/ui/worker-api.ts#L957-L961),
[automerge-worker.ts:189-206](../../code/mine/drive/src/client/worker/automerge-worker.ts#L189-L206)), and
**transferables cannot cross a `BroadcastChannel`** — so a follower's DataGrid has no
path to the engine.

Fix: stop wiring the hf worker to the automerge worker. In
[hf-bridge.ts](../../code/mine/drive/src/client/ui/doc-plugins/datagrid/hf-bridge.ts), keep the
`MessageChannel` to the hf worker but let the **DataGrid's own main thread** proxy the
only two messages that crossed it — `subscribe-query` / `unsubscribe-query` — through
`subscribeQuery` from `worker-api`. Same protocol on the hf side, no `hf-worker.ts`
change beyond dropping its private `nextSubId`. `hf-port` becomes dead protocol
surface; delete it from `worker-protocol.ts` and the worker shell.

Cost: hf query results take one extra hop (worker → main → hf worker). Watch this on a
formula-heavy sheet; if it bites, reinstate the direct port for the leader tab only.

### 6. `src/client/ui/components/Notifications.tsx` (modified)

Delete the `multi-tab` toast ([:42-55](../../code/mine/drive/src/client/ui/components/Notifications.tsx#L42-L55)).
Surface leader/follower in Debugging settings instead, next to the existing peer rows.

### 7. Accepted v1 behavior

- **Version pinning goes global.** `DocEntry.pinnedVersion` is engine state, so a
  history-pinned view in one tab pins the doc for all. Note it in the router's doc
  comment; per-client pinning is a follow-up.
- **Presence is one state per device** — the tabs share one `Presence` object. Gate
  `set-presence` on `document.visibilityState === 'visible'` in `useFocusPathSync` so a
  hidden tab can't fight the focused one for `focusedField`.
- **A frozen leader pauses sync for followers** until that tab is revisited. Not
  corrupting (a frozen tab's worker is suspended too).

## Verification

```bash
npx tsc --noEmit && npx tsc -p tsconfig.client.json --noEmit
npm run test:unit
```

**New `tests/tab-router.test.ts`** (node project, fake `BroadcastChannel` + fake
worker — no real Worker needed, same spirit as `worker-client.test.ts`):
two clients both sending `id: 1` get their own replies; `subId` round-trips; presence
refcount forwards only first-subscribe/last-unsubscribe; broadcast types reach all
clients; `kh-rdv-event` reaches only the originating client; a client's `bye`
unsubscribes its queries and decrements presence.

**Playwright** — replace `src/client/tests-pw/multi-tab-warning.spec.ts` with
`multi-tab-edit.spec.ts` (two pages, one `BrowserContext`):
1. Both open the same doc; an edit in tab B appears live in tab A.
2. No `multi-tab-banner`.
3. Close tab A (the leader) → tab B boots a worker, still edits, and still syncs to a
   remote peer (reuse `setupFriendPair` / `shareNewDoc` from `support/`).
4. A DataGrid formula evaluates in a follower tab (hf routing changed; DataGrid cannot
   mount in jsdom).

```bash
PW_PORT=4446 npm run test:pw    # forced rebuild — test:pw reuses a live :4445 and a
                                # stale dist/ invents convincing failures
```

**Manual:** start an own vite on a spare port (`--strictPort`; never touch the dev
server on 3000), open two tabs on one doc, type in both, then close the first tab and
confirm the second keeps syncing to a phone/second browser.

## Deferred

- **Own-tab presence** — synthesize local presence per client in the router so tab A
  shows "you are editing the title in another tab".
- **Freeze-proof leadership** — a generation-based lease replacing the Web Lock, so
  leadership follows the visible tab and survives a mobile freeze/discard.
- **SharedWorker fast path** behind the same `WorkerTransport` seam, removing the
  leader hop on desktop. Only if the extra hop measurably hurts.
- **Per-client version pinning.**
