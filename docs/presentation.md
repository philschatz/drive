---
marp: true
theme: default
paginate: true
title: Drive — Architecture Insights
---

# Drive

## Local-first, end-to-end-encrypted collaborative documents

- **Automerge** CRDTs — conflict-free offline editing and sync
- **Keyhive** — cryptographic access control + E2E encryption
- **Preact PWA** with three editors: **Calendar · TaskList · DataGrid**
- Stateless relay backend that only ever routes **opaque encrypted bytes**

<!--
Table of contents:
 1. The worker is the source of truth
 2. An installable, offline-first PWA
 3. Identity: devices are Individuals, a user is a Group
 4. Sharing a doc = sharing with a user-group
 5. Contacts & device linking: the encrypted rendezvous
 6. Keyhive details I: one encryption boundary
 7. Keyhive details II: transitive access & a fussy WASM
 8. Automerge doc handling: design for concurrent edits
 9. Validation runs on every change
10. DataGrid: a data model built for concurrency
11. DataGrid formulas: stable refs + a second worker
12. Conditional formatting fell out of the formula design
13. What flows through the relay
14. Overlay frames & the P2P upgrade
15. Presence: broadcast the document path, not the DOM
16. Presence is encrypted with the doc's newest key
17. Gotcha: leaving a document
18. Gotchas: silent revocation & the multi-tab wall
19. Gotcha: the changes keyhive needed (and takeaways)
-->

---

## The worker is the source of truth

The main thread renders UI — it **never holds a full document**. A dedicated Web Worker owns everything else:

- **Document manipulation** — mutation functions are *serialized* to the worker: `updateDoc` ships the function's source text; the engine revives it (`new Function(...)`) and runs it inside `handle.change()`
- **Peer sync** — the automerge repo, keyhive crypto, and all transports live worker-side
- **Query caching** — the UI subscribes to **jq slices** of a doc; the worker pushes updated slices on every change (local or remote)

The biggest win is the spreadsheet: the main thread keeps only the **current sheet** in memory, even though computed cells may pull data from **multiple sheets** (more on slide 11).

---

## An installable, offline-first PWA

- **Install it on your phone** (or desktop): web manifest with `display: standalone` + icons; Home shows an Install button driven by `beforeinstallprompt`, hidden once running standalone (including iOS)
- **Works fully offline**: the service worker precaches the entire app shell — *including the WASM and worker bundles* (5 MB per-file cache limit exists for exactly that reason)
- All document data + keyhive state live in **IndexedDB**, so docs open and are editable with no network; CRDT merge reconciles everything on reconnect
- **Auto-update**: the build stamps a `version.json` (git SHA + time); an in-app banner offers "New version available — reload" (`UpdateBanner`)

---

## Identity: devices are Individuals, a user is a Group

- Each device mints an ed25519 key on first boot → a keyhive **Individual** (key stored in IndexedDB)
- A **user = a keyhive Group whose members are their devices** (`ensureUserGroup` in `src/client/keyhive-ops.ts`)
- Documents are shared with the *group*, so every device of that user gets access automatically
- The user-group is made **admin co-owner of every doc** the user creates

Network identity is derived from the device key:

```
peerId = "<base64(device verifying key)>-drive"
```

The prefix must decode to a 32-byte keyhive `Identifier` — the peerId *is* the cryptographic identity, not a random label.

---

## Sharing a doc = sharing with a user-group

- `addMember(contactGroup, doc, role)` — roles exposed in the UI: **read / edit / admin**
  (keyhive has a 4th, lowest tier `relay` — sync-only, used for infrastructure peers, hidden from the share dialog)
- Sharing is **direct-contact only**: the dialog lists known contacts; `resolveShareAgent` refuses to share with a bare device
- Contacts and new devices are established via **rendezvous QR codes / links** (next slide) — always at the user-group level, so a shared doc appears on *all* of the recipient's devices
- Each share triggers a **CGKA rekey** — the doc gets a fresh epoch key that includes the new member

---

## Contacts & device linking: the encrypted rendezvous

Adding a friend or linking a new device starts with a QR code / link that contains only a tiny secret:

```
{ rendezvousId, key }   // AES-256-GCM key, never seen by the relay
```

- Both sides subscribe to the `rendezvousId` on the relay; the relay routes **opaque encrypted frames** between them
- What travels: a **contact bundle** — the sender's contact card *plus their user-group's ops* (bounded: ≤1024 events / ≤1 MB), so the receiver's keyhive can resolve the group locally and share back
- **Device link** = the same flow twice: the fresh device *adopts* the peer's group id, then each side calls `addDeviceToGroup` (only the admin side succeeds; the reciprocal leg covers the other)

---

## Keyhive details I: one encryption boundary

Keyhive wraps a **single `NetworkAdapter`** — all transport multiplexing (relay, WebRTC) happens *below* it and is invisible to it.

