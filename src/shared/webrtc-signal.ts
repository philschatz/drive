/**
 * WebRTC signaling — the message type and the shape of one signal.
 *
 * Two devices that already hold a secure-channel session negotiate a *direct*
 * RTCDataChannel by exchanging a session description and ICE candidates. Those
 * travel as ordinary **sealed secure-channel messages** of type `WRTC_SIGNAL`
 * (keyhive-repo.ts wires them between the channel and the WebRTC adapter): the
 * relay carries them like any other sealed frame and can neither read the
 * addresses in them nor alter the session they describe.
 *
 * Signaling used to be a relay overlay frame, in the clear and sent to whatever
 * socket the relay introduced — which handed this device's LAN and public
 * addresses to the relay and to anything able to get itself introduced. The
 * relay no longer forwards that frame, and a client ignores one if it arrives
 * (relay-overlay.ts): only a peer that has proved its key, and that this device
 * is related to, is ever negotiated with.
 *
 * Once a direct data channel is open, the peer's traffic rides it instead of
 * the relay; if negotiation fails (e.g. symmetric NAT with no TURN) the peer
 * simply stays on the relay.
 */

export const WRTC_SIGNAL = 'wrtc-signal' as const;

/** True for the legacy relay-level signaling frame (dropped by relay and client alike). */
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
