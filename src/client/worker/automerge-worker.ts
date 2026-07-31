/**
 * Browser worker shell over the shared DriveEngine.
 *
 * All sync/keyhive/document logic now lives in src/shared/drive-engine.ts so it
 * can run in Node too (the CLI). This file is the browser-only host:
 *   - IndexedDB storage adapter + idb-storage-backed KVStore
 *   - a WebRTC-wrapped BrowserWebSocket network, with the raw-socket monkey-patch
 *     that intercepts rendezvous + WebRTC-signaling overlay frames
 *   - `emit` = self.postMessage
 * plus the browser transport plumbing: the onmessage queue, the message → engine
 * dispatch, and the hf-port / webrtc-port MessagePort handlers.
 */
import { decode as cborDecode, Encoder } from 'cbor-x';
import { isRendezvousType } from '../../shared/rendezvous-protocol';
import { isWebRTCSignalType, type WebRTCSignalFrame } from '../../shared/webrtc-signal';
import { makeWebRTCRelayAdapter, type WebRTCRelayAdapter } from './webrtc-relay-adapter';
import { RELAY_PEER_ID, PRODUCTION_RELAY_URL, isRelayLeaveFrame } from '../../shared/relay-identity';
import { errMsg } from '../../shared/keyhive-ops';
import { idbKvStore } from './idb-kvstore';
import { DriveEngine, type DriveEngineInstance } from '../../shared/drive-engine';
import type { EngineHost, EngineNetwork } from '../../shared/engine-host';
import type { MainToWorker, WorkerToMain, ValidationError } from '../../shared/worker-protocol';

// Re-export the message protocol so existing importers (worker-api.ts) are unaffected.
export type { MainToWorker, WorkerToMain, ValidationError };

// Mirror the main thread's message logging so each `[main] → send X` pairs with a
// `[worker] ← recv X`. Wrapping self.postMessage covers all send sites at once.
const origPostMessage = self.postMessage.bind(self);
(self as any).postMessage = (msg: any, ...rest: any[]) => {
  try { console.log('[worker] → send', msg?.type, msg); } catch { /* never let logging break a send */ }
  return (origPostMessage as any)(msg, ...rest);
};

function reportWorkerError(prefix: string, detail: unknown) {
  const message = (detail as any)?.message || String(detail ?? 'Unknown worker error');
  console.error(`[worker] ${prefix}:`, detail);
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

// ── Overlay-frame transport ──────────────────────────────────────────────────
// Rendezvous frames + WebRTC signaling ride the relay socket alongside the
// automerge-repo protocol. Same encoder settings as the repo's cbor helper.
const rdvEncoder = new Encoder({ tagUint8Array: false, useRecords: false });

let engine: DriveEngineInstance | null = null;
let p2pAdapter: WebRTCRelayAdapter | null = null;
let pendingWebrtcPort: MessagePort | null = null;
/** The engine's inbound-rendezvous-frame handler (registered during engine.init). */
let rdvHandler: ((frame: any) => void) | null = null;
/** The engine's socket-(re)open handler — it re-sends the RELAY_WATCH declaration. */
let socketOpenHandler: (() => void) | null = null;
/** The underlying relay WebSocket; rendezvous/signal frames bypass the repo adapter. */
let rdvSocket: WebSocket | undefined;

try {
  console.log('[worker] importing modules...');
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

  // Monkey-patch receiveMessage: rendezvous + WebRTC-signal frames ride the same
  // socket but aren't automerge-repo protocol — handle them, don't forward to the repo.
  const origReceive = secureWs.receiveMessage.bind(secureWs);
  (secureWs as any).receiveMessage = (bytes: Uint8Array) => {
    try {
      const decoded = cborDecode(new Uint8Array(bytes));
      if (isRendezvousType(decoded?.type)) { rdvHandler?.(decoded); return; }
      if (isWebRTCSignalType(decoded?.type)) { p2pAdapter?.handleSignal(decoded as WebRTCSignalFrame); return; }
      // The relay's departure broadcast — the stock adapter has no such message
      // type, so translate it into the peer-disconnected the repo understands.
      if (isRelayLeaveFrame(decoded)) {
        (secureWs as any).emit('peer-disconnected', { peerId: decoded.senderId });
        return;
      }
    } catch { /* not an overlay frame — fall through to the repo adapter */ }
    return origReceive(bytes);
  };
  // Expose the raw socket lazily (the adapter recreates it on reconnect).
  rdvSocket = (secureWs as any).socket;
  const origOnOpenForRdv = secureWs.onOpen;
  secureWs.onOpen = () => { rdvSocket = (secureWs as any).socket; origOnOpenForRdv(); };

  // Wrap the relay adapter so peers can be upgraded to direct WebRTC data channels.
  p2pAdapter = makeWebRTCRelayAdapter(NetworkAdapterBase, secureWs, {
    sendSignalFrame: (frame) => {
      if (rdvSocket && rdvSocket.readyState === WebSocket.OPEN) {
        rdvSocket.send(rdvEncoder.encode(frame) as unknown as ArrayBuffer);
      }
    },
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
    sendOverlayFrame: (frame) => {
      if (rdvSocket && rdvSocket.readyState === WebSocket.OPEN) {
        rdvSocket.send(rdvEncoder.encode(frame) as unknown as ArrayBuffer);
      }
    },
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
  console.log('[worker] host + engine ready');
} catch (err: any) {
  console.error('[worker] Failed to initialize:', err);
  (self as any).postMessage({ type: 'error', message: `Module load failed: ${errMsg(err)}` });
  throw err;
}

async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;
  console.log('[worker] ← recv', msg.type, msg);
  if (!engine) return;

  // Browser-only transport ports stay in the shell.
  if (msg.type === 'webrtc-port') {
    const port = (msg as any).port as MessagePort;
    if (p2pAdapter) p2pAdapter.attachPort(port);
    else pendingWebrtcPort = port;
    return;
  }
  if (msg.type === 'hf-port') {
    const hfPort = (msg as any).port as MessagePort;
    const post = (m: any) => hfPort.postMessage(m);
    hfPort.onmessage = async (pe: MessageEvent) => {
      const pm = pe.data;
      if (pm.type === 'subscribe-query') {
        try {
          // HyperFormula's cross-doc reads are machine-driven — always peek.
          await engine!.subscribeQuery(pm.docId, pm.subId, pm.filter, post, true);
        } catch (err: any) {
          post({ type: 'query-result', subId: pm.subId, result: null, heads: [], error: errMsg(err) });
        }
      } else if (pm.type === 'unsubscribe-query') {
        engine!.unsubscribeQuery(pm.subId);
      }
    };
    return;
  }

  await engine.handleMessage(msg);
}

// Replace queue handler with the real handler and drain.
console.log('[worker] module loaded, queued messages:', pendingMessages.length);
self.onmessage = handleMessage;
for (const msg of pendingMessages) void handleMessage(msg);
pendingMessages.length = 0;