- Every outgoing message is **ed25519-signed**; receivers verify the signature against the sender's peerId
- Document changes are encrypted *before* they reach a sync message: the **blob interceptor** calls `tryEncrypt` with the doc's current **CGKA application secret**
- The envelope also carries a symmetric-encrypted **predecessor-key chain**, so a member added later can decrypt older history through the newest blob's chain
- The relay and any non-member peer only ever see ciphertext

---

## Keyhive details II: transitive access & a fussy WASM

- **The home page is a keyhive query, not a file listing**: `reconcileHomeDocs` compares `reachableDocs()` against `accessForDoc(userGroupId, doc)` (which walks `transitive_members()`)
  - reachable **but no group access** → you were revoked → prune
  - reachable and accessible → show, with a read/edit/admin badge
- Access resolves **transitively**: device ∈ user-group ∈ doc — this required changes to keyhive itself (see gotchas)
- **Keyhive WASM is non-reentrant**: two overlapping calls (one suspended at an `await`) trap `unreachable`. Every call is serialized through a shared promise queue (`serializeKeyhive()` proxy) — a requirement that appeared the moment presence added high-frequency encrypt/decrypt

---

## Automerge doc handling: design for concurrent edits

```ts
{ "@type": "Calendar", name, events: Record<uid, Event> }
{ "@type": "TaskList", name, tasks:  Record<id, Task> }
{ "@type": "DataGrid", name, sheets: Record<id, Sheet> }
```

- **Maps, never arrays** — concurrent inserts land on different keys instead of colliding on an index
- **No stored document id** — identity *is* the automerge repo handle
- **`@type` discriminator** on every document and sub-object drives schema dispatch

---

## Validation runs on every change

- Each doc type registers a plugin `{ type, schema, checkDeps }`; the worker validates on **every change — local edits and synced remote edits alike** (`handle.on('change')` + `handle.on('doc')`)
- Schemas are built from a tiny functional DSL: `str() num() bool() obj() record() union() arr()`; a `union` picks the branch with the fewest errors; unknown keys are warnings, not failures
- `checkDeps` covers cross-field invariants a structural schema can't: `due >= start`, cell keys must reference existing rows/columns, formula refs must resolve, dangerous URI schemes flagged
- **Advisory by design**: errors surface as a badge + panel; writes are never blocked or reverted — a CRDT can't reject a peer's already-merged change anyway

---

## DataGrid: a data model built for concurrency

```ts
Sheet {
  columns: Record<colId, { index, name, width?, hidden?, frozen? }>
  rows:    Record<rowId, { index, height?, hidden?, frozen? }>
  cells:   Record<"rowId:colId", { value: string }>   // flat map
}
```

- Everything is **id-keyed**; visual order is a **fractional float `index`** — insert interpolates between neighbors, move takes the midpoint, and *no sibling is ever renumbered*, so concurrent reorders converge
- Every cell value is a **string** (formulas start with `=`); there are no typed columns — presentation comes from Excel-style `numFmt` codes, coercion happens at evaluation time
- A1 letters are **display-only**; the doc stores ids

---

## DataGrid formulas: stable refs + a second worker

- Formulas are stored in an **ID-based internal format**: `{R{rowId}C{colId}}`, cross-sheet `{…S{sheetId}}` — reordering or inserting rows/columns **never rewrites a formula**; A1 exists only at the edit boundary
- **HyperFormula runs in its own dedicated worker.** The bridge creates a MessageChannel: one port to the automerge worker, one to the HF worker
- The HF worker **jq-subscribes directly to the automerge worker** — for the active sheet *and every cross-sheet dependency sheet*. That bulk data never touches the main thread; the UI receives only computed values
- The jq filter also scopes *what* it sees: only cell values and row/column order — formatting, conditional-format rules, and other sheet metadata never wake the engine
- **Derived state stays out of the CRDT**: computed results live in memory, are never written back to the doc

---

## Conditional formatting fell out of the formula design

```ts
ConditionalFormatRule {
  index                     // priority — higher wins, first match
  ranges                    // one or more rectangles (id-based endpoints)
  conditionType             // gt, lt, eq, …, isEmpty, customFormula
  conditionValue?; format
}
```

- Simple comparisons evaluate on the main thread
- `customFormula` stores a **relative R1C1 formula string**, re-anchored to *each cell* in the range and evaluated by the **same HyperFormula engine** in the worker (with a 20k-cell budget)
- The feature was cheap precisely **because cells already store formulas as strings** and the engine + reference machinery already existed — no separate rule language needed

---

## What flows through the relay

The relay is a **stateless CBOR router**: it reads only `type / senderId / targetId`, forwards `data` verbatim, and identifies itself with an all-zero peerId that is deliberately never a keyhive member.

Three conceptual channels ride the keyhive adapter (all ed25519-signed):

| Channel | Carries | Encrypted with |
|---|---|---|
| **Keyhive op-sync** (7 `keyhive-sync-*` kinds) | membership delegations/revocations, CGKA key ops, prekeys — *how a share/invite reaches you* | keys sealed to members |
| **Doc sync** | ordinary automerge sync whose blobs were pre-encrypted | doc's CGKA app secret |
| **Presence** | automerge `ephemeral` messages | doc's CGKA app secret |

