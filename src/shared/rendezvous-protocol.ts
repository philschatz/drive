/**
 * Encrypted relay rendezvous — shared message-type constants and types.
 *
 * Imported by BOTH the backend relay (Node) and the client worker (browser) so
 * the wire contract can't drift. The relay only routes `data` as opaque bytes;
 * it never sees the key or plaintext.
 *
 * Flow: a sharer picks a random `rendezvousId` + symmetric `key`, encodes them in
 * a QR/link, and subscribes to the id. The receiver subscribes to the same id;
 * the relay notifies both sides (`rdv-peer`), the sharer encrypts the payload
 * under `key` and sends it (`rdv-msg`), and the receiver decrypts it. This lets
 * arbitrarily large payloads (e.g. a 25 KB keyhive contact bundle) travel between
 * two peers while the QR stays tiny.
 */

export const RDV_SUB = 'rdv-sub' as const;
export const RDV_UNSUB = 'rdv-unsub' as const;
export const RDV_MSG = 'rdv-msg' as const;
export const RDV_PEER = 'rdv-peer' as const;

/** True for any rendezvous control/data frame (used to short-circuit routing). */
export function isRendezvousType(type: unknown): boolean {
  return type === RDV_SUB || type === RDV_UNSUB || type === RDV_MSG || type === RDV_PEER;
}

export interface RdvSubMsg { type: typeof RDV_SUB; rendezvousId: string }
export interface RdvUnsubMsg { type: typeof RDV_UNSUB; rendezvousId: string }
export interface RdvDataMsg { type: typeof RDV_MSG; rendezvousId: string; data: Uint8Array }
/** Relay → client: another peer is now present on this rendezvous id. */
export interface RdvPeerMsg { type: typeof RDV_PEER; rendezvousId: string }

export type RendezvousFrame = RdvSubMsg | RdvUnsubMsg | RdvDataMsg | RdvPeerMsg;
