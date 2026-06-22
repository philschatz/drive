import { WebSocket } from 'ws';
import { Encoder, decode } from 'cbor-x';

// Use the same encoder settings as @automerge/automerge-repo's cbor helper
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });

const RELAY_PEER_ID = `relay-${Math.random().toString(36).slice(2, 10)}`;

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 6) + '…' : id;
}

// Render bytes as printable ASCII, replacing non-printable/high bytes with '.'
function sanitizeAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
    .join('');
}

function describeData(data: unknown): string {
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const prefix = sanitizeAscii(data.subarray(0, 10));
    const suffix = sanitizeAscii(data.subarray(Math.max(0, data.length - 10)));
    // Simple FNV-1a 32-bit checksum for cheap payload fingerprinting
    let hash = 0x811c9dc5;
    for (const b of data) {
      hash = (Math.imul(hash ^ b, 0x01000193) >>> 0);
    }
    const checksum = hash.toString(16).padStart(8, '0');
    return `[hash=${checksum} ${data.length} bytes, "${prefix}…${suffix}"]`;
  }
  return `[unknown size]`;
}

function logMessage(dir: '←' | '→', peerId: string, message: any) {
  const type = message.type ?? '?';
  const parts = [`[relay] ${dir} ${shortId(peerId)} ${type}`];

  if (message.senderId) parts.push(`from=${shortId(message.senderId)}`);
  if (message.targetId) parts.push(`to=${shortId(message.targetId)}`);
  if (message.documentId) parts.push(`doc=${shortId(message.documentId)}`);
  if (message.count !== undefined) parts.push(`count=${message.count}`);
  if (message.sessionId) parts.push(`session=${message.sessionId}`);

  if (message.data != null) {
    parts.push(`data=${describeData(message.data)}`);
  }

  if (message.peerMetadata) {
    const meta = message.peerMetadata;
    const metaParts: string[] = [];
    if (meta.storageId) metaParts.push(`storageId=${shortId(meta.storageId)}`);
    if (meta.isEphemeral !== undefined) metaParts.push(`ephemeral=${meta.isEphemeral}`);
    if (metaParts.length > 0) parts.push(`meta={${metaParts.join(', ')}}`);
  }

  if (message.supportedProtocolVersions) {
    parts.push(`versions=[${message.supportedProtocolVersions.join(',')}]`);
  }
  if (message.selectedProtocolVersion) {
    parts.push(`version=${message.selectedProtocolVersion}`);
  }

  console.log(parts.join(' '));
}

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

        if (targetId && targetId !== RELAY_PEER_ID && this.sockets.has(targetId)) {
          // Unicast: deliver raw bytes to the named peer
          const targetWs = this.sockets.get(targetId)!;
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(buf);
            logMessage('→', targetId, message);
          }
        } else {
          // Broadcast: message addressed to relay or has no specific target
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