There is **no store-and-forward "mailbox"**: op-sync is idempotent gossip, so an offline peer converges when it next meets *any* peer holding the ops. The invite-a-device/friend role is played by the **rendezvous channel** (next slide).

---

## Overlay frames & the P2P upgrade

Two drive-specific protocols ride the relay socket and are intercepted *before* the repo sees them:

- **`wrtc-signal`** — WebRTC SDP/ICE signaling (relay enforces the senderId)
- **`rdv-*`** — the rendezvous channel: routed by `rendezvousId`, payload AES-256-GCM under the QR key

**The relay is only the default path.** Per peer, sync opportunistically switches to a direct **WebRTC `RTCDataChannel`** negotiated via ICE — STUN by default, TURN if configured (`VITE_ICE_SERVERS`) — and falls back to the relay when NAT traversal fails. Keyhive can't tell the difference: same peerIds, same signed+encrypted messages either way.

UI: each peer's dot is **filled = direct P2P**, **hollow ring = relayed**.

---

## Presence: broadcast the document path, not the DOM

```ts
PresenceState {
  viewing: boolean
  focusedField: (string | number)[] | null   // e.g. ['events', uid, 'title']
  userGroupId?: string                       // collapses my devices into one identity
}
```

- `focusedField` is a **path into the document data** — `['sheets', sheetId, 'cells', 'rowId:colId']` — stable across peers regardless of markup, layout, or screen size; each editor maps the path to whatever local element renders that value
- The same paths round-trip into the URL, so presence and deep-linking share one addressing scheme
- **Each key is its own broadcast channel** (`viewing`, `focusedField`, `userGroupId`), diffed and sent independently

---

## Presence is encrypted with the doc's newest key

Presence rides automerge **ephemeral** messages, which document encryption does *not* cover — so the worker encrypts every channel **value** itself:

```
JSON → bytes → kh.tryEncrypt(doc, randomRef, [], bytes)
       // the doc's latest ("last-ratcheted") CGKA application secret
```

- Channel *names* are plaintext; *values* are ciphertext → the wire never leaks what anyone is viewing or editing
- Whoever can read the doc can read presence; a **revoked peer loses presence at the next rekey**
- **Best-effort by design**: encrypt-or-null never throws; failed decrypts are skipped; a 5s retry loop forces a keyhive sync and re-announces — late-arriving keys heal automatically (5s heartbeat, 12s stale cutoff)

---

## Gotcha: leaving a document

Removing yourself isn't a plain operation in a capability graph — you may lack the authority (and it can fail even when you don't: partial CGKA state, WASM rekey traps).

So Home's "delete" is **archive-first**:

1. Tombstone the doc id locally (+ record the current grant **signatures** as a baseline)
2. *Then* attempt `revokeMyAccess` — it revokes the **user-group**, and reports honestly: `revoked` / `no-authority` / `not-found`
3. Purge local automerge data (`repo.delete`) — peers keep theirs
4. On `no-authority` the UI says so: *"archived on this device — it may still appear on your other devices"*

**Re-share detection**: a deliberate re-share mints a *fresh* delegation whose signature isn't in the baseline → the doc un-archives and reappears.

---

## Gotchas: silent revocation & the multi-tab wall

**Revoked peers are never told.** Keyhive sync sends a peer only the ops *relevant to them*; after a revoke, the doc simply stops being relevant. Nothing is pushed — the revoked peer keeps its last-cached copy and discovers via silence / failed decryption.

**Two tabs of the same browser can't both sync.**

- The peerId suffix is pinned (`…-drive`), so every tab of a device claims the **same peerId** — identity *is* the device verifying key, and the suffix is stripped on the wire
- The relay **refuses a duplicate join** (the incumbent socket is never evicted) → the second tab is offline
- Per-tab suffixes were tried and removed: a suffixed sibling tab panics keyhive — `Cgka::new_app_secret_for` expects the current root's `PcsKey` in `pcs_key_ops`, which is only populated on a *local* update or a decrypt, so **encrypting right after ingesting a remote rekey traps `unreachable`**

---

## Gotcha: the changes keyhive needed (and takeaways)

To support this app, keyhive itself was extended (fork, ~30 commits):

- **Serialization** — `toArchive()` / `ingestArchive()`: rebuilding from the op log alone loses in-memory CGKA leaf secrets. Drive persists the full archive on **every keyhive event** (debounced), and no-ops the bridge's `forcePcsUpdate` (it minted a rotation *without emitting it* — after a reload, every encrypt/decrypt failed "Key not found")
- **Transitive access** — groups as members of groups/docs ("Users are Groups of devices"), plus an access-*escalation* fix: effective access = **minimum along each delegation path**
- **Listening to updates** — an event callback for every keyhive event, so embedders can persist and refresh reactively instead of polling

**Takeaways**: design documents for the CRDT (maps, fractional indices, derived state out); put the encryption boundary at exactly one network adapter; entitlement-gated gossip makes sharing work offline — and makes revocation silent; workers own the data, the UI only ever sees slices.
