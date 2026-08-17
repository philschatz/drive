# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Collaborative document editor built on Automerge CRDTs. Currently supports Calendar, TaskList, and DataGrid document types. The frontend is a Preact PWA; the backend is an Express server with CalDAV support. Documents sync in real-time via automerge-repo through a WebSocket relay, with an opportunistic upgrade to direct peer-to-peer WebRTC channels (see Sync & Networking).

## Commands

```bash
npm run dev          # Backend dev server with auto-reload (port 3000)
npm run build        # Vite production build (frontend → dist/)
npm run test:unit    # Jest unit tests
npm run test:watch   # Jest watch mode
npm test             # Jest + Playwright (full suite)
npm run test:pw      # Playwright E2E (editor UI + two-peer sync specs) — auto-picks a free port
npm run test:pw:open # Playwright UI mode
```

**Type checking** (two separate tsconfigs):

```bash
npx tsc --noEmit                          # Node side (src/relay, src/bitrot-caldav, src/cli)
npx tsc -p tsconfig.client.json --noEmit  # Frontend (src/client/ + src/shared/)
```

**Run a single test file:**

```bash
npx jest tests/parser.test.ts
```

## Architecture

### Directory Layout

Each top-level directory under `src/` is one program or one runtime, and the boundaries between them are enforced by `tests/layering.test.ts` — not just convention.

**Node programs** (three separate entry points, no shared process):

- `src/relay/` — the stateless WebSocket relay (`relay.ts`), the production SPA host (`serve.ts`), and the Vite dev plugin that embeds the relay in the dev server (`relay-plugin.ts`)
- `src/bitrot-caldav/` — the CalDAV bridge: RFC 4791 handler, `/dav` + `/admin` routes, and the ICS↔JMAP `parser.ts` / `serializer.ts`. Depends on `src/relay` (it embeds one) and on `src/cli` (the keyhive Node shim)
- `src/cli/` — the headless drive peer (`cli.ts`, driven by `scripts/drive-service.sh`), its JSON-file KVStore, the keyhive WASM shim for Node, and the Node half of the WebRTC upgrade (`webrtc-node-bridge.ts` + the werift driver `werift-rtc.ts`)

**Browser** (`src/client/`) — split by *thread*, because the two halves cannot import each other:

