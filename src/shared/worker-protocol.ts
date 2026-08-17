/**
 * Message protocol between the main thread (worker-api.ts) and the DriveEngine —
 * regardless of whether the engine runs inside a Web Worker (browser) or in-process
 * (the Node CLI). Extracted from automerge-worker.ts so the engine, the browser
 * worker shell, and the main-thread client all share one contract.
 */
import type { RendezvousStatus } from './rendezvous-protocol';
import type { RichTextSpan } from './rich-text-ops';
import type { WebRTCSignal } from './webrtc-signal';
import type { BackupTier, BackupPayload } from './backup';

// ── worker ↔ WebRTC bridge (a MessagePort, not the worker's main channel) ────
// RTCPeerConnection is window-only, so the peer connections live on the main
// thread (src/client/ui/webrtc-bridge.ts) while the network adapter that drives
// them lives in the shared adapter (src/shared/webrtc-relay-adapter.ts). These
// two types are that MessagePort's contract; they live here so neither side has
// to import the other across the ui/worker boundary.

/** Worker → bridge commands. */
export type WorkerToBridgeMsg =
  | { kind: 'connect-peer'; peerId: string; initiator: boolean }
  | { kind: 'disconnect-peer'; peerId: string }
  | { kind: 'signal-in'; peerId: string; signal: WebRTCSignal }
  | { kind: 'data-out'; peerId: string; bytes: Uint8Array };

/** Bridge → worker events. */
export type BridgeToWorkerMsg =
  | { kind: 'signal-out'; peerId: string; signal: WebRTCSignal }
  | { kind: 'channel-open'; peerId: string }
  | { kind: 'channel-closed'; peerId: string }
  | { kind: 'data-in'; peerId: string; bytes: Uint8Array };

