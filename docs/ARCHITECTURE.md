# Automerge Drive — Architecture

A detailed, build-from-scratch specification of this project: a **local-first, end-to-end-encrypted collaborative document editor**. It captures the architecture, data model, build tooling, conventions, reusable components, and UI corner-cases in enough detail to reconstruct the system.

The product is a Preact PWA backed by **Automerge CRDTs** for conflict-free sync, **Keyhive** for cryptographic access control, an **Express** relay backend, and three document editors: **Calendar**, **TaskList**, and **DataGrid**. An optional CalDAV server (§3a) lets standard calendar clients sync Calendar docs.

---

## 1. High-Level Architecture

Three source trees, two TypeScript projects:

| Tree | Role | TS project | Module system |
|------|------|-----------|---------------|
| `src/relay/` | WebSocket relay + production web/SPA host + Vite dev plugin | `tsconfig.json` | CommonJS → `dist/` |
| `src/bitrot-caldav/` | CalDAV server (§3a): RFC 4791 handler, `/dav` routes, ICS↔JMAP | `tsconfig.json` | CommonJS → `dist/` |
| `src/cli/` | Headless drive peer (`npm run cli`) + Node KVStore/WASM shim | `tsconfig.json` | CommonJS → `dist/` |
| `src/client/` | Browser, split by thread: `ui/` (Preact SPA), `worker/` (Automerge repo + Keyhive crypto), `shared/` (both threads), `assets/` | `tsconfig.client.json` | ESNext, `noEmit` (Vite bundles) |
| `src/shared/` | Schema DSL, deep-assign, jq, relay identity, rendezvous protocol | both | — |

**Key separation of concerns:** the entire Automerge repo + Keyhive crypto lives in a **Web Worker** (`automerge-worker.ts`). The main thread never holds a full document — it issues queries (jq filters) and mutations through `worker-api.ts`. This keeps the UI thread responsive and isolates WASM-heavy work.

**Identity model:** documents have **no stored ID field**. Identity = the Automerge repo handle's `documentId`. Document type is dispatched on a `@type` discriminator (`"Calendar" | "TaskList" | "DataGrid"`).

**CRDT design rule:** collections are **Maps, not Arrays** (`Record<string, Item>`) so concurrent inserts never collide on an index. Events keyed by UID, tasks by id, cells by `"R:C"`.

---

## 2. Document Model (JSCalendar / RFC 8984-derived)

Schema cores live under `src/shared/schemas/` — `calendar.ts`, `tasks.ts`, `datagrid.ts`, `counters.ts`, `sentences.ts`, `drive-settings.ts` — so the worker and the Node programs can validate without pulling in Preact. The UI half of each plugin (`plugin.tsx` + views) stays in `src/client/ui/doc-plugins/<type>/`.

### Calendar
```ts
interface CalendarDocument {
  '@type': 'Calendar';
  name: string; description?; color?; timeZone?;
  events: Record<string, CalendarEvent>;   // UID → event
}
interface CalendarEvent {
  '@type': 'Event';
  title?; description?; location?; start?: LocalDateTime; duration?: Duration; // ISO "PT1H"
  timeZone?: string | null; status?: 'confirmed'|'cancelled'|'tentative';
  recurrenceRule?: RecurrenceRule;                          // SINGLE rule, not array
  recurrenceOverrides?: Record<string, PatchObject>;        // date → partial patch
  recurrenceId?: LocalDateTime; participants?; alerts?; links?; virtualLocations?;
}
```
`RecurrenceRule` is an RFC-5545 subset: `frequency`, `interval`, `byDay` (`{day,nthOfPeriod?}`), `byMonthDay`, `byMonth`, `count`, `until`.

### TaskList
```ts
interface TaskDocument { '@type':'TaskList'; name; tasks: Record<string,Task>; }
interface Task {
  '@type':'Task'; title?; description?; start?; due?; estimatedDuration?;
  progress?: 'needs-action'|'in-process'|'completed'|'failed'|'cancelled';
  percentComplete?; priority?;
}
```

### DataGrid (multi-sheet workbook)
```ts
interface DataGridDocument { '@type':'DataGrid'; name; sheets: Record<string,Sheet>; }
interface Sheet {
  '@type':'Sheet'; name; index; hidden?;
  columns: Record<string,Column>; rows: Record<string,Row>;
  cells: Record<string, {value:string}>;     // "R1C1" key; formulas stored as "=..."
  formats?; conditionalFormats?;
}
```

---

## 3. Node programs (`src/relay/`, `src/bitrot-caldav/`, `src/cli/`)

| File | Responsibility |
|------|----------------|
| `serve.ts` | Production web server: serves `dist/` SPA (fallback to `index.html`), upgrades HTTP→WS for relay, binds `PORT` (3000) |
| `relay-server.ts` | Standalone stateless relay process (Heroku Procfile default) + HTTP health check |
| `relay.ts` | `WebSocketRelay` — identity-based message router |
| `doc-store.ts` | `listByType()`, `getHandle()`, `getHeadsHash()` (heads hash usable as a sync token/ETag) |

