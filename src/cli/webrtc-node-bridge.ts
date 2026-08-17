/**
 * Node-side WebRTC bridge — the CLI shell around the portable core.
 *
 * Unlike the browser (repo in a Worker, RTCPeerConnection window-only), one
 * Node process owns both the repo and the peer connections, so the MessagePort
 * pair connecting the `WebRTCRelayAdapter` to this bridge is in-process (a
 * plain `new MessageChannel()` in cli.ts). This wrapper contributes only the
 * Node-specific pieces: the werift driver and the runtime `DRIVE_ICE_SERVERS`
 * override (the browser sibling reads the build-time `VITE_ICE_SERVERS`).
 */
import { startWebRTCBridgeCore } from '../shared/webrtc-bridge-core';
import { parseIceServers } from '../shared/ice-config';
import { createWeriftPeerConnection } from './werift-rtc';

/**
 * Attach the bridge to a MessagePort whose other end is held by the CLI's
 * WebRTCRelayAdapter. Returns a teardown function (closes every peer
 * connection and the port — Node MessagePorts keep the event loop alive).
 */
export function startNodeWebRTCBridge(port: MessagePort): () => void {
  return startWebRTCBridgeCore(port, {
    iceServers: parseIceServers(process.env.DRIVE_ICE_SERVERS),
    createPeerConnection: createWeriftPeerConnection,
  });
}