export type MainToWorker =
  | { type: 'init' }
  | { type: 'set-debug-mode'; id: number; enabled: boolean }
  | { type: 'get-settings-mode'; id: number }
  // Read-only probe: does a reachable DriveSettings doc already exist to adopt?
  // Returns its docId (string) or null. Lets the UI decide whether enabling sync
  // is a permanent CREATE (needs confirmation) or a frictionless reuse.
  | { type: 'get-reachable-settings-doc'; id: number }
  | { type: 'enable-settings-sync'; id: number }
  // Seed THIS device's name to `name` only if none is stored yet (called once at
  // startup with the main-thread-generated default; the name is generated on the
  // main thread since the worker has no reliable `navigator`).
  | { type: 'ensure-device-name'; id: number; agentId: string; name: string }
  | { type: 'set-presence-timing'; id: number; staleMs?: number; heartbeatMs?: number; livenessCheckMs?: number }
  | { type: 'clear-caches'; id: number }
  | { type: 'get-doc-list'; id: number }
  // Tiered backup. `export-backup` returns a BackupPayload assembled in the
  // worker (the full documents never cross to the main thread); `import-backup`
  // accepts a parsed BackupPayload and runs the matching restore, returning a
  // BackupResult.
  | { type: 'export-backup'; id: number; tiers: BackupTier[] }
  | { type: 'import-backup'; id: number; payload: BackupPayload }
  // `peek: true` = "don't count this read as the user viewing the doc" (home
  // page summary, source inspector/export, background tooling). Default
  // (absent) = viewing: the doc's last-viewed heads are updated, clearing its
  // new-changes indicator.
  | { type: 'query'; id: number; docId: string; filter: string; peek?: boolean }
  // New worker-owned doc API
  | { type: 'create-doc'; id: number; initialJson: any; metadata?: Record<string, any> }
  | { type: 'update-doc'; id: number; docId: string; fnSource: string; args: unknown[] }
  // `spansPath` = also deliver the rich-text spans (marks + block markers) of
  // the Peritext field at that path with every result — the jq projection only
  // carries the flat text, so rich-text editors need this side channel.
  // `allRichText` = deliver the spans of EVERY string field that turns out to
  // carry markers, discovered by asking Automerge rather than by declaration.
  // Costs a walk of the whole document per push, so it is for the source
  // inspector — which needs the fields no schema declares — and nothing else.
  | { type: 'subscribe-query'; subId: number; docId: string; filter: string; peek?: boolean; meta?: boolean; spansPath?: (string | number)[]; allRichText?: boolean }
  | { type: 'unsubscribe-query'; subId: number }
  | { type: 'set-doc-version'; docId: string; version: number | null }
  // Force any throttled writes for this doc (or every open doc) out to storage
  // and await them. automerge-repo saves on a debounce, so a doc edited moments
  // ago is not yet durable; the repo lives in a DEDICATED worker, which a reload
  // or tab close terminates mid-debounce. Called on visibilitychange → hidden,
  // and by tests that reload and then assert the content came back.
  | { type: 'flush-storage'; id: number; docId?: string }
  | { type: 'get-doc-history'; id: number; docId: string }
  | { type: 'debug-get-version-patches'; id: number; docId: string; version: number }
  | { type: 'restore-doc-to-heads'; id: number; docId: string; heads: string[] }
  | { type: 'restore-doc-to-version'; id: number; docId: string; version: number }
  | { type: 'subscribe-presence'; docId: string }
  | { type: 'unsubscribe-presence'; docId: string }
  | { type: 'set-presence'; docId: string; state: any }
  // Doc list mutations (IDB-backed). Adding a doc is folded into 'create-doc';
  // every other doc enters the list via reconcileHomeDocs (keyhive-access driven).
  // The home page's "archive" action: `id` correlates the result so the UI can
  // report whether access was truly revoked or only archived on this device.
  | { type: 'archive-doc'; id: number; docId: string }
  // Contact name mutations (IDB-backed). `id` correlates the result so the main
  // thread can await persistence and surface failures instead of losing them.
  | { type: 'set-friend-name'; id: number; agentId: string; name: string }
  | { type: 'remove-friend-name'; id: number; agentId: string }
  // Device name mutations (IDB-backed, keyed by device agentId). Same shape as
  // the contact-name messages; `id` correlates the awaited persistence result.
  | { type: 'set-device-name'; id: number; agentId: string; name: string }
  | { type: 'remove-device-name'; id: number; agentId: string }
  // Keyhive operations
  | { type: 'kh-get-identity'; id: number }
  | { type: 'kh-get-contact-card'; id: number }
  | { type: 'kh-receive-contact-card'; id: number; cardJson: string; isDevice?: boolean; userGroupId?: string | null }
  | { type: 'kh-get-doc-members'; id: number; docId: string }
  | { type: 'kh-get-my-access'; id: number; docId: string }
  | { type: 'kh-add-member'; id: number; agentId: string; docId: string; role: string }
  | { type: 'kh-revoke-member'; id: number; agentId: string; docId: string }
  | { type: 'kh-change-role'; id: number; agentId: string; docId: string; newRole: string }
  | { type: 'kh-list-devices'; id: number }
  | { type: 'kh-remove-device'; id: number; agentId: string }
  | { type: 'kh-change-device-role'; id: number; agentId: string; newRole: string }
  | { type: 'kh-ensure-user-group'; id: number; create?: boolean; adoptGroupId?: string; waitForSync?: boolean }
  | { type: 'kh-get-known-friends'; id: number; excludeDocId?: string }
  // Encrypted relay rendezvous (large-payload contact exchange via QR id+key)
  | { type: 'kh-rdv-create-share'; id: number; displayName?: string }
  | { type: 'kh-rdv-receive'; id: number; rendezvousId: string; key: string; displayName?: string }
  | { type: 'kh-rdv-link-create'; id: number; deviceName?: string }
  | { type: 'kh-rdv-link-join'; id: number; rendezvousId: string; key: string; deviceName?: string }
  | { type: 'kh-rdv-cancel'; rendezvousId: string }
  // Mint Automerge Cursors for flat-text positions in a Peritext field. Presence
  // shares carets as cursors (stable across concurrent edits, per Peritext
  // convention); the doc lives in the worker, so minting happens here. This is
  // the ONLY cursor round trip — resolution rides the query-result push below.
  | { type: 'text-cursors'; id: number; docId: string; path: (string | number)[]; positions: number[] }
  // Cursor tokens to resolve into flat-text positions on every change, delivered
  // with the spans push. Replaces the whole set for this doc+path (an empty list
  // clears it), so a missed unregister cannot leak a token. Peers' carets come
  // from presence; the local caret registers its own token so it can be rebased
  // across concurrent remote edits before its spans render.
  | { type: 'subscribe-cursors'; docId: string; path: (string | number)[]; tokens: string[] }
  | { type: 'open-doc'; id: number; docId: string }
  | { type: 'subscribe-validation'; docId: string }
  | { type: 'unsubscribe-validation'; docId: string }
  // Main-thread WebRTC bridge port (RTCPeerConnection lives on the main thread).
  // Only the tab that owns the Worker sends this — see ui/tab-transport.ts.
  | { type: 'webrtc-port'; port: MessagePort };

