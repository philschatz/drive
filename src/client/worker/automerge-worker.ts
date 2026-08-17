/**
 * Browser worker shell over the shared DriveEngine.
 *
 * All sync/keyhive/document logic now lives in src/shared/drive-engine.ts so it
 * can run in Node too (the CLI). This file is the browser-only host:
 *   - IndexedDB storage adapter + idb-storage-backed KVStore
 *   - a WebRTC-wrapped BrowserWebSocket network, with the shared overlay-frame
 *     intercept/sender (src/shared/relay-overlay.ts) on the raw socket
 *   - `emit` = self.postMessage
 * plus the browser transport plumbing: the onmessage queue, the message → engine
 * dispatch, and the hf-port / webrtc-port MessagePort handlers.
 */
import { installOverlayIntercept, makeOverlayFrameSender } from '../../shared/relay-overlay';
import { makeWebRTCRelayAdapter, type WebRTCRelayAdapter } from '../../shared/webrtc-relay-adapter';
import { RELAY_PEER_ID, PRODUCTION_RELAY_URL } from '../../shared/relay-identity';
import { errMsg } from '../../shared/keyhive-ops';
import { idbKvStore } from './idb-kvstore';
import { DriveEngine, type DriveEngineInstance } from '../../shared/drive-engine';
import type { EngineHost, EngineNetwork } from '../../shared/engine-host';
import type { MainToWorker, WorkerToMain, ValidationError } from '../../shared/worker-protocol';
import { createLogger } from '../../shared/logger';

const log = createLogger('worker');

// Re-export the message protocol so existing importers (worker-api.ts) are unaffected.
export type { MainToWorker, WorkerToMain, ValidationError };

// Mirror the main thread's message logging so each `[main] → send X` pairs with a
// `[worker] ← recv X`. Wrapping self.postMessage covers all send sites at once.
const origPostMessage = self.postMessage.bind(self);
(self as any).postMessage = (msg: any, ...rest: any[]) => {
  try { log.debug('→ send', msg?.type, msg); } catch { /* never let logging break a send */ }
  return (origPostMessage as any)(msg, ...rest);
};

function reportWorkerError(prefix: string, detail: unknown) {
  const message = (detail as any)?.message || String(detail ?? 'Unknown worker error');
  log.error(`${prefix}:`, detail);
  try {
    // Debug mode: name the most-recent keyhive (Rust/WASM) call so the main thread
    // can attach it to the crash banner. A WASM `unreachable` trap gives no hint of
    // which call panicked; this points straight at it. Sent before the warning so
    // the main thread has it recorded when either banner path fires.
    const lastKeyhiveCall = engine?.lastKeyhiveCall ?? null;
    if (lastKeyhiveCall) {
      (self as any).postMessage({ type: 'kh-trace', method: lastKeyhiveCall } satisfies WorkerToMain);
    }
    (self as any).postMessage({ type: 'data-warning', message } satisfies WorkerToMain);
  } catch { /* postMessage can fail if detail isn't structured-cloneable; message string is */ }
}
self.addEventListener('error', (e: ErrorEvent) => reportWorkerError('uncaught error', e.error ?? e.message));
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => reportWorkerError('unhandled rejection', e.reason));

// Queue messages that arrive while WASM/host initialization runs.
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Suppress the chatty log/debug/info firehose from the third-party keyhive bridge
// (warn/error pass through so real failures stay visible).
const SILENCED_LOG_PREFIXES = ['[AMRepoKeyhive]', '[Streaming]', '[Streaming+]'];
for (const level of ['log', 'debug', 'info'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && SILENCED_LOG_PREFIXES.some((p) => (args[0] as string).startsWith(p))) return;
    orig(...args);
  };
}

let engine: DriveEngineInstance | null = null;
let p2pAdapter: WebRTCRelayAdapter | null = null;
let pendingWebrtcPort: MessagePort | null = null;
/** The engine's inbound-rendezvous-frame handler (registered during engine.init). */
let rdvHandler: ((frame: any) => void) | null = null;
/** The engine's socket-(re)open handler — it re-sends the RELAY_WATCH declaration. */
let socketOpenHandler: (() => void) | null = null;