CalDAV is an **optional** add-on server, documented separately below in **§3a**.

**Relay protocol:** stateless identity router. Client `join` (peerId + protocol versions) → relay acks with `peer` (relay identity = `RELAY_PEER_ID`) → mutual peer discovery → messages unicast by `targetId` or broadcast. Wire format **CBOR** (`cbor-x`). Large payloads (contact bundles) use an **encrypted rendezvous**: random `rendezvousId`+symmetric `key` encoded in a QR; relay routes opaque encrypted bytes between subscribers (`rdv-sub/unsub/msg/peer` frames in `src/shared/rendezvous-protocol.ts`).

`RELAY_PEER_ID` = base64 of 32 zero bytes — a valid ed25519 point that is deliberately **not** a real keyhive public id, satisfying automerge-repo's handshake without granting public access.

---

## 3a. CalDAV Server (Optional Component)

> The CalDAV server is **optional** — the editor, sync, and sharing all work without it. It exists to let standard calendar clients (Apple Calendar, Thunderbird, etc.) read/write Calendar documents over RFC 4791. It runs as its **own process** (`npm run start:caldav` / `dev:caldav` / `serve:caldav`) on `CALDAV_PORT` (default 3001, prod 4001) and joins the same relay/keyhive mesh as a peer. Skip this entire section if reproducing only the web app.

| File | Responsibility |
|------|----------------|
| `caldav-server.ts` | CalDAV + Keyhive-enabled Repo; bootstraps relay→keyhive→Repo (in order, to avoid circular deps); falls back to a plain Repo if keyhive init fails; binds `CALDAV_PORT` |
| `caldav-handler.ts` | `CalDAVHandler` class — RFC 4791 methods: event-level GET/PUT/DELETE/PROPFIND/OPTIONS and calendar-level GET/PUT/DELETE/PROPFIND/REPORT/MKCALENDAR/OPTIONS + root collection |
| `caldav-keyhive.ts` | `initCaldavKeyhive(dataDir, wsUrl)` — server participates as a single Individual identity (no user-group); gains document access when shared with directly as a member; wraps the keyhive bridge for `KeyhiveOps` with no-op user-group side-effects |
| `parser.ts` | ICS→JMAP via `ical.js`: `icsToEvent()` groups VEVENTs by UID and merges RECURRENCE-ID exceptions into `recurrenceOverrides` as computed patches |
| `serializer.ts` | JMAP→ICS: `eventToICS()`, `calendarToIcs()`, `generateEtag()`; emits one VEVENT per recurrence override |
| `routes/dav.ts` | CalDAV routes: `.well-known/caldav` discovery, event-level `/dav/cal/:cal/:evt.ics`, calendar-level `/dav/cal/:cal/`, root collection `/dav/cal/` |
| `routes/admin.ts` | `createAdminRoutes(getCaldavKeyhive)` — inspection only: `GET /admin/caldav` HTML dashboard (identity + claimed documents), `GET /admin/caldav-identity` (device id JSON) |

**Sync semantics:** the Automerge **heads hash** (`getHeadsHash()` in `doc-store.ts`) is reused as the CalDAV ETag and `REPORT` sync token. **PUT** parses ICS → if the event exists, patches it with `deepAssign()` inside `handle.change()`, else assigns `d.events[uid]` directly. The server obtains access to a document by being added as a member through normal direct-contact sharing (the prior invite-payload claim endpoint was removed — see §5).

**Note:** `parser.ts`/`serializer.ts` also back ICS *import/export* in the web client, so they're worth keeping even if the CalDAV server itself is not deployed.

---

## 4. Shared Layer (`src/shared/`)

### Schema DSL (`schemas/core.ts`)
Functional builders returning `SchemaNode`:
```ts
str({enum?,pattern?,optional?}); num({min?,max?,integer?,optional?});
bool({literal?,optional?}); obj(props,{optional?}); record(valueSchema,{optional?});
union(schemas,{optional?}); arr(items,{optional?});
validateNode(value, schema, path, errors): void   // depth-first, accumulates ValidationError[]
```
`ValidationError = { path:(string|number)[]; message; kind?:'schema'|'dependency'|'warning' }`. Objects warn on unknown keys; records allow any string key; unions pick the candidate with the shortest error list.

`schemas/index.ts` → `validateDocument(doc)` dispatches on `doc['@type']` to `{schema, checkDeps}` per type. Each type has a structural schema **and** a dependency checker for cross-field invariants.

