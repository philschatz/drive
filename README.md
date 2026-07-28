# Drive

Real-time collaborative document editor that's installable on your phone.

## Features

<a href="https://philschatz.com/drive/"><img src="docs/tour.gif" alt="tour" align="right" width="240"></a>

- **Installable PWA** for mobile and desktop
- **Multiple document types**: Calendar, Spreadsheet, Task List
- **Real-time collaboration** via automerge-repo WebSocket connections
- **Offline editing** with conflict-free merge on reconnect
- **Schema validation** with dependency checking across document structures
- **Command-line** tool to do sync/backups

### Quick Start

Visit [philschatz.com/drive/](https://philschatz.com/drive/) (GitHub Pages)

Check out the [slides](https://philschatz.com/drive/slides/) for more

Or, start it locally:

```bash
npm install
npm run dev    # Start dev server on port 3000
```

<br clear="right">

## Headless CLI

A Node peer that syncs over the relay without a browser — useful for backups or a
long-lived sync node. It runs the same engine as the app, so it is end-to-end
encrypted (keyhive) and identifies as one of your linked devices.

```bash
npm run cli -- accept-invite "<link>"  # link this device (Settings -> Link Device in the app), then exit
npm run cli -- list                    # print every accessible document: id, versions, last-modified
npm run cli -- show <docId> [version]  # render a document version as JSON to stdout (default: current)
npm run cli -- diff <docId> [from] [to] # print Automerge patch ops between two versions (default: latest change)
npm run cli -- sync                    # keep the recent docs open and sync continuously (Ctrl-C to stop)
```

### Environment Variables

- `PORT` - Server port (default 3000)
- `AUTOMERGE_DATA_DIR` - Persistent storage directory (default `.data`)
- `NODE_ENV=production` - Disables request logging, serves built frontend

### Directory Layout

```
src/
  relay/           WebSocket relay + production SPA host + Vite dev plugin
  bitrot-caldav/   CalDAV bridge: RFC 4791 handler, /dav routes, ICS↔JMAP
  cli/             Headless peer
  client/
    ui/            Preact SPA: doc-plugins/, home/, source/, settings/, common/
    worker/        The Automerge + keyhive Web Worker
    shared/        Used by BOTH threads: idb-storage, webrtc-chunk, worker-client
    assets/        globals.css + public/ (index.html stays at client/, Vite's root)
    tests-pw/      Playwright E2E (editor UI + two-peer sync)
tests/             Jest tests
```

## Standards

- **JSCalendar**: RFC 8984
- **iCalendar**: RFC 5545
- **CalDAV**: RFC 4791

## License

ISC
