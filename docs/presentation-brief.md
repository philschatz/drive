---
marp: true
theme: default
paginate: true
title: Drive — Architecture Insights (Brief)
---

# Drive

## Local-first, E2E-encrypted collaborative documents

- Automerge CRDTs for conflict-free editing and sync
- Keyhive for access control and end-to-end encryption
- Preact PWA: Calendar, TaskList, DataGrid editors
- A relay server that only routes opaque encrypted bytes

<!--
Table of contents:
 1. What it is
 2. Main thread = UI, worker = source of truth
 3. Users, devices & sharing
 4. How keyhive is used
 5. Automerge document shape
 6. Validation runs on every change
 7. DataGrid: a grid built for concurrent editing
 8. DataGrid: formulas & conditional formatting
 9. What flows through the relay
10. Presence
11. PWA: install it, use it offline
12. Gotchas: leaving & revoking
13. Gotchas: multi-tab & changes to keyhive
14. Takeaways
-->

---

## What it is

- Documents live on your devices, not on a server
- Every change syncs to collaborators in real time — and merges cleanly after offline edits
- Installable on phones and desktops; works fully offline
- Sharing, presence, and sync are all end-to-end encrypted

---

## Main thread = UI, worker = source of truth

- The UI never holds a full document
- Document edits are functions, serialized from the main thread and executed inside the worker
- The worker owns peer sync: automerge repo, keyhive crypto, and all transports
- The UI subscribes to small jq query slices; the worker pushes updates on every change
- Biggest win — the spreadsheet: the main thread keeps only the current sheet, while formulas may pull from many sheets entirely inside workers

---

## Users, devices & sharing

- A device is a keyhive Individual (an ed25519 key)
- A user is a keyhive **Group of their devices** — docs are shared with the group, so every device gets access
- Sharing is direct-contact only: add a friend once, then grant read / edit / admin
- New devices and friends are added by scanning a QR code (a rendezvous link)

---

## How keyhive is used

- Keyhive wraps a single network adapter — every transport sits below the encryption boundary
- All messages are signed; document changes are encrypted with the doc's current group key (CGKA)
- Each share or revoke rotates the key to a new epoch
- Access is computed transitively: device → user-group → document
- The home page is literally a keyhive query: "which docs can my user-group access?"

---

## Automerge document shape

- Collections are maps keyed by id, never arrays — concurrent inserts can't collide
- Documents store no id of their own; identity is the repo handle
- Every object carries a `@type` discriminator for schema dispatch

---

## Validation runs on every change

- Each doc type has a schema plus a dependency checker
- The worker validates after **every** change — local edits and remote peers' edits alike
- Cross-field rules too: due dates after start dates, formula references must resolve, cell keys must point at real rows and columns
- Advisory only: errors show as a badge and panel, but writes are never blocked — you can't reject an already-merged CRDT change anyway

---

## DataGrid: a grid built for concurrent editing

- Sheets, rows, columns, and cells are all id-keyed maps
- Order is a fractional index — inserting or moving never renumbers neighbors, so concurrent reorders converge
- Cells store plain strings; formatting is display-time (Excel-style number formats)
- Formatting is stored as range overlays, not per-cell attributes

---

## DataGrid: formulas & conditional formatting

- Formulas reference **row/column ids**, not positions — reordering never rewrites a formula; A1 notation exists only while editing
- HyperFormula evaluates in its own worker, fed directly by the automerge worker — bulk sheet data (including cross-sheet dependencies) never touches the main thread
- Its jq subscription selects only what evaluation needs (cell values and row/column order) — formatting changes never wake the engine
- Computed values are derived state: kept in memory, never written into the document
- Conditional formatting was cheap: a custom rule is just another formula string, re-anchored per cell, run through the same engine

---

## What flows through the relay

- The relay is stateless: it reads addressing fields and forwards encrypted bytes
- Three encrypted channels: **keyhive op-sync** (memberships, key rotations — how a share reaches you), **doc sync** (pre-encrypted automerge changes), and **presence** (ephemeral)
- Plus two overlays: WebRTC signaling, and the encrypted rendezvous used to invite a device or friend via QR
- No store-and-forward: an offline peer catches up from whichever peer it meets next
- When possible, sync upgrades per-peer to a **direct WebRTC channel** (STUN/TURN), falling back to the relay

---

## Presence

- What a peer is viewing/editing is broadcast as a **path into the document** — independent of layout, screen size, or DOM
- Each field (viewing, focused element, user identity) is its own channel
- Values are encrypted with the doc's newest ratcheted key: only members can see presence, and a revoked peer goes dark at the next key rotation
- Best-effort: missing keys never crash presence; a retry loop heals it once keys sync
- A user's devices collapse into one identity and color

---

## PWA: install it, use it offline

- Install button on the home page (hidden once installed); standalone app on phones
- The service worker precaches the whole app shell — including the WASM bundles
- All data is in IndexedDB, so documents open and edit with zero network
- Changes merge automatically when you're back online
- Updates announce themselves: "New version available — reload"

---

## Gotchas: leaving & revoking

- Removing yourself from a doc isn't always possible (authority rules, fragile key state) — so "delete" is **archive-first**: tombstone locally, then *try* to revoke, and be honest when it didn't fully work
- A deliberate re-share is detected by its fresh grant signature and un-archives the doc
- Revocation is **silent**: sync only sends peers what's relevant to them, so a revoked peer is simply cut off — it keeps its stale copy and is never notified

---

## Gotchas: multi-tab & changes to keyhive

- Two tabs of one browser can't both sync: a tab's network identity *is* the device key, the relay refuses duplicate ids, and per-tab ids panic keyhive's key tree (encrypting right after a remote rekey)
- Keyhive itself needed changes:
  - **Serialization** — archive save/restore, because freshly-rotated keys lived only in memory (a reload lost them: "Key not found" forever)
  - **Transitive access** — groups as members of groups/docs, with access capped to the minimum along each path
  - **Update events** — a callback per keyhive event, so the app can persist and refresh reactively

---

## Takeaways

- Design documents *for* the CRDT: maps over arrays, fractional indices, derived state stays out
- Put the encryption boundary in exactly one place — everything below it is interchangeable transport
- Entitlement-gated gossip makes sharing work without a server database — and makes revocation silent by nature
- Workers own the data; the UI only ever sees small query slices
- Local-first + PWA = an app that installs anywhere and never needs the network to open your documents