### Other shared utilities
- `deep-assign.ts` — `deepAssign(target, source)` recursively merges in-place **without overwriting siblings**; deletes keys absent from source; `categories` always replaced. Used inside `handle.change()`.
- `sync-to-target.ts` — `syncToTarget(d, target)` patches an Automerge proxy to match a snapshot.
- `jq.ts` — jq query interpreter used for worker→main document slices.
- `relay-identity.ts`, `rendezvous-protocol.ts` — see §3.

---

## 5. Keyhive Integration (access control + E2E encryption)

- `keyhive-ops.ts` — `KeyhiveOps` class. Identity/friends (`getIdentity`, `getContactCard`, `receiveContactCard`), **user groups** (multi-device "users": `ensureUserGroup`, `listGroupDevices`, `addDeviceToGroup`, `linkDevice`), **document access** (`getDocMembers` → `{ members }`, `getMyAccess`, `addMember`, `revokeMember`, `changeMemberRole`). Side-effects (persist, sync, registerDoc, etc.) are **injected** so the same class runs in the worker and on the CalDAV server.
- **Invite links removed (commit c704720):** the URL-based invite flow — `generateInvite`/`claimInvite`/`dismissInvite`, the `/invite/...` routes + `InvitePage`, the `invite-codec`/`invite-storage` modules, and the CalDAV `claim-invite` endpoint — was deleted. The earlier known problem (a link-claimed doc attached the claimant's *individual device* rather than their user-group, so it never appeared on the home page) is now moot. **Sharing is exclusively direct-contact (user-group) sharing via `addMember`**, which grants the recipient's user-group and therefore shows up correctly in their doc list. `getDocMembers` consequently returns only `{ members }` (no `invites`).
- Roles (per recent rename): `read` / `edit` / `admin` (formerly write→edit, pull→relay).
- **Contact bundle** envelope (`{__kind:'contact-bundle', card, groupId?, groupEvents?}`) is exchanged over the QR rendezvous.
- Package: official `@automerge/automerge-repo-keyhive` (subduction.37), with `@keyhive/keyhive` pinned to a **GitHub release tarball** via npm `overrides` (drive-86a218c).
- **Revocation caveat:** revoking a peer never notifies that peer (keyhive sync design). The home page lists docs by user-group access; "delete" = remove-me-from-doc (revoke own user-group).
- **Keyhive WASM is non-reentrant:** overlapping calls (one suspended at an `await` while another runs) trap with `unreachable executed`. The bridge serializes its own calls (blob/sign/sync) through a shared `PromiseQueue` (`keyhiveQueue`); the worker routes everything else through it too — the `keyhive` instance handed to `KeyhiveOps` is wrapped in a `serializeKeyhive()` Proxy (per-method, so polling loops like `waitForGroup` release the lock), and stray callers (`bestAccessForDoc`, persist, init dump) use `runOnKeyhiveQueue()`. Needed once presence (§6) added high-frequency encrypt/decrypt.

---

## 6. Frontend (`src/client/ui/`, `src/client/worker/`)

### Bootstrap & routing
- Entry `main.tsx`: imports `temporal-polyfill/global`, `globals.css`, renders `<App/>` into `#app`, imports `test-bridge` (exposes `window.__drive` — **always**, even in prod, for Playwright).
- `App.tsx` (preact-router, **hash history** via `hash-history.ts`). Routes: `/`, `/settings`, `/friends`, `/link-device/:cardData`, `/add-friend/:cardData`, `/calendars/` (AllCalendars), `/calendars/:docId(/:rest*)`, `/tasks/:docId(/:rest*)`, `/datagrids/:docId/sheets/:sheetId/:rest*`, `/source/:docId/:rest*`, plus `/view/...` read-only variants of each editor.
- `rest*` wildcard encodes a **focus path** in the URL (e.g. `/calendars/{id}/events/{uid}/title` → `['events',uid,'title']`), synced bidirectionally with presence broadcast and `history.replaceState`.

### Worker API (`worker-api.ts`)
`createDoc(initialJson)`, `openDoc(docId,{onProgress})` (ensures synced before editor mounts via `DocLoader`), `subscribeQuery(docId, jqFilter, cb)`, `updateDoc(docId, mutationFn, ...args)`, `subscribePresence`, `setPresence`. Mutations: the worker substitutes its own `deepAssign` for a marker arg, so editors call `updateDoc(id, (d, deepAssign, uid, data)=>{...}, deepAssign, uid, data)`.

### Tabs & the single engine (`tab-transport.ts`, `tab-router.ts`, `multi-tab.ts`)
The engine is per **device**, not per tab — the keyhive archive is one fixed IndexedDB key written as a whole-state snapshot, so two instances destroy each other's CGKA key material. The tab holding the `drive-tab-leader` Web Lock boots the Worker and routes for the others over a `BroadcastChannel`; `WorkerClient` needs only `postMessage`, so `worker-api.ts` is unaware which side it is on. Not `SharedWorker`: Chrome for Android has none. The router namespaces per-tab request/subscription ids, refcounts the doc-scoped subscriptions, unions cursor tokens, and replays sticky broadcasts to a joining tab. A `MessagePort` cannot cross the bus, so only the leader bridges WebRTC and the HyperFormula worker proxies its queries through the main thread. A leader change reloads the other tabs. Full detail in CLAUDE.md § Tabs & the single engine.

### Editors
- **Calendar** (`calendar/`): schedule-x v4 grid. `calendarQuery(start,end)` returns events in a ±1-month-buffered range; `rebuildExpanded()` expands recurrence via `recurrence.ts#generateDates()` (Temporal API: daily/weekly+byDay/monthly/yearly, interval/count/until/bySetPos); `mapToSXEvents()` → schedule-x. `EventEditor` modal maps field ids (`ed-title`) to jq paths; recurrence radio + byDay checkboxes + end-type picker; "Edit this occurrence" vs "Edit all" (override stored as patch in `recurrenceOverrides[date]`). Drag-drop (`drag-drop.ts`) patches `start`. `AllCalendars` merges many calendars into one grid with cross-calendar drag.
- **Tasks** (`tasks/`): quick-add on Enter; `sortedTasks()` puts incomplete-by-due first, completed/cancelled at bottom; checkbox toggles progress; `TaskEditor` modal; batch `deleteCompleted()`. Home summary jq counts non-complete tasks.
- **DataGrid** (`datagrid/`): multi-sheet spreadsheet — see the dedicated **§9 DataGrid Appendix** below for the full reproduction spec (storage, formatting, formulas, interaction/intent model). Headline: **HyperFormula** in a dedicated worker, frozen rows/cols, hidden ranges, range-overlay cell formatting, conditional formatting, autofill, Monte-Carlo distributions, XLSX (ExcelJS) / ICS / JSON import, command bar, bottom sheet tabs.
- **Source** (`source/`): CodeMirror tree editor (read-write only at latest version), **history slider** (pin any version, mutations blocked unless at head), validation panel (click error → navigate), patch table, presence log, live jq panel, clipboard inspector.
- **Home** (`home/`): doc list from `doc-storage.ts` (localStorage cache, keyed by keyhive access); per-doc `HOME_SUMMARY_QUERY` (name/type/count) + async per-doc access badge (read/edit/admin via `AccessIcon`, resolved through the `useAccess` hook in `shared/useAccess.ts`); revoked docs sink to bottom; create (Calendar/TaskList/DataGrid prompts), import XLSX/ICS/JSON, `beforeinstallprompt` PWA install button, connection-status dot, relay log.

> **Cache model (in-progress, uncommitted):** `idb-storage.ts` now hosts a small persisted settings store (`settingGet/Set`, sync `settingGetSync/SetSync`) with a `cache-disabled` flag exposed as `isCacheDisabled()`. When set, the localStorage caches are bypassed: `doc-storage.ts` returns empty and callers fetch the doc list live from the worker (`fetchDocList`), and `useAccess` skips the access cache and resolves from the worker. `Settings.tsx` adds a toggle (`setCacheDisabled`, persists → notifies worker → reloads the page) plus a "clear all caches" action (`clearAllCaches`); `worker-api.ts` clears the `keyhive-access-cache` localStorage key. Treat localStorage strictly as a cache — the worker is the source of truth.

### Presence (`shared/presence.tsx`)
`PresenceState = { viewing:boolean, focusedField:(string|number)[]|null }`. `initPresence(docId, getInitial, onPeers)` → `{broadcast, cleanup}`. `peerDisplayName(peerId)` (contact name or `id.slice(0,8)…`), `peerColor(peerId)` (stable hash into 8-color palette).

**`focusedField` is a path into the Automerge document data, not a reference to a UI/DOM node.** It is the same key path used to address the value in the doc — e.g. `['events', uid, 'title']`, `['tasks', uid, 'due']`, `['sheets', sheetId, 'cells', 'rowId:colId']` — so it is stable across peers regardless of each client's markup, layout, or screen size. Rendering is a purely local concern: each editor *maps* an incoming document path to whatever local element represents that value (an input id like `ed-title`, a list row, a grid cell) to draw the colored border/dot. A reimplementation with entirely different DOM can interoperate as long as it broadcasts and interprets the **same document paths**.

**Encrypted in the worker.** Presence rides Automerge **ephemeral messages** — relay-forwarded and **not** covered by document encryption — so the worker encrypts each channel *value* under the doc's keyhive key (`encryptPresenceValue`/`decryptPresenceValue` via `kh.tryEncrypt`/`tryDecrypt`; channel names like `viewing`/`focusedField` stay plaintext, values are ciphertext). The `Presence` instance lives in the worker; the main-thread `initPresence`/`subscribePresence`/`setPresence` carry only decrypted state, so the UI is unchanged. Round-trip is covered by `keyhive-ops.test.ts` and the `presence` Playwright spec. **Breaking wire-format change** vs. the earlier plaintext presence — all peers must run the encrypted build.

**Best-effort.** A peer lacking the doc's key (PCS key not yet synced, or private-browsing IndexedDB that can't retrieve its `SecretKey`) can't encrypt or decrypt presence. So presence **always starts** (empty initial state, so it can still receive), encryption never throws (`encryptPresenceValueOrNull` returns `null`), and a 5s retry re-attempts and self-stops once healthy (late keys recover automatically). Keyhive-capable peers exchange presence; keyless peers show nothing rather than crashing.

