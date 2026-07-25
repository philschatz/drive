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
npm run test:pw      # Playwright E2E (editor UI + two-peer sync specs)
npm run test:pw:open # Playwright UI mode
```

**Type checking** (two separate tsconfigs):

```bash
npx tsc --noEmit                          # Backend (src/backend/)
npx tsc -p tsconfig.client.json --noEmit  # Frontend (src/client/ + src/shared/)
```

**Run a single test file:**

```bash
npx jest tests/parser.test.ts
```

## Architecture

### Directory Layout

- `src/backend/` — Express server, CalDAV handler, ICS↔JMAP parser/serializer, REST routes
- `src/client/` — Preact SPA with feature directories: `calendar/`, `tasks/`, `datagrid/`, `source/`, `home/`
- `src/shared/` — Code shared between client features: automerge repo setup, presence system, schema validation, deep-assign utility
- `tests/` — Jest tests (backend + shared logic)
- `src/client/tests-pw/` — Playwright E2E tests (editor UI specs + two-peer sync harness)

### Two TypeScript Projects

- **`tsconfig.json`** — Backend only (`src/backend/`), CommonJS, compiles to `dist/`
- **`tsconfig.client.json`** — Frontend (`src/client/` + `src/shared/`), ESNext modules, noEmit (Vite handles bundling)

### Frontend Stack

- **Preact** (not React) with `@preact/preset-vite` for JSX. Radix UI components work via preact/compat aliases.
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin. Theme tokens in `src/client/globals.css`.
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

### Presence System

`src/client/shared/presence.tsx` provides real-time peer awareness using Automerge's native Presence API. All editors share a unified `PresenceState` type: `{ viewing: boolean, focusedField: (string | number)[] | null, userGroupId?: string }`. The focused field path encodes what a peer is editing (e.g., `['events', uid, 'title']`). Each `PresenceState` key is broadcast as its own channel and **encrypted with the document's keyhive key** in the worker, so the ephemeral channel (plaintext on the wire) never leaks what a peer is viewing/editing.

**Peer identity.** A peerId is per-*device* (`<base64-device-verifying-key>-drive`), but contacts and the local user's own name are stored keyed by **user-group id** (`contact-names` / `known-contact-groups`, see `src/client/contact-names.ts`). So the worker advertises the sender's `userGroupId` inside the presence payload (the peerId itself cannot be the group id — it is bridge-generated and must decode to a 32-byte keyhive `Identifier`). `peerIdentityKey(peerId, userGroupId)` returns the group id when present (else the device agentId); `peerDisplayName` / `peerColor` key off it, so a contact resolves to their saved name and a user's multiple devices collapse to one identity/color. Consumers that only have bare repo peerIds (e.g. Home's document list) have no presence payload and fall back to the per-device agentId.

### Sync & Networking

The Automerge repo runs inside a **dedicated Web Worker** (`src/client/automerge-worker.ts`); the main thread talks to it through `src/client/worker-api.ts` (request/response by numeric `id`, plus fire-and-forget pushes and subscription callbacks). Keyhive provides end-to-end encryption by wrapping a **single** `NetworkAdapter`, so all transport multiplexing happens *below* keyhive and is invisible to it (same peerIds, same messages, same sync state).

Transport, from the bottom up:

- **Relay (default).** `src/backend/relay.ts` is a stateless WebSocket relay (also embedded in `serve.ts` / dev via `relay-plugin.ts`) that does peer discovery and routes opaque encrypted bytes by `targetId`. It identifies itself with the all-zero `RELAY_PEER_ID` (`src/shared/relay-identity.ts`) and is never a keyhive member.
- **Direct WebRTC (opportunistic upgrade).** `src/client/webrtc-relay-adapter.ts` is the single adapter handed to keyhive: it wraps the relay adapter and, per peer, routes that peer's sync over a direct `RTCDataChannel` once one is open, falling back to the relay otherwise. Because `RTCPeerConnection` is window-only, the peer connections live on the **main thread** in `src/client/webrtc-bridge.ts`, connected to the worker over a `MessagePort` (same pattern as the HyperFormula bridge). STUN-only by default (no TURN — symmetric-NAT peers stay on the relay); override ICE servers with `VITE_ICE_SERVERS`. The bridge retries a stalled negotiation a few times, then leaves that peer on the relay.
- **Relay overlay frames.** Two protocols ride the relay socket alongside the automerge-repo protocol and are intercepted client-side before reaching the repo: WebRTC signaling (`WRTC_SIGNAL`, `src/shared/webrtc-signal.ts`) carrying SDP/ICE, and the encrypted **rendezvous** channel (`RDV_*`, `src/shared/rendezvous-protocol.ts`) used for QR contact/device exchange.

Per-peer transport is surfaced to the UI via the worker's `p2p-status` message → `usePeerTransports()`; the shared `PeerDot` (`src/client/shared/presence.tsx`) renders a **filled** dot for a direct channel and a **hollow ring** (the default) for relay, so a relayed connection is never mistaken for P2P.

### Routing

`src/client/App.tsx` defines routes via preact-router:

- `/` → Home (document list)
- `/calendars/:docId` → Calendar editor
- `/tasks/:docId` → Task list editor
- `/datagrids/:docId` → DataGrid editor
- `/source/:docId` → Raw JSON document inspector

### CalDAV

The backend implements CalDAV (RFC 4791) at `/dav/`. `src/backend/parser.ts` converts ICS→JMAP and `src/backend/serializer.ts` converts JMAP→ICS, enabling standard calendar clients to sync.

## Testing

**Playwright is reserved for tests that need two browsers/tabs (or a genuinely browser-only runtime); single-browser tests belong in Jest (jsdom).**

- **Jest** (`jest.config.js`; `*.test.ts` = node project, `*.test.tsx` = jsdom `ui` project): unit + UI component/container tests. Editor containers (Tasks, Counters, …) run in jsdom via `jest.mock('../worker-api')`, which picks up `src/client/__mocks__/worker-api.ts` — it backs `subscribeQuery`/`updateDoc` with an in-memory doc projected through the real jq engine (`src/shared/jq.ts`) and stubs the rest. Seed with `__setDoc(id, doc)`; assert store state with `__getDoc(id)`; reset in `beforeEach` with `__reset()`. It projects against a **clone** so each result has fresh refs (else `setState` bails on `Object.is` and nothing re-renders). `shared/keyhive-api` re-exports worker-api, so this one mock also covers access/presence. Components that read `Temporal` need `import 'temporal-polyfill/global'` first; the Radix `Select` popover can't be opened in jsdom, so seed variety via `__setDoc` rather than driving it.
- **Playwright** (`src/client/tests-pw/`): two-peer sync (`support/peer.ts`, `window.__drive`), multi-tab (Web Locks), real-worker/IndexedDB behavior, and heavy browser-only rendering (schedule-x calendar, HyperFormula datagrid).

## Key Conventions

- Use `deepAssign()` (from `src/shared/deep-assign.ts`) when patching nested properties inside `handle.change()` — it recursively merges without overwriting sibling fields
- Automerge document mutations must happen inside `handle.change()` callbacks
- Client imports use `@/` path alias (maps to `src/client/`)
- UI components in `src/client/components/ui/` follow shadcn/radix-ui patterns
- The Vite config has a custom `radixPreactPatchPlugin` to fix a Radix UI compat issue with Preact's ref handling
- When an error or bug occurs, create a test that reproduces the error first. Then focus on fixing it.

## Environment Variables

- `PORT` — Server port (default 3000)
- `AUTOMERGE_DATA_DIR` — Persistent storage directory (default `.data`)
- `NODE_ENV=production` — Disables request logging, serves built frontend
- `VITE_ICE_SERVERS` — (frontend, build-time) JSON array of `RTCIceServer` for WebRTC. Defaults to public Google STUN; set this to add a TURN server.
