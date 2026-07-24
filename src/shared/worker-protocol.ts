/**
 * Message protocol between the main thread (worker-api.ts) and the DriveEngine —
 * regardless of whether the engine runs inside a Web Worker (browser) or in-process
 * (the Node CLI). Extracted from automerge-worker.ts so the engine, the browser
 * worker shell, and the main-thread client all share one contract.
 */
import type { RendezvousStatus } from './rendezvous-protocol';

export type MainToWorker =
  | { type: 'init' }
  | { type: 'set-debug-mode'; id: number; enabled: boolean }
  | { type: 'set-presence-timing'; id: number; staleMs?: number; heartbeatMs?: number; livenessCheckMs?: number }
  | { type: 'clear-caches'; id: number }
  | { type: 'get-doc-list'; id: number }
  // `peek: true` = "don't count this read as the user viewing the doc" (home
  // page summary, source inspector/export, background tooling). Default
  // (absent) = viewing: the doc's last-viewed heads are updated, clearing its
  // new-changes indicator.
  | { type: 'query'; id: number; docId: string; filter: string; peek?: boolean }
  // New worker-owned doc API
  | { type: 'create-doc'; id: number; initialJson: any; metadata?: Record<string, any> }
  | { type: 'update-doc'; id: number; docId: string; fnSource: string; args: unknown[] }
  | { type: 'subscribe-query'; subId: number; docId: string; filter: string; peek?: boolean }
  | { type: 'unsubscribe-query'; subId: number }
  | { type: 'set-doc-version'; docId: string; version: number | null }
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
  | { type: 'set-contact-name'; id: number; agentId: string; name: string }
  | { type: 'remove-contact-name'; id: number; agentId: string }
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
  | { type: 'kh-link-device'; id: number; deviceAgentId: string; peerGroupId?: string | null }
  | { type: 'kh-get-link-payload'; id: number }
  | { type: 'kh-get-known-contacts'; id: number; excludeDocId?: string }
  // Encrypted relay rendezvous (large-payload contact exchange via QR id+key)
  | { type: 'kh-rdv-create-share'; id: number; displayName?: string }
  | { type: 'kh-rdv-receive'; id: number; rendezvousId: string; key: string; displayName?: string }
  | { type: 'kh-rdv-link-create'; id: number; deviceName?: string }
  | { type: 'kh-rdv-link-join'; id: number; rendezvousId: string; key: string; deviceName?: string }
  | { type: 'kh-rdv-cancel'; rendezvousId: string }
  | { type: 'open-doc'; id: number; docId: string }
  | { type: 'subscribe-validation'; docId: string }
  | { type: 'unsubscribe-validation'; docId: string }
  | { type: 'hf-port'; port: MessagePort }
  // Main-thread WebRTC bridge port (RTCPeerConnection lives on the main thread).
  | { type: 'webrtc-port'; port: MessagePort };

export type ValidationError = { path: (string | number)[]; message: string; kind?: 'schema' | 'dependency' | 'warning' };

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
  | { type: 'query-result'; subId: number; result: any; heads: string[]; lastModified?: number; error?: string }
  | { type: 'update-presence'; docId: string; peers: Record<string, any> }
  // Document loading progress
  | { type: 'open-doc-progress'; id: number; pct: number; message: string }
  // Validation
  | { type: 'update-validation'; docId: string; errors: ValidationError[] }
  // Doc list / contact names push
  | { type: 'doc-list-updated'; list: Array<{ id: string; type?: string; name?: string; sharingGroupId?: string }> }
  | { type: 'contact-names-updated'; names: Record<string, string> }
  | { type: 'device-names-updated'; names: Record<string, string> }
  // Per-doc "has new changes since last viewed" state, pushed as a full map on
  // every transition. Absent docId = unknown (the doc has a last-viewed record
  // but hasn't loaded yet) — the UI shows no dot for absent entries.
  | { type: 'unseen-changes-updated'; unseen: Record<string, boolean> }
  // Keyhive state changed (membership/access may have changed)
  | { type: 'kh-state-changed' }
  // Rendezvous progress (emitted for both the sharer and the receiver so each
  // side can render a step-by-step indicator; the receiver also gets a `result`)
  | { type: 'kh-rdv-event'; rendezvousId: string; status: RendezvousStatus; message?: string };