### Reusable UI (`components/ui/`, shadcn + Radix via preact/compat)
`button`, `input`, `textarea`, `label`, `checkbox`, `select`, `dropdown-menu`, `context-menu`, `sheet`, `alert`, `badge`, `toast`, `tooltip`, `progress`, `menubar`, `qr-code`. Custom: `EditableName`, `AccessIcon`, `AccessControl` (share dialog), `UpdateBanner` (PWA update). Styling = Tailwind v4 classes + Material Symbols icons; no CSS-in-JS.

---

## 7. Build & Tooling

- **Package:** `automerge-docs` v1.0.0, Node ≥22, CommonJS root.
- **Key deps:** `@automerge/automerge@3.3.0-fragments.1`, `automerge-repo@2.6.0-subduction.37` (+ websocket/messagechannel/indexeddb/nodefs adapters), `automerge-repo-keyhive@0.3.0-alpha.sub.7`, `automerge-subduction@0.16.0`, `@keyhive/keyhive` (GitHub tarball, pinned via `overrides`), `preact@10`, `preact-router`, `@preact/signals`, `tailwindcss@4` + `@tailwindcss/vite`, Radix UI suite, `@schedule-x/*@4`, `@glideapps/glide-data-grid@6`, `hyperformula@3`, `ical.js@2`, `cbor-x`, `exceljs`, `qrcode`, `dayjs`, `temporal-polyfill@0.3`, `express@5`, `ws`, `multer`, `cors`. Dev: `vite@8`, `@preact/preset-vite`, `jest@30`+`ts-jest`, `@playwright/test`, `fake-indexeddb`, `supertest`, `ts-node`, `tsconfig-paths`, `typescript@6`.
- **vite.config.ts** custom plugins:
  1. `radixPreactPatchPlugin` — guards Radix `getComputedStyle(node)` with `node instanceof Element` (Preact compat ref fix).
  2. `automergeWasmPlugin` — replaces base64-inlined Automerge WASM with `fetch()` + `instantiateStreaming` (avoids ~2.4MB heap OOM).
  3. `keyhiveWasmPlugin` — manual keyhive WASM instantiation; stubs unused `symmetricEncrypt/Decrypt`.
  4. `automergeRepoReservedMethodOptimizePlugin` (Rolldown, during pre-bundle) — rewrites methods literally named `import()`/`export()` to `["import"]()` so Vite's import-analysis doesn't corrupt the chunk.
  5. `versionJsonPlugin` (build only) — emits `dist/version.json` (git SHA + timestamp).
  Plus `relayPlugin()` (attaches WS relay to dev server, skips `vite-hmr` protocol), `VitePWA` (autoUpdate, 5MB cache, navigate-fallback denylist for `/api /dav /automerge /docs`), `resolve.dedupe: [preact, @preact/signals, @preact/signals-core]`, `@/`→`src/client`, `root: 'src/client'`, `outDir: dist`, ES-format worker.