try {
  log.info('importing modules...');
  const repoModule: any = await import('@automerge/automerge-repo');
  const NetworkAdapterBase = repoModule.NetworkAdapter;
  const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb');
  const { BrowserWebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket');

  const secureStorage = new IndexedDBStorageAdapter('automerge-secure');
  const secureWs = new BrowserWebSocketClientAdapter(
    self.location?.protocol === 'https:'
      ? PRODUCTION_RELAY_URL
      : `ws://${self.location?.hostname || 'localhost'}:${self.location?.port || 3000}`
  );

  // Intercept overlay frames (rendezvous, WebRTC signaling, relay leave) off the
  // raw socket before the repo sees them, and write outbound overlay frames back
  // onto it — both shared with the CLI (src/shared/relay-overlay.ts).
  installOverlayIntercept(secureWs as any, {
    onRendezvous: (frame) => rdvHandler?.(frame),
    onWebRTCSignal: (frame) => p2pAdapter?.handleSignal(frame),
  });
  const sendOverlayFrame = makeOverlayFrameSender(secureWs);

  // Wrap the relay adapter so peers can be upgraded to direct WebRTC data channels.
  p2pAdapter = makeWebRTCRelayAdapter(NetworkAdapterBase, secureWs, {
    sendSignalFrame: sendOverlayFrame,
    onTransportChange: (peerId, transport) => {
      (self as any).postMessage({ type: 'p2p-status', peerId, transport } satisfies WorkerToMain);
    },
    relayPeerId: RELAY_PEER_ID,
  });
  if (pendingWebrtcPort) { p2pAdapter.attachPort(pendingWebrtcPort); pendingWebrtcPort = null; }

  // Surface raw socket open/close as ws-status. The open patch also notifies
  // the engine (after the adapter's own handler has sent `join` on the new
  // socket) so it re-sends its RELAY_WATCH declaration — the relay's discovery
  // state is per-socket, so every reconnect starts undeclared.
  const origSecureOpen = secureWs.onOpen;
  const origSecureClose = secureWs.onClose;
  secureWs.onOpen = () => {
    origSecureOpen();
    socketOpenHandler?.();
    (self as any).postMessage({ type: 'ws-status', connected: true } satisfies WorkerToMain);
  };
  secureWs.onClose = () => { origSecureClose(); (self as any).postMessage({ type: 'ws-status', connected: false } satisfies WorkerToMain); };

  const network: EngineNetwork = {
    networkAdapter: p2pAdapter,
    sendOverlayFrame,
    onRendezvousFrame: (handler) => { rdvHandler = handler; },
    onSocketOpen: (handler) => { socketOpenHandler = handler; },
  };

  const host: EngineHost = {
    storage: secureStorage,
    kv: idbKvStore,
    network,
    emit: (event) => { (self as any).postMessage(event); },
  };
  // Optional build-time override (test builds set VITE_SYNC_INTERVAL_MS to shrink
  // the cross-peer sync floor the E2E specs pay); invalid/unset ⇒ prod default.
  const rawSyncInterval = (import.meta as any)?.env?.VITE_SYNC_INTERVAL_MS;
  const syncRequestInterval = Number.isFinite(Number(rawSyncInterval)) && Number(rawSyncInterval) > 0
    ? Number(rawSyncInterval)
    : undefined;
  engine = new DriveEngine(host, { syncRequestInterval });
  log.info('host + engine ready');
} catch (err: any) {
  log.error('Failed to initialize:', err);
  (self as any).postMessage({ type: 'error', message: `Module load failed: ${errMsg(err)}` });
  throw err;
}

async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;
  log.debug('← recv', msg.type, msg);
  if (!engine) return;

  // Browser-only transport ports stay in the shell.
  if (msg.type === 'webrtc-port') {
    const port = (msg as any).port as MessagePort;
    if (p2pAdapter) p2pAdapter.attachPort(port);
    else pendingWebrtcPort = port;
    return;
  }
  await engine.handleMessage(msg);
}

// Replace queue handler with the real handler and drain.
log.info('module loaded, queued messages:', pendingMessages.length);
self.onmessage = handleMessage;
for (const msg of pendingMessages) void handleMessage(msg);
pendingMessages.length = 0;
