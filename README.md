# Drive

Real-time collaborative document editor built on [Automerge](https://automerge.org/) CRDTs.

## Features

- **Multiple document types**: Calendar, Task List, and DataGrid (spreadsheet)
- **Real-time collaboration** via automerge-repo WebSocket connections
- **Offline editing** with conflict-free merge on reconnect
- **Version history** with slider to browse, view, and revert to any past version
- **Installable PWA** for mobile and desktop
- **JSON source editor** with jq query panel for inspecting document internals
- **CalDAV support** server for syncing calendars with standard clients (Apple Calendar, Thunderbird, etc.)
- **Schema validation** with dependency checking across document structures

## Upcoming

- End-to-end encryption (thanks [subduction](https://github.com/inkandswitch/subduction))
- Access Control (thanks [keyhive](https://www.inkandswitch.com/project/keyhive/))

## Quick Start

```bash
npm install
npm run dev    # Start dev server on port 3000
```

## Commands

```bash
npm run dev          # Backend dev server with auto-reload
npm run build        # Vite production build (frontend -> dist/)
npm run test:unit    # Jest unit tests
npm run test:watch   # Jest watch mode
npm test             # Jest + Cypress (full suite)
npm run cy:open      # Cypress GUI
```

**Type checking** (two separate tsconfigs):

```bash
npx tsc --noEmit                          # Backend (src/backend/)
npx tsc -p tsconfig.client.json --noEmit  # Frontend (src/client/ + src/shared/)
```

## Architecture

- **Frontend**: Preact SPA with Tailwind CSS v4, schedule-x calendar, CodeMirror editors
- **Backend**: Express server with CalDAV handler, ICS/JMAP parser/serializer
- **Sync**: Automerge CRDT documents synced via WebSocket (automerge-repo)

### Directory Layout

```
src/
  backend/     Express server, CalDAV handler, REST routes
  client/      Preact SPA: calendar/, tasks/, datagrid/, source/, home/
  shared/      Shared between client features: automerge, presence, schemas, history
tests/         Jest tests
cypress/       E2E tests
```

### Document Types

Each document has an `@type` discriminator and uses `Record<string, Item>` maps (not arrays) for conflict-free concurrent edits:

- **Calendar** - Events following JSCalendar (RFC 8984), with recurrence, alarms, participants
- **TaskList** - Tasks with completion status, due dates, priority
- **DataGrid** - Multi-sheet spreadsheet with formulas, column/row management, cell references

## CalDAV

The backend implements CalDAV (RFC 4791) at `/dav/`, enabling standard calendar clients to sync.

**Base URL:** `http://localhost:3000/dav/`

```bash
# Discover calendars
curl -X PROPFIND http://localhost:3000/dav/ -H "Depth: 1"

# Create a calendar
curl -X MKCALENDAR http://localhost:3000/dav/my-calendar/

# Add an event
curl -X PUT http://localhost:3000/dav/default/event.ics \
  -H "Content-Type: text/calendar" --data-binary @event.ics
```

Supported methods: PROPFIND, MKCALENDAR, GET, PUT, DELETE, REPORT.

## Environment Variables

- `PORT` - Server port (default 3000)
- `AUTOMERGE_DATA_DIR` - Persistent storage directory (default `.data`)
- `NODE_ENV=production` - Disables request logging, serves built frontend

## Standards

- **JSCalendar**: RFC 8984
- **iCalendar**: RFC 5545
- **CalDAV**: RFC 4791

## License

ISC