- **Preact preset** filters out the `transform-hook-names` plugin (zimmerframe resolution failure under Vite 8).
- **tsconfig.json** (node side): ES2022/CommonJS → `dist`, excludes `src/client`/`src/shared`. **tsconfig.client.json**: ES2020/ESNext, `moduleResolution: bundler`, `jsx: react-jsx` + `jsxImportSource: preact`, `react`/`react-dom`→`preact/compat`, `@/*`→`src/client/ui/*` and `@client/*`→`src/client/*`, `noEmit`.

### Scripts
`dev` (vite :3000, HMR :PORT+1), `build` (→dist), `start` (ts-node serve.ts), `start:relay`, `start:caldav`/`dev:caldav`/`serve:caldav`, `test` (jest+pw), `test:unit`, `test:watch`, `test:coverage`, `test:pw`, `test:pw:open`. Type-check: `npx tsc --noEmit` (backend) and `npx tsc -p tsconfig.client.json --noEmit` (frontend).

### Tests
- **Jest** two projects: `server` (node env, `.data-jest`, subduction WASM setup, shims keyhive/repo-keyhive) and `ui` (jsdom, `@testing-library/preact`, CSS mock). Specs in `tests/` (caldav, parser, snapshots) and `src/shared` (deep-assign, jq, relay-identity, schema), plus `src/client/ui/components/ui/components.test.tsx`. `tests/layering.test.ts` enforces the directory boundaries (src/shared ↛ src/client; client/ui ↮ client/worker).
- **Playwright** (`src/client/tests-pw/`): serial, 1 worker, builds+serves prod; **two isolated BrowserContexts** as peers, driven via `window.__drive` `peer.call(method,...)`. Only what jsdom genuinely cannot do (real keyhive identities over the relay, WebRTC, Web Locks, worker+IndexedDB across reload, computed style/layout, native Selection/Clipboard/touch, Lit shadow upgrade, schedule-x, CodeMirror): `ui/*` (calendar/datagrid/sentences/task-editor/dark-mode) + two-peer (`device-link`, `presence` — focused-field decrypt + late-joiner re-flush + heartbeat liveness, one shared boot, `revocation` — grant/revoke/archive, `sentences-peers`, `add-friend-ui`, `webrtc-direct`, `multi-tab-edit` — several tabs sharing the leader tab's single engine, `cache-disabled-create`). Coverage intentionally **not** wired (instrumented build too slow/flaky).

### Env vars
`PORT` (3000), `NODE_ENV=production` (no logging, serve dist), `AUTOMERGE_DATA_DIR` (`.data`), `CALDAV_PORT` (4001), `VITE_BASE_PATH` (subdir deploy). Deploy: Heroku Procfile → `start:relay`; standard prod → `build && start`.

---

## 8. Conventions & Corner-Cases (gotchas worth preserving)

- **Mutate only inside `handle.change()`**; use `deepAssign` for nested patches to avoid clobbering siblings.
- **No document ID field** — identity is the repo handle.
- **Maps over arrays** everywhere for CRDT safety.
- **Worker owns the doc**: main thread sees only jq query slices; never the full document.
- **Read-only** comes from either a `/view/...` route or keyhive access === `read`.
- **All-day events**: detected when `start.length <= 10` (date-only) → time picker hidden.
- **Recurrence**: single rule per event; per-occurrence edits become patches in `recurrenceOverrides[date]`; master+overrides merged at render time.
- **Version pinning** in Source blocks mutations until "Jump to Latest".
- **Reserved-word methods** (`import`/`export`) in automerge-repo require the Rolldown rewrite — don't remove it.
- **WASM is streamed, not base64-inlined** (the inline path OOMs Chromium during tests).
- **Revocation is silent** to the revoked peer (keyhive design).
- **`window.__drive` ships in production** by design (Playwright harness).
- **Keyhive WASM is non-reentrant** — all access goes through the shared `keyhiveQueue` (`serializeKeyhive` proxy + `runOnKeyhiveQueue`); overlapping calls trap `unreachable executed` (§5).
- **Presence is encrypted and best-effort** — ephemeral payloads aren't doc-encrypted, so the worker encrypts presence values under the doc key; a keyless peer shows nothing and never throws (§6).

---

## 9. DataGrid Appendix (reproduction detail)

The DataGrid is the most complex editor. This section is written so a reimplementation can keep the **data model and interaction intents** intact while freely re-skinning the input layer (touch, buttons, small screens). The rule of thumb: **storage and intent are normative; the literal key/mouse bindings are just one realization of an intent.**

Files: `datagrid/{schema,formatting,helpers,formula-parser,hf-bridge,hf-worker,commands,clipboard,DataGrid.tsx,FormulaEditor.tsx,CommandBar.tsx,CommandSearch.tsx,FormattingToolbar.tsx,SheetTabs.tsx,ConditionalFormatPanel.tsx,datagrid.css}`.

### 9.1 Storage model (normative)

Cells, rows, columns, and formats are all **stable-id-keyed maps** with a separate float `index` field for ordering — never array position. This is the CRDT-safety invariant: concurrent inserts/reorders never collide.

```ts
DataGridColumn { index:number; name:string; width?:number; hidden?:boolean; frozen?:boolean }
DataGridRow    { index:number; height?:number; hidden?:boolean; frozen?:boolean }
DataGridCell   { value:string }                  // formulas stored here, "=" prefix
Sheet { '@type':'Sheet'; name; index; hidden?;
        columns:Record<colId,Column>; rows:Record<rowId,Row>;
        cells:Record<"rowId:colId", Cell>;       // KEY = `${rowId}:${colId}`, colon-joined
        formats?:Record<id,FormatRange>;
        conditionalFormats?:Record<id,ConditionalFormatRule> }
```

- **Visual order** is derived by sorting entries on `index` (`sortedEntries()` in `helpers.ts`). Insert-between uses a fractional index (e.g. 1.5). Hidden/frozen are per-row/col flags, never per-cell.
- **A1 letters are display-only**: `colIndexToLetter()` / `letterToColIndex()` convert visual index ↔ "A","B",…,"AA". The doc never stores A1; it stores ids.

### 9.2 Static cell formatting — range overlays, not per-cell

Formatting is stored as **a set of rectangular ranges**, not attributes on each cell. This keeps the doc small and merges cleanly.

```ts
DataGridCellFormat { bold? italic? underline? strikethrough? fontFamily? fontSize?(1–400)
                     textColor? bgColor? hAlign?('left'|'center'|'right'|'justify')
                     vAlign?('top'|'middle'|'bottom') wrapText? numFmt?  // Excel codes
                     borderTop/Bottom/Left/Right?: {style?,color?} }
FormatRange { index:number; rangeRowStart; rangeRowEnd; rangeColStart; rangeColEnd;  // all ids, inclusive
              format:DataGridCellFormat }
```

**Effective format resolution** (`computeCellFormat()` in `formatting.ts`): convert range-endpoint ids to visual indices, keep ranges whose rectangle contains the cell, sort by `index` ascending, and `Object.assign`-merge in order so **later (higher-index) ranges win field-by-field**. Result → CSS via `formatToCss()`; number rendering via `formatDisplayValue()` (Excel format codes with `positive;negative;zero;text` sections, accounting/scientific detection).

When applying formatting to a selection, the writer coalesces same-format cells into rectangles rather than writing per-cell — keep this to avoid map bloat.

### 9.3 Conditional formatting

```ts
ConditionalFormatRule {
  index:number;
  ranges:Record<id,{rangeRowStart,rangeRowEnd,rangeColStart,rangeColEnd}>;  // multiple rects per rule
  conditionType: 'gt'|'lt'|'eq'|'neq'|'gte'|'lte'
               | 'textContains'|'textStartsWith'|'textEndsWith'
               | 'isEmpty'|'isNotEmpty'|'customFormula';
  conditionValue?: string;          // operand, or a formula for customFormula
  format: DataGridCellFormat;       // applied when the condition matches
}
```

Evaluation (`resolveConditionalFormat()` + `matchesCondition()` in `formatting.ts`): for a cell, find rules whose any-range contains it, sort by **descending index (higher = higher priority), first match wins**, and merge the matched rule's `format` on top of the static format. Numeric comparisons coerce via `Number()`; text comparisons are case-insensitive. `customFormula` rules are **not** evaluated on the main thread — they're computed in the HF worker (relative R1C1 re-anchored per target cell) and returned as a `condFormatResults.matches` map.

### 9.4 Formulas + HyperFormula worker

- **Canonical internal storage** uses id-based refs so formulas survive row/col reordering: `{R{rowId}C{colId}}` (absolute), `{R[rowId]C[colId]}` (relative), `{...S{sheetId}}` (cross-sheet), `{C{colId}}` / `{R{rowId}}` (whole col/row). The user **sees A1**; conversion at the edit/commit boundary via `a1ToInternal()` / `internalToA1()` (+ `internalToR1C1()`) in `helpers.ts`. `formula-parser.ts` tokenizes/AST-parses the internal form.
- **Compute lives in a separate HyperFormula worker** (`hf-worker.ts`) bridged over a MessageChannel (`hf-bridge.ts`, `HfBridge`). The worker holds one persistent HF instance per doc, subscribes (via jq) to the active sheet's cells plus any cross-sheet dependency sheets, rebuilds on change, and posts back: `computedValues` (`Map<"sheetId:rowId:colId", value>`), `spillTargets` (array-formula overflow cells, rendered read-only), `errors`, plus Monte-Carlo and conditional-format results.
- **Render** resolves each cell as: `getDisplayValue(computedValues, rawValue, …)` → static format (`computeCellFormat`) → conditional override (`resolveConditionalFormat`) → CSS (`formatToCss` + `formatDisplayValue`).
- **Deletion integrity**: deleting a row/col/sheet rewrites referencing formulas — single ref to a deleted id → `#REF!`; range endpoint → shrink to nearest survivor (`updateFormulasForDeletion()`, `rewriteFormulasForSheetDeletion()`).
- **Autofill**: `detectNumericPattern()` (constant/arithmetic) + `generateAutofillValues()`; filled formulas are re-anchored via R1C1 so they stay position-relative.

### 9.5 Selection & cursor model (normative state)

The component tracks selection independent of any input device — these state atoms are what a new UI must reproduce:

- `selectedCell:[col,row]|null` — the active cell (visual indices).
- `selectionAnchor:[col,row]|null` — with `selectedCell`, defines a normalized rectangle (`min/max` of the two corners).
- `selectedRows:Set<number>`, `selectedCols:Set<number>` — whole-row / whole-column selection (mutually exclusive with cell selection).
- `editingCell:[col,row]|null` + `editValue:string` — edit mode and its in-progress text (A1 form while editing).
- Selection is also encoded in the URL: `…/sheets/{sheetId}/cells/{rowId}:{colId}?anchor={rowId}:{colId}`, and the active cell's path is broadcast as presence `focusedField = ['sheets', sheetId, 'cells', 'rowId:colId']`.

### 9.6 Visual feedback (what must be conveyed, however you draw it)

Each state has a distinct visual treatment (currently CSS classes / inline styles in `datagrid.css`); a reimplementation must convey the same **distinctions**, by whatever means fits the screen:

- **Active cell** (`outline` accent), **in-range cells** (light fill), **active/selected row & col headers** (fill + an edge marker indicating the active line).
- **Peer editing**: inset colored border keyed to `peerColor(peerId)`; first peer to claim a cell wins (no flicker).
- **Formula-reference highlight while editing**: each referenced cell/range gets a rotating color from a fixed palette; the ref under the text cursor is emphasized; cross-sheet refs are syntax-highlighted but not grid-highlighted.
- **Autofill preview** (dashed ghost range), **spill targets** (computed, read-only), **distribution cells** (source vs dependent, with a μ/σ/percentile tooltip), **frozen boundary** (heavier divider after the last frozen row/col).

### 9.7 Interaction intents (remappable)

Keyboard/mouse are the current bindings; the **intent column is the contract**. For touch/small-screen/non-keyboard, map each intent to a button, gesture, or long-press menu.

| Intent | Current binding | Effect on state |
|--------|-----------------|-----------------|
| Move active cell | Arrows / click | set `selectedCell`, clear anchor, scroll into view |
| Extend selection | Shift+Arrow / Shift+click / drag | set `selectionAnchor` then move `selectedCell` |
| Select whole row/col | click header (+Shift range) | populate `selectedRows`/`selectedCols` |
| Select all | corner header | anchor = last cell, active = first |
| Begin edit (replace) | type a printable char | enter edit mode seeded with that char |
| Begin edit (keep) | Enter / F2 / double-click | enter edit mode with existing value (formula shown as A1) |
| Commit + advance down | Enter in editor | write cell, move down |
| Commit + advance right | Tab in editor | write cell, move right |
| Cancel edit | Escape | discard `editValue` (guarded blur race via a "cancelled" ref) |
| Clear contents | Delete / Backspace | clear value(s) across selection |
| Copy / Cut / Paste | Ctrl/Cmd+C/X/V | clipboard ref (TSV+HTML), `mode:'copy'|'cut'`; paste expands grid, re-anchors formulas, coalesces formats; external paste prefers the native `paste` event for synchronous `clipboardData` |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z·Y | document history; HF worker re-evaluates |
| Autofill | drag the fill handle | direction inferred from drag; series/pattern/repeat values written |
| Resize col / auto-fit | drag right edge / double-click edge | live `resizingCol`, commit width / measure-to-fit |
| Reorder row/col/sheet | drag header/tab (>5px threshold) | `dragRef`+`dropIndicator`; commit mutates `index` |
| Context actions | right-click cell/header/tab | `contextMenu={type,indices}`; insert/delete/move/format/rename/hide |
| Command palette | Ctrl+/ | searchable list of every command from all menus |
| Switch sheet | click tab | swap subscription + HF active sheet, clear selections |

**Command infrastructure** (`commands.ts`): every action is a `Command { id, defaultLabel, icon?, shortcuts?, isEnabled(state), toggle?, execute(state, ctx) }` rendered into **slots** (`edit-menu`, `insert-menu`, `format-menu`, `view-menu`, `toolbar`, `cell-ctx`, `row-ctx`, `col-ctx`, `sheet-ctx`). The toolbar, menubar, context menus, and Ctrl+/ palette are all just different presentations of the same registry — which is exactly what makes the UI retargetable: **a small-screen build can render the same commands as a bottom sheet or long-press menu without touching logic.** Mutations go through `ctx.mutate((doc, ...args) => …, args)` → `updateDoc()`.

`FormattingToolbar.tsx` supplies font family/size, text/bg color pickers, number-format presets (Automatic, Plain, Number, Integer, Accounting, Percent, Scientific, Date/Time/Datetime), and border presets (All/Outer/None/Top/Bottom/Left/Right, each `{style,color}`). `FormulaEditor.tsx` is a lazily-loaded CodeMirror with A1 display, function autocomplete (custom + HF built-ins), and the reference-highlight plugin; it backs both the in-cell overlay and the formula bar.

---

## Verification

To validate this document against the live tree:
- `npx tsc --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` — confirm both TS projects compile.
- `npm run test:unit` — exercises parser, schema DSL, deep-assign, jq, components.
- `npm run dev` then open `/`, create one of each doc type, confirm editors + presence.
- `npm run test:pw` — two-peer sync/sharing/rendezvous/revoke flows.
- Cross-check the document type definitions against `src/shared/schemas/{calendar,tasks,datagrid}.ts` and the schema DSL against `src/shared/schemas/core.ts`.
