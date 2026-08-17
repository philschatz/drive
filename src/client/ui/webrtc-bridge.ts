/**
 * Main-thread WebRTC bridge — the browser shell around the portable core.
 *
 * The Automerge repo (and its network adapter) live in a Web Worker, but
 * `RTCPeerConnection` is a window-only API — it does not exist in Workers. So
 * the peer connections are owned here on the main thread, and bytes cross the
 * worker↔main boundary over a `MessagePort` (the same pattern the HyperFormula
 * worker uses, see `hf-bridge.ts`).
 *
 * All negotiation/retry/chunking logic lives in `src/shared/webrtc-bridge-core.ts`
 * (shared with the Node CLI peer); this wrapper contributes only what is
 * browser-specific: the real `RTCPeerConnection` constructor and the build-time
 * `VITE_ICE_SERVERS` override (`import.meta` is banned in src/shared).
 */

import { startWebRTCBridgeCore, type MinimalPeerConnection } from '../../shared/webrtc-bridge-core';
import { parseIceServers } from '../../shared/ice-config';

/**
 * Attach the bridge to a MessagePort whose other end is held by the worker's
 * WebRTCRelayAdapter. Returns a teardown function.
 */
export function startWebRTCBridge(port: MessagePort): () => void {
  return startWebRTCBridgeCore(port, {
    iceServers: parseIceServers((import.meta as any)?.env?.VITE_ICE_SERVERS),
    // The cast is type-level only: the DOM lib declares RTC event handlers
    // against its concrete Event classes, which the structural
    // MinimalPeerConnection deliberately doesn't require.
    createPeerConnection: (cfg) =>
      new RTCPeerConnection({ iceServers: cfg.iceServers }) as unknown as MinimalPeerConnection,
  });
}
