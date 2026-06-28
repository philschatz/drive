/**
 * WebRTC signaling — shared wire-frame constants and types.
 *
 * Imported by BOTH the backend relay (Node) and the client worker (browser) so
 * the wire contract can't drift. These frames ride the same relay WebSocket as
 * the automerge-repo protocol and the encrypted rendezvous channel, but carry
 * WebRTC session-description / ICE-candidate exchange so two peers that have
 * discovered each other through the relay can negotiate a *direct* RTCDataChannel.
 *
 * The relay unicasts a `WRTC_SIGNAL` frame to `targetId` and never inspects the
 * `signal` payload. Once a direct data channel is open, document sync rides it
 * instead of the relay; if negotiation fails (e.g. symmetric NAT with no TURN)
 * the peer simply keeps using the relay. See `rendezvous-protocol.ts` for the
 * sibling overlay-frame pattern this mirrors.
 */

export const WRTC_SIGNAL = 'wrtc-signal' as const;

/** True for a WebRTC signaling frame (used to short-circuit relay/repo routing). */
export function isWebRTCSignalType(type: unknown): boolean {
  return type === WRTC_SIGNAL;
}

/** One step of the offer/answer/ICE exchange. `candidate` is a plain
 *  RTCIceCandidateInit-shaped object; `sdp` is the session description string. */
export interface WebRTCSignal {
  kind: 'offer' | 'answer' | 'candidate';
  /** Present for kind 'offer' | 'answer'. */
  sdp?: string;
  /** Present for kind 'candidate' (RTCIceCandidateInit). */
  candidate?: unknown;
}

/**
 * A signaling frame routed by the relay to `targetId`.
 * `senderId` is the originating peer (so the receiver knows whom to answer).
 */
export interface WebRTCSignalFrame {
  type: typeof WRTC_SIGNAL;
  senderId: string;
  targetId: string;
  signal: WebRTCSignal;
}