export type ValidationError = { path: (string | number)[]; message: string; kind?: 'schema' | 'dependency' | 'warning' };
/** Structurally identical to MarkerField in ./schemas — inlined here for the
 * same reason ValidationError is: the wire protocol names its own shapes. */
export type MarkerField = { path: (string | number)[]; spans: RichTextSpan[] };

export type WorkerToMain =
  | { type: 'ready'; peerId: string }
  | { type: 'kh-ready' }
  | { type: 'kh-error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'data-warning'; message: string }
  // Debug mode only: the name of a keyhive (Rust/WASM) call, emitted just before
  // it runs. The main thread rings the last few so the crash banner can name the
  // call that trapped when the worker dies on a WASM `unreachable` panic.
  | { type: 'kh-trace'; method: string }
  | { type: 'peer-connected'; peerCount: number; peers: string[] }
  | { type: 'peer-disconnected'; peerCount: number; peers: string[] }
  | { type: 'ws-status'; connected: boolean }
  // A peer's sync transport flipped between a direct WebRTC channel and the relay.
  | { type: 'p2p-status'; peerId: string; transport: 'direct' | 'relay' }
  // New worker-owned doc API responses
  | { type: 'result'; id: number; result?: any; error?: string }
  // `cursors` = the resolved position of every token registered via
  // 'subscribe-cursors' for this sub's spansPath; null for a token that no
  // longer resolves (foreign, malformed, or absent from a pinned version).
  // `richTextFields` = every marker-bearing string field of the doc (see
  // `allRichText`), each with the spans that field's markers come from.
  | { type: 'query-result'; subId: number; result: any; heads: string[]; lastModified?: number; error?: string; spans?: RichTextSpan[]; cursors?: Record<string, number | null>; richTextFields?: MarkerField[] }
  | { type: 'update-presence'; docId: string; peers: Record<string, any> }
  // Document loading progress
  | { type: 'open-doc-progress'; id: number; pct: number; message: string }
  // Validation
  | { type: 'update-validation'; docId: string; errors: ValidationError[] }
  // Doc list / contact names push
  | { type: 'doc-list-updated'; list: Array<{ id: string; type?: string; name?: string; sharingGroupId?: string }> }
  | { type: 'friend-names-updated'; names: Record<string, string> }
  | { type: 'device-names-updated'; names: Record<string, string> }
  // Per-doc "has new changes since last viewed" state, pushed as a full map on
  // every transition. Absent docId = unknown (the doc has a last-viewed record
  // but hasn't loaded yet) — the UI shows no dot for absent entries.
  | { type: 'unseen-changes-updated'; unseen: Record<string, boolean> }
  // Keyhive state changed (membership/access may have changed)
  | { type: 'kh-state-changed' }
  // Rendezvous progress (emitted for both the sharer and the receiver so each
  // side can render a step-by-step indicator; the receiver also gets a `result`)
  | {
      type: 'kh-rdv-event';
      rendezvousId: string;
      status: RendezvousStatus;
      message?: string;
      // Set on the sharer's terminal 'received' event: the contact we added back,
      // and whether they sent a name (so the sharer's UI can prompt for one if not).
      friendGroupId?: string;
      friendHasName?: boolean;
    };
