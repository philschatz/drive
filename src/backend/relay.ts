import { WebSocket } from 'ws';
import { Encoder, decode } from 'cbor-x';
import { logMessage, shortId } from './relay-log';
import { RELAY_PEER_ID } from '../shared/relay-identity';
import { RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER } from '../shared/rendezvous-protocol';

// Use the same encoder settings as @automerge/automerge-repo's cbor helper
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });

/**
 * Stateless WebSocket relay for identity-based message routing.
 *
 * When a peer connects the relay:
 *  1. Completes the automerge-repo peer handshake (join → peer).
 *  2. Announces all currently connected peers to the newcomer (extra "peer"
 *     messages) so each client discovers the others directly.
 *  3. Announces the newcomer to each existing peer symmetrically.
 *
 * After discovery, all messages are forwarded verbatim:
 *  - If a message has a targetId that matches a known peer → unicast.
 *  - Otherwise (targetId is the relay or absent) → broadcast to all others.
 *
 * The relay never interprets message content. The `data` field is treated as
 * opaque encrypted bytes and logged only by size.
 */
export class WebSocketRelay {
  private sockets = new Map<string, WebSocket>();
  /**
   * Encrypted rendezvous topics: rendezvousId → sockets currently listening.
   * Used to hand a large encrypted payload between two peers who only share a
   * short id+key (e.g. via a QR code). The relay never inspects `data`.
   */
  private rendezvous = new Map<string, Set<WebSocket>>();

  handleConnection(ws: WebSocket): void {
    let myPeerId: string | null = null;

    ws.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = normalizeBuffer(rawData);

      let message: any;
      try {
        message = decode(buf);
      } catch (e) {
        console.error('[relay] Failed to decode CBOR message:', e);
        return;
      }

      if (message.type === 'join') {
        myPeerId = message.senderId as string;
        logMessage('←', myPeerId, message);

        // Close any stale connection for this peer ID
        const existing = this.sockets.get(myPeerId);
        if (existing && existing !== ws) {
          existing.close();
        }
        this.sockets.set(myPeerId, ws);

        console.log(`[relay] ${this.sockets.size} peers connected`);

        const version = (message.supportedProtocolVersions as string[])?.[0] ?? '1';

        // Required handshake: relay acknowledges the new peer
        const ack = {
          type: 'peer',
          senderId: RELAY_PEER_ID,
          targetId: myPeerId,
          peerMetadata: {},
          selectedProtocolVersion: version,
        };
        ws.send(encoder.encode(ack));
        logMessage('→', myPeerId, ack);

        // Mutual peer discovery between the newcomer and all existing peers
        for (const [existingId, existingWs] of this.sockets) {
          if (existingId === myPeerId || existingWs.readyState !== WebSocket.OPEN) continue;

          // Introduce the existing peer to the newcomer
          const introToNewcomer = {
            type: 'peer',
            senderId: existingId,
            targetId: myPeerId,
            peerMetadata: {},
            selectedProtocolVersion: version,
          };
          ws.send(encoder.encode(introToNewcomer));
          logMessage('→', myPeerId, introToNewcomer);

          // Introduce the newcomer to the existing peer
          const introToExisting = {
            type: 'peer',
            senderId: myPeerId,
            targetId: existingId,
            peerMetadata: {},
            selectedProtocolVersion: version,
          };
          existingWs.send(encoder.encode(introToExisting));
          logMessage('→', existingId, introToExisting);
        }
      } else if (message.type === RDV_SUB || message.type === RDV_UNSUB || message.type === RDV_MSG) {
        this.handleRendezvous(ws, message);
      } else if (myPeerId) {
        logMessage('←', myPeerId, message);
        const targetId = message.targetId as string | undefined;

        if (targetId === RELAY_PEER_ID) {
          // Addressed to the relay's own identity. The relay is not a real
          // participant — keyhive peers probe it (e.g. sync-request-contact-card)
          // because it now decodes as a normal Identifier — so drop it rather
          // than broadcasting a message nobody can act on.
        } else if (targetId && this.sockets.has(targetId)) {
          // Unicast: deliver raw bytes to the named peer
          const targetWs = this.sockets.get(targetId)!;
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(buf);
            logMessage('→', targetId, message);
          }
        } else {
          // Broadcast: message has no specific target (or the target is gone)
          for (const [pid, peerWs] of this.sockets) {
            if (pid === myPeerId || peerWs.readyState !== WebSocket.OPEN) continue;
            peerWs.send(buf);
            logMessage('→', pid, message);
          }
        }
      }
    });

    ws.on('close', () => {
      // Drop this socket from any rendezvous topics it was listening on.
      for (const [rid, set] of this.rendezvous) {
        if (set.delete(ws) && set.size === 0) this.rendezvous.delete(rid);
      }
      if (myPeerId) {
        this.sockets.delete(myPeerId);
        console.log(`[relay] peer left: ${shortId(myPeerId)} (${this.sockets.size} remaining)`);

        // Notify remaining peers of the departure
        const leaveMsg = { type: 'leave', senderId: myPeerId };
        const leaveBytes = encoder.encode(leaveMsg);
        for (const [pid, peerWs] of this.sockets) {
          if (peerWs.readyState === WebSocket.OPEN) {
            peerWs.send(leaveBytes);
            logMessage('→', pid, leaveMsg);
          }
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`[relay] WebSocket error${myPeerId ? ` (${shortId(myPeerId)})` : ''}:`, err);
    });
  }

  /**
   * Route encrypted-rendezvous frames by `rendezvousId` (not peer id). The relay
   * keeps a per-topic socket set so two peers who only share a short id+key can
   * find each other and exchange one opaque encrypted blob.
   */
  private handleRendezvous(ws: WebSocket, message: any): void {
    const rid = message.rendezvousId as string | undefined;
    if (!rid) return;

    if (message.type === RDV_SUB) {
      let set = this.rendezvous.get(rid);
      if (!set) { set = new Set(); this.rendezvous.set(rid, set); }
      // Announce presence symmetrically: tell each existing listener a peer
      // arrived, and tell the newcomer about each existing listener.
      const peerMsg = encoder.encode({ type: RDV_PEER, rendezvousId: rid });
      for (const other of set) {
        if (other === ws || other.readyState !== WebSocket.OPEN) continue;
        other.send(peerMsg);
        if (ws.readyState === WebSocket.OPEN) ws.send(peerMsg);
      }
      set.add(ws);
      console.log(`[relay] rendezvous ${shortId(rid)}: ${set.size} listening`);
    } else if (message.type === RDV_UNSUB) {
      const set = this.rendezvous.get(rid);
      if (set && set.delete(ws) && set.size === 0) this.rendezvous.delete(rid);
    } else if (message.type === RDV_MSG) {
      const set = this.rendezvous.get(rid);
      if (!set) return;
      const fwd = encoder.encode({ type: RDV_MSG, rendezvousId: rid, data: message.data });
      for (const other of set) {
        if (other === ws || other.readyState !== WebSocket.OPEN) continue;
        other.send(fwd);
      }
    }
  }
}

function normalizeBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
