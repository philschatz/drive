/**
 * Relay overlay-frame plumbing, shared by the browser worker and the Node CLI.
 *
 * Three overlay protocols ride the relay WebSocket alongside the automerge-repo
 * sync protocol: the encrypted rendezvous channel (RDV_*), WebRTC signaling
 * (WRTC_SIGNAL), and the relay's departure broadcast (`leave`). None of them are
 * repo messages — handed to the repo they'd be dropped with an "invalid message"
 * warning — so they must be intercepted off the raw socket before the stock
 * adapter forwards them, and written back onto the raw socket (bypassing the
 * repo adapter) on the way out.
 */
import { decode as cborDecode, Encoder } from 'cbor-x';
import { isRendezvousType } from './rendezvous-protocol';
import { isRelayLeaveFrame } from './relay-identity';
import { isWebRTCSignalType, type WebRTCSignalFrame } from './webrtc-signal';

/** The slice of WebSocketClientAdapter the intercept touches. */
interface InterceptableAdapter {
  receiveMessage(bytes: Uint8Array): void;
  emit(event: string, payload?: unknown): void;
}

export interface OverlayHandlers {
  onRendezvous: (frame: any) => void;
  onWebRTCSignal: (frame: WebRTCSignalFrame) => void;
}

/**
 * Monkey-patch `receiveMessage` so overlay frames reach their handlers and the
 * repo only ever sees genuine automerge-repo protocol bytes. A `leave` frame is
 * translated into the `peer-disconnected` the repo understands (the stock
 * adapter has no such message type).
 */
export function installOverlayIntercept(wsAdapter: InterceptableAdapter, handlers: OverlayHandlers): void {
  const origReceive = wsAdapter.receiveMessage.bind(wsAdapter);
  wsAdapter.receiveMessage = (bytes: Uint8Array) => {
    try {
      const decoded = cborDecode(new Uint8Array(bytes));
      if (isRendezvousType(decoded?.type)) { handlers.onRendezvous(decoded); return; }
      if (isWebRTCSignalType(decoded?.type)) { handlers.onWebRTCSignal(decoded as WebRTCSignalFrame); return; }
      if (isRelayLeaveFrame(decoded)) {
        wsAdapter.emit('peer-disconnected', { peerId: decoded.senderId });
        return;
      }
    } catch { /* not an overlay frame — fall through to the repo adapter */ }
    return origReceive(bytes);
  };
}

// Same CBOR settings as the relay so frames round-trip byte-identically.
const overlayEncoder = new Encoder({ tagUint8Array: false, useRecords: false });

/**
 * Build the outbound half: a closure that CBOR-encodes an overlay frame onto
 * the adapter's current raw socket, silently dropping it when the socket isn't
 * OPEN (overlay frames are best-effort by design). The socket is read lazily on
 * every send — the adapter recreates it on each reconnect, and the keyhive
 * integration may re-wrap the adapter itself.
 */
export function makeOverlayFrameSender(wsAdapter: unknown): (frame: unknown) => void {
  return (frame) => {
    const sock: any = (wsAdapter as any).socket;
    if (sock && sock.readyState === 1 /* OPEN */) sock.send(overlayEncoder.encode(frame));
  };
}
