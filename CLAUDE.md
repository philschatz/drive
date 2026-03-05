# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Collaborative document editor built on Automerge CRDTs. Currently supports Calendar, TaskList, and DataGrid document types. The frontend is a Preact PWA; the backend is an Express server with CalDAV support. Documents sync in real-time via automerge-repo WebSocket connections.

## Commands

```bash
npm run dev          # Backend dev server with auto-reload (port 3000)
npm run build        # Vite production build (frontend → dist/)
npm run test:unit    # Jest unit tests
npm run test:watch   # Jest watch mode
npm test             # Jest + Cypress (full suite)
npm run cy:open      # Cypress GUI (uses run-cypress.sh for NixOS compat)
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
- `cypress/` — E2E tests

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

`src/shared/presence.tsx` provides real-time peer awareness using Automerge's native Presence API. All editors share a unified `PresenceState` type: `{ viewing: boolean, focusedField: (string | number)[] | null }`. The focused field path encodes what a peer is editing (e.g., `['events', uid, 'title']`).

### Routing

`src/client/App.tsx` defines routes via preact-router:
- `/` → Home (document list)
- `/calendars/:docId` → Calendar editor
- `/tasks/:docId` → Task list editor
- `/datagrids/:docId` → DataGrid editor
- `/source/:docId` → Raw JSON document inspector

### CalDAV

The backend implements CalDAV (RFC 4791) at `/dav/`. `src/backend/parser.ts` converts ICS→JMAP and `src/backend/serializer.ts` converts JMAP→ICS, enabling standard calendar clients to sync.

## Key Conventions

- Use `deepAssign()` (from `src/shared/deep-assign.ts`) when patching nested properties inside `handle.change()` — it recursively merges without overwriting sibling fields
- Automerge document mutations must happen inside `handle.change()` callbacks
- Client imports use `@/` path alias (maps to `src/client/`)
- UI components in `src/client/components/ui/` follow shadcn/radix-ui patterns
- The Vite config has a custom `radixPreactPatchPlugin` to fix a Radix UI compat issue with Preact's ref handling

## Environment Variables

- `PORT` — Server port (default 3000)
- `AUTOMERGE_DATA_DIR` — Persistent storage directory (default `.data`)
- `NODE_ENV=production` — Disables request logging, serves built frontend
