import { WebSocket } from 'ws';
import { Encoder, decode } from 'cbor-x';
import { logMessage, shortId } from './relay-log';
import { RELAY_PEER_ID } from '../shared/relay-identity';

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
}

function normalizeBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