- `src/client/ui/` — everything Preact/DOM. `main.tsx`, `App.tsx`, `worker-api.ts` (the main thread's handle on the worker), `tab-transport.ts`/`tab-router.ts`/`multi-tab.ts` (the cross-tab layer — see Tabs & the single engine), `webrtc-bridge.ts`, and the feature dirs: `doc-plugins/` (`calendar/`, `tasks/`, `datagrid/`, `counters/`, `sentences/` + the registry `index.ts`/`types.ts`), `home/`, `source/`, `friends/`, `sharing/`, `settings/`, `debug/`, `components/`, `lib/`, and `common/` (shared UI hooks + components)
- `src/client/worker/` — the Web Worker: `automerge-worker.ts` and the things only it loads (`idb-kvstore.ts`)
- `src/client/shared/` — the small set of modules genuinely used by *both* threads: `idb-storage.ts`, `worker-client.ts`, `tab-channel.ts`
- `src/client/assets/` — `globals.css` and `public/` (favicon, PWA icons). `index.html` stays at `src/client/` because it is Vite's root entry
- `src/client/tests-pw/` — Playwright E2E (editor UI specs + two-peer sync harness)

**Portable** (`src/shared/`) — code with no DOM and no Preact, imported by the browser *and* the Node programs: `drive-engine.ts`, `keyhive-repo.ts`/`keyhive-ops.ts`, `jq.ts`, `worker-protocol.ts`, `schemas/`, the WebRTC upgrade stack (`webrtc-relay-adapter.ts`, `webrtc-bridge-core.ts`, `webrtc-chunk.ts`, `ice-config.ts` — see Sync & Networking), the overlay-frame plumbing (`relay-overlay.ts`), and the small utilities. `tests/` holds the repo-root Jest suites.

**The one rule that matters:** `src/shared/**` must never import from `src/client/**`, and `src/client/ui` and `src/client/worker` must never import each other — including type-only imports, which are invisible at runtime and so would never fail loudly. Anything two of them need goes in `src/client/shared` (browser APIs allowed) or `src/shared` (portable). Adding a doc type means a `plugin.tsx` in `ui/doc-plugins/<type>/` plus a schema core in `src/shared/schemas/`.

### Two TypeScript Projects

- **`tsconfig.json`** — Node side (`src/relay/`, `src/bitrot-caldav/`, `src/cli/`), CommonJS, compiles to `dist/`
- **`tsconfig.client.json`** — Frontend (`src/client/` + `src/shared/`), ESNext modules, noEmit (Vite handles bundling)

### Frontend Stack

- **Preact** (not React) with `@preact/preset-vite` for JSX. Radix UI components work via preact/compat aliases.
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin. Theme tokens in `src/client/assets/globals.css`.
- **schedule-x** for calendar rendering. It uses `@preact/signals` internally — `vite.config.ts` has `resolve.dedupe` to prevent duplicate Preact/signals instances.
- **Automerge WASM** is base64-inlined into the bundle via a custom Vite plugin (hence the 5MB+ chunk size).

### Document Design Principles

Documents follow JSCalendar (RFC 8984) with modifications for CRDT collaboration:

- **Maps over Arrays**: Events, tasks, rows are `Record<string, Item>` for conflict-free concurrent edits
- **No stored IDs**: Document identity comes from the Automerge repo handle, not a field in the document
- **Single recurrence rule** per event (not an array) since editors don't support multiple
- **`@type` discriminator**: Each document has `"@type": "Calendar" | "TaskList" | "DataGrid"` for schema dispatch

### Schema Validation

`src/shared/schemas/core.ts` defines a functional DSL for schema validation: `str()`, `num()`, `bool()`, `obj()`, `record()`, `union()`, `arr()`. Each document type has a schema definition and dependency checker in its own file under `schemas/`. Validators return `ValidationError[]` with paths and messages.

### Item Editors (PropertySheet)

Every doc-item editor (`TaskEditor`, `CounterEditor`, `EventEditor`, `CalendarSettings`) is built from `src/client/ui/common/PropertySheet.tsx`: a Material bottom sheet showing a **property list** (`md-list-item` per property — icon, label, current value as supporting text) that swaps to a **single focused field** when a row is tapped. One thing is edited at a time.

- **A single-field pane is transactional.** It marks itself `transactional: true` and wraps its control in `ui/common/FieldEditor.tsx`, which owns the draft and renders Cancel/Save below it. Those panes lose the header's Back arrow, so the edit has exactly one discard gesture and one save gesture, and makes exactly one document change; `FieldEditor` blurs the focused control before writing, so the peer's presence dot clears. Escape behaves as Cancel. `FieldSheet` is the same thing as a standalone modal (see `RenameSheet`).
- **A pane of several controls making up one value** (a recurrence rule, a counter's reward) is transactional the same way, via `ui/common/FieldEditor.tsx`'s `GroupEditor`: one draft, one Save, so ticking three weekdays is one document change and one undo step rather than three. **The exceptions that still auto-save on blur/change**, and keep Back, are dropdowns — picking from a menu is already the deliberate gesture a Save button would add — and the calendar event editor's *When* and *Repeat* panes, not yet converted. Only editors that still have such a pane pass `flushOnClose`.
- **`initialDetailId`** opens a brand-new item straight in its title pane, which is what makes Enter-to-add-another a continuous flow (Tasks/Counters). Enter is that pane's Save; the editor clears its title state *before* `onAddAnother` swaps the uid, since the keyed `FieldEditor` remount would otherwise re-seed from the old title.
- **Grouped rows** (`presenceIds`) collapse interdependent fields that would otherwise pop in and out of the list: the event editor's *When* (date/all-day/time/duration) and *Repeat* (the whole RRULE).
- **Escape pops detail→list**, and only closes from the list — via `Sheet`'s `onEscape` hook, which also skips an Escape an open `md-menu` already handled.
- **Presence** shows at both levels: a dot in the row's trailing slot and beside the field title in the detail pane, with the affected UI greyed to 0.5 but never disabled.
- Destructive/secondary actions are `SheetActionItem` rows (error-toned `md-list-item`), not buttons. Renaming anything goes through `ui/common/RenameSheet.tsx`, never `window.prompt`.

### Presence System

`src/client/ui/common/presence.tsx` provides real-time peer awareness using Automerge's native Presence API. All editors share a unified `PresenceState` type: `{ viewing: boolean, focusedField: (string | number)[] | null, userGroupId?: string }`. The focused field path encodes what a peer is editing (e.g., `['events', uid, 'title']`). Each `PresenceState` key is broadcast as its own channel and **encrypted with the document's keyhive key** in the worker, so the ephemeral channel (plaintext on the wire) never leaks what a peer is viewing/editing.

**Peer identity.** A peerId is per-*device* (`<base64-device-verifying-key>-drive`), but friends and the local user's own name are stored keyed by **user-group id** (the `friends` map in the DriveSettings doc, cached by `src/client/ui/friend-names.ts`). So the worker advertises the sender's `userGroupId` inside the presence payload (the peerId itself cannot be the group id — it is bridge-generated and must decode to a 32-byte keyhive `Identifier`). `peerIdentityKey(peerId, userGroupId)` returns the group id when present (else the device agentId); `peerDisplayName` / `peerColor` key off it, so a friend resolves to their saved name and a user's multiple devices collapse to one identity/color. Consumers that only have bare repo peerIds (e.g. Home's document list) have no presence payload and fall back to the per-device agentId.

### Sync & Networking

The Automerge repo runs inside a **dedicated Web Worker** (`src/client/worker/automerge-worker.ts`); the main thread talks to it through `src/client/ui/worker-api.ts` (request/response by numeric `id`, plus fire-and-forget pushes and subscription callbacks). Keyhive provides end-to-end encryption by wrapping a **single** `NetworkAdapter`, so all transport multiplexing happens *below* keyhive and is invisible to it (same peerIds, same messages, same sync state).

Transport, from the bottom up:

- **Relay (default).** `src/relay/relay.ts` is a stateless WebSocket relay (also embedded in `serve.ts` / dev via `relay-plugin.ts`) that routes opaque encrypted bytes by `targetId`. Discovery is **watch-scoped, not broadcast**: after joining, each client sends a `RELAY_WATCH` declaration — its own keyhive user-group id plus the group ids it knows (friends + doc co-members, recomputed by the engine's `refreshRelayWatch`) — and the relay introduces two sockets only when they announce the same group (one user's devices) or when each watches the other's group (mutual friends). Un-friending withdraws the match and the relay dissolves the pair; strangers sharing a relay never learn of each other. Group ids are self-asserted routing hints — the `WebSocketRelay` doc comment records the resulting limits and the planned HMAC-token upgrade. The relay identifies itself with the all-zero `RELAY_PEER_ID` (`src/shared/relay-identity.ts`) and is never a keyhive member.
- **Direct WebRTC (opportunistic upgrade).** `src/shared/webrtc-relay-adapter.ts` is the single adapter handed to keyhive: it wraps the relay adapter and, per peer, routes that peer's sync over a direct `RTCDataChannel` once one is open, falling back to the relay otherwise. It drives a bridge over a `MessagePort`; the negotiation/retry/chunking logic lives in `src/shared/webrtc-bridge-core.ts` with the RTC implementation injected. In the **browser**, `RTCPeerConnection` is window-only, so the peer connections live on the **main thread** in `src/client/ui/webrtc-bridge.ts`, connected to the worker over the port (same pattern as the HyperFormula bridge). In the **CLI**, one process owns everything: the port pair is in-process and the RTC stack is werift (pure TypeScript — `src/cli/werift-rtc.ts` + `webrtc-node-bridge.ts`). STUN-only by default (no TURN — symmetric-NAT peers stay on the relay); override ICE servers with `VITE_ICE_SERVERS` (browser, build-time) / `DRIVE_ICE_SERVERS` (CLI, runtime). The bridge retries a stalled negotiation a few times, then leaves that peer on the relay.
- **Relay overlay frames.** Two protocols ride the relay socket alongside the automerge-repo protocol and are intercepted client-side before reaching the repo (`src/shared/relay-overlay.ts` — the intercept and the raw-socket frame sender, shared by the browser worker and the CLI): WebRTC signaling (`WRTC_SIGNAL`, `src/shared/webrtc-signal.ts`) carrying SDP/ICE, and the encrypted **rendezvous** channel (`RDV_*`, `src/shared/rendezvous-protocol.ts`) used for QR friend/device exchange. A third frame, `RELAY_WATCH` (`src/shared/relay-identity.ts`), flows client→relay only: the discovery declaration, re-sent on every socket (re)open and roster change.

Per-peer transport is surfaced to the UI via the worker's `p2p-status` message → `usePeerTransports()`; the shared `PeerDot` (`src/client/ui/common/presence.tsx`) renders a **filled** dot for a direct channel and a **hollow ring** (the default) for relay, so a relayed connection is never mistaken for P2P.

### Tabs & the single engine

**There may only ever be one engine per device**, and it is a hard constraint, not a preference. The keyhive archive is a single fixed IndexedDB key (`sha256(peerIdSuffix)`, and the suffix is pinned to `'drive'`) written as a *whole-state snapshot*, and CGKA leaf secrets live only in WASM memory plus that snapshot — so two instances silently destroy each other's key material. All tabs also share one peerId, which the relay's duplicate-join rejection would reduce to one socket anyway.

So the engine is per *device*, not per tab. The tab that wins the `drive-tab-leader` Web Lock (`ui/multi-tab.ts`) boots the Worker and runs `ui/tab-router.ts`; every other tab forwards the same worker protocol to it over a `BroadcastChannel` (`ui/tab-transport.ts`, envelopes in `client/shared/tab-channel.ts`). `SharedWorker` is deliberately **not** used — Chrome for Android has none, and module-type SharedWorker is explicitly excluded there.

The seam is `WorkerClient`, which depends on nothing but `postMessage`: `worker-api.ts` is handed a `WorkerTransport` and is unaware which case it got. Nothing in `src/shared/drive-engine.ts` or the worker shell knows tabs exist — the router earns that by fixing up what is per-client:

- **ids.** Every `WorkerClient` mints request ids and subIds from 1, so two tabs both send `id: 1`. The router rewrites them to globally-unique ids inbound and restores each client's own outbound.
- **doc-scoped subscriptions.** `subscribe-presence` / `-validation` carry no id, so they are refcounted across clients (first subscribe and last unsubscribe only) and deliveries fan out; a client that subscribes second is caught up from the router's cached delivery, since the engine only re-announces on a subscribe it actually receives. `subscribe-cursors` forwards the *union* of every tab's caret tokens, because the engine stores them wholesale per docId+path.
- **outbound routing.** `result`/`query-result`/`open-doc-progress` unicast by id; presence/validation by doc-sub set; `kh-rdv-event` by the rendezvous its tab created; everything else broadcasts. Sticky broadcasts are replayed to a tab joining a warm leader (`peer-connected`/`-disconnected` share one slot so a stale disconnect can't look newest).

Consequences worth knowing:

- **A `MessagePort` cannot cross a `BroadcastChannel`.** Only the leader bridges WebRTC (`transport.onLeader`), and the HyperFormula worker no longer gets a port into the engine — `doc-plugins/datagrid/hf-bridge.ts` proxies its `subscribe-query`/`unsubscribe-query` through `subscribeQuery` instead.
- **A change of leader reloads the other tabs.** A follower's ids and subscriptions live in the leader's router; when it disappears there is nothing to re-bind them to. Closing a *follower* costs nothing.
- **Version pinning is engine state**, so a history-pinned view in one tab pins that doc in all of them.
- **Presence is one state per device** (one peerId, one `Presence`), so `useFocusPathSync` only broadcasts from a *visible* tab and re-asserts on becoming visible.
- A backgrounded leader that the browser freezes pauses sync for followers until it is revisited. Not corrupting — a frozen tab's worker is suspended too.

### Routing

`src/client/ui/App.tsx` defines hash routes via preact-router (custom `hashHistory`). Document URLs are **type-free**: `#/d/<docId>` for every doc type — the document's `@type` selects the view (see `DocRoute`), never the URL.

- `#/` → Home (document list)
- `#/d/:docId` → the editor for that document's `@type`
- `#/d/:docId/share` → Sharing screen (members, roles, invites)
- `#/source/:docId` → Raw JSON document inspector
- `#/settings`, `#/friends`, `#/add-friend/:token`, `#/link-device/:token` (a rendezvous `r.<id>.<key>` token — the contact bundle never rides the URL)

Routes are ranked by segment specificity, not JSX order, so the static `/d/:docId/share` wins over `DocRoute`'s `/d/:docId/:rest*`. Build doc URLs with the helpers in `src/client/ui/common/doc-urls.ts` (`docUrl`, `shareUrl`, `sourceUrl`) rather than string concatenation.

**Transient state never goes in the URL.** `<rest>` carries only real navigation (e.g. the DataGrid's `sheets/<sheetId>`, pushed via `pushDocHash` so Back moves between sheets). The focused field / selected cell is broadcast as presence by `useFocusPathSync` and is deliberately *not* mirrored into the hash.

### CalDAV

The backend implements CalDAV (RFC 4791) at `/dav/`. `src/bitrot-caldav/parser.ts` converts ICS→JMAP and `src/bitrot-caldav/serializer.ts` converts JMAP→ICS, enabling standard calendar clients to sync.

## Testing

**Playwright is reserved for tests that need two browsers/tabs (or a genuinely browser-only runtime); single-browser tests belong in Jest (jsdom).**

- **Jest** (`jest.config.js`; `*.test.ts` = node project, `*.test.tsx` = jsdom `ui` project): unit + UI component/container tests. Editor containers (Tasks, Counters, …) run in jsdom via `jest.mock('../../worker-api')` (two levels up from a `doc-plugins/<type>/` dir), which picks up `src/client/ui/__mocks__/worker-api.ts` (Jest finds it only because that `__mocks__/` sits directly beside `worker-api.ts`; the containers assert `__isMock` so a drift fails loudly) — it backs `subscribeQuery`/`updateDoc` with an in-memory doc projected through the real jq engine (`src/shared/jq.ts`) and stubs the rest. Seed with `__setDoc(id, doc)`; assert store state with `__getDoc(id)`; reset in `beforeEach` with `__reset()`. It projects against a **clone** so each result has fresh refs (else `setState` bails on `Object.is` and nothing re-renders). `common/keyhive-api` re-exports worker-api, so this one mock also covers access/presence. Components that read `Temporal` need `import 'temporal-polyfill/global'` first.

**Material form fields.** The `md-*` custom elements are registered only in `main.tsx`, so under jsdom they never upgrade — which is why editor tests work at all (rows are inert hosts, handlers still fire). A raw `md-outlined-text-field` would break them outright: testing-library's `fireEvent.input` needs a `value` *setter* and throws without one. So use the two-mode wrappers `components/ui/md-text-field.tsx` and `md-select.tsx`, which fall back to a real `input`/`textarea`/`select` when the element isn't defined. Bind `input`, never `change` — preact/compat rewrites `onChange` to an input listener on form elements. The `MdSelect` fallback is a native `<select>`, so selects *can* now be driven in jsdom with `fireEvent.input`.
- **Playwright** (`src/client/tests-pw/`): two-peer sync (`support/peer.ts`, `window.__drive`), multiple tabs sharing one engine (`multi-tab-edit.spec.ts` — real Web Locks + a real BroadcastChannel; the routing rules themselves are unit-tested in `tests/tab-router.test.ts`), real-worker/IndexedDB behavior, and heavy browser-only rendering (schedule-x calendar, HyperFormula datagrid).

**The Playwright port is auto-detected.** These specs run against the *built* app (`dist/`) served by the production server, and `reuseExistingServer` is on locally — so a server already listening makes Playwright skip the build and test a stale `dist/`, which invents convincing failures. With no `PW_PORT`, `playwright.config.ts` probes for a port nothing is listening on, so there is nothing to reuse and every run rebuilds. Reusing a pre-built server is now the explicit opt-in: `PORT=4445 npm start` in one shell (after a build), then `PW_PORT=4445 npm run test:pw`.

**Throwaway files are named `tmp-*`** (gitignored — the repo auto-commits everything else). That covers one-off node scripts (`tmp-codemod.mjs`), scratch data, and verification specs: a probe spec is `tmp-<name>.probe.spec.ts`, which still ends in `.spec.ts` so Playwright's default `testMatch` discovers and runs it.

## Key Conventions

- Use `deepAssign()` (from `src/shared/deep-assign.ts`) when patching nested properties inside `handle.change()` — it recursively merges without overwriting sibling fields
- Automerge document mutations must happen inside `handle.change()` callbacks
- Client imports use the `@/` path alias (maps to `src/client/ui/`); `@client/` maps to `src/client/` for the rare reach into `shared/` or `worker/`
- UI components in `src/client/ui/components/ui/` follow shadcn/radix-ui patterns
- The Vite config has a custom `radixPreactPatchPlugin` to fix a Radix UI compat issue with Preact's ref handling
- When an error or bug occurs, create a test that reproduces the error first. Then focus on fixing it.

## Logging

App code logs through **`src/shared/logger.ts`**, never bare `console.*`:

```ts
const log = createLogger('engine');   // the logger owns the `[engine]` tag
log.warn('import-backup: skipping', label, errMsg(err));
```

Levels: `silent < error < warn < info < debug`, default `info`, set by `LOG_LEVEL` (and `LOG_NS` per namespace). **Per-message firehoses are `debug`** (`→ send`, `← recv`, the relay's routed-message log), lifecycle lines are `info`. Guard expensive or fallible message-building with `log.enabled('debug')` — the relay's `describe-message.ts` decodes CBOR and hashes payloads, so it must not run when the line would be discarded.

`console.*` in `src/**` is for **temporary local debugging only**, and `tests/no-raw-console.test.ts` enforces that (there is no ESLint in this repo). The two allowed exceptions both *intercept* console and so can't route through the logger: `logger.ts`'s own sink, and `automerge-worker.ts`'s filter for the third-party keyhive bridge's firehose.

`setLogLevel('debug')` is wired from the **Settings → debug** toggle in two places, because each thread is its own module graph: `DriveEngine.init()` (worker, CLI, CalDAV — reads it via `host.kv`, so `src/shared` never imports the browser's storage) and `ui/log-config.ts` (main thread, which must stay the *first* relative import in `main.tsx`).

**In tests** `jest.config.js` pins `LOG_LEVEL=error`, so the suite shows assertions and failures rather than app chatter. `error` deliberately still prints, so an *unexpected* failure is visible; a test that provokes an expected one claims it with `captureConsole(['error'])` from `tests/support/console.ts` **plus an assertion on the message** — a silent swallow also passes when the error stops happening. Un-gateable third-party output (automerge-repo, subduction, jsdom's missing navigation) is filtered by the narrow allowlist in `tests/support/benign-logs.ts`. Escape hatches: `LOG_LEVEL=debug npx jest …` restores everything, `LOG_NS=engine:debug` narrows it, `TEST_LOG=1` disables the third-party filter.

Note that **Jest only prints console output in `--verbose` mode**, and it turns verbose on automatically when exactly one test file runs — so a single-file run is where logging noise shows up, and where to check that it's gone.

## Environment Variables

- `PORT` — Server port (default 3000)
- `AUTOMERGE_DATA_DIR` — Persistent storage directory (default `.data`)
- `NODE_ENV=production` — Serves the built frontend
- `LOG_LEVEL` — `silent|error|warn|info|debug` (default `info`). See Logging.
- `LOG_NS` — per-namespace levels, e.g. `LOG_NS=engine:debug,relay:silent`
- `TEST_LOG=1` — (tests) disable the third-party log filter and the opt-in test diagnostics
- `VITE_ICE_SERVERS` — (frontend, build-time) JSON array of `RTCIceServer` for WebRTC. Defaults to public Google STUN; set this to add a TURN server. The CLI sibling is `DRIVE_ICE_SERVERS`.
- `DRIVE_ICE_SERVERS` — (CLI, runtime) same JSON shape as `VITE_ICE_SERVERS`, same defaults.
