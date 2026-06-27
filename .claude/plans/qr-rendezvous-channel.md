# QR via encrypted relay rendezvous (replaces embedding the bundle in the URL)

## Context

The friend/link QR codes embed the full keyhive contact bundle in the URL. That bundle
(`getContactCard` → `eventsForAgent(me) ∪ eventsForAgent(group)`, [keyhive-ops.ts:382](../../src/client/keyhive-ops.ts#L382))
grows without bound with account activity. Measured: fresh account = 2,705 chars (fits a QR at
ECC 'L'), a real account = **25,701 chars** — far beyond the ~2,953-byte hard ceiling of any QR
code. No compression/ECC tuning can fix an order-of-magnitude overflow.

**Chosen approach (user):** stop putting the bundle in the QR. The QR carries only a small
`{ rendezvousId, key }`. Both peers connect to the relay and listen on `rendezvousId`; once both
are present, the sender encrypts the (large) bundle with `key` and sends it over the relay. The
relay only routes opaque ciphertext — it never sees the key or plaintext.

## Protocol

New relay message types (CBOR, same socket as automerge-repo; relay stays otherwise stateless
except for a `Map<rendezvousId, Set<WebSocket>>`):
- `rdv-sub  { rendezvousId }` — join a topic. On join, relay notifies every peer already in the
  topic **and** the newcomer with `rdv-peer { rendezvousId }` (so the sender learns the receiver
  arrived, and vice-versa).
- `rdv-msg  { rendezvousId, data }` — relay forwards `data` (opaque bytes) to all *other* sockets
  in the topic.
- `rdv-unsub { rendezvousId }` — leave. Also cleaned up on socket close.

Crypto (WebCrypto AES-GCM, worker-side): 256-bit key + 12-byte random IV; frame = `iv ‖ ciphertext`.
`rendezvousId` = 16 random bytes (base64url); `key` = raw 32 bytes (base64url). Plaintext = the
contact-bundle JSON (optionally `{ card, displayName, userGroupId }`).

## Flow (friend add)

1. **Sender** (Settings → "Show QR code") calls worker `kh-rdv-create-share`: generate `{id,key}`,
   `rdv-sub`, store the pending plaintext (built lazily from `getContactCard` + display name).
   Returns `{id,key}` → UI shows the (now tiny) QR + link `#/add-friend/r/<id>.<key>` and a
   "Waiting for your friend to scan…" status. Sender must keep the page open.
2. **Receiver** opens the link → `AddFriendPage` parses `{id,key}` → worker `kh-rdv-receive`:
   `rdv-sub`, wait for `rdv-msg`, decrypt, `receiveContactCard(bundle)`, resolve with
   `{agentId,isOwnCard,userGroupId,displayName}`.
3. Receiver's `rdv-sub` triggers the relay's `rdv-peer` to the sender; the sender encrypts +
   `rdv-msg`. Worker posts an unsolicited `kh-rdv-event {id, status:'sent'|'error'}` so the sender
   UI can show "Sent ✓". Both `rdv-unsub` when done; timeout ~2 min with a clear status.

## Files

- **[src/shared/rendezvous-protocol.ts](../../src/shared/rendezvous-protocol.ts)** (new) — shared
  message-type string constants + TS types, imported by relay (Node) and worker (browser) so they
  can't drift.
- **[src/backend/relay.ts](../../src/backend/relay.ts)** — add the `rendezvous` topic map + handle
  `rdv-sub/msg/unsub` before the generic peer routing; clean up on `close`.
- **[src/client/rendezvous-crypto.ts](../../src/client/rendezvous-crypto.ts)** (new) — AES-GCM
  encrypt/decrypt + key/id generation + base64url helpers (WebCrypto, runs in worker).
- **[src/client/automerge-worker.ts](../../src/client/automerge-worker.ts)** — a rendezvous manager
  holding the `secureWs` socket; send `rdv-*` via `(secureWs as any).socket`; in the existing
  `receiveMessage` monkey-patch, short-circuit `rdv-*` frames into the manager (skip `origReceive`);
  add `kh-rdv-create-share` / `kh-rdv-receive` handlers + `kh-rdv-event` notifications.
- **[src/client/worker-api.ts](../../src/client/worker-api.ts)** — typed `rendezvousCreateShare` /
  `rendezvousReceive` + an `onRendezvousEvent` listener; new `WorkerToMain` cases.
- **[src/client/settings/AddFriendPage.tsx](../../src/client/settings/AddFriendPage.tsx)** — receiver
  path uses `rendezvousReceive` when the URL is the `r/<id>.<key>` form; keep the old embedded form
  working for back-compat. Build the sender URL via a new `buildAddFriendRendezvousUrl`.
- **[src/client/settings/Settings.tsx](../../src/client/settings/Settings.tsx)** — "Show QR code"
  (friend) uses `rendezvousCreateShare`; show waiting/sent status. (Reciprocal QR on
  AddFriendPage success + the device-link QR reuse the same primitive as a follow-up.)

## Deployment note

The production relay at `wss://auto-relay-…herokuapp.com` runs this same `WebSocketRelay` class but
must be **redeployed** for the feature to work in production. Dev / `npm start` / Playwright pick up
the change immediately.

## Verification

Two-peer Playwright spec (`src/client/tests-pw/`): peer A creates a share (gets `{id,key}`), peer B
receives via the same id+key, assert B ingests A as a contact (appears via `getKnownContacts`) and
A gets a `sent` event — all without any large URL. Plus the existing `npm run test:pw` suite.
