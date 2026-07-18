import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Encoder, decode } from 'cbor-x';
import { logMessage, shortId } from './relay-log';
import { RELAY_PEER_ID, RELAY_LEAVE } from '../shared/relay-identity';
import { RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER } from '../shared/rendezvous-protocol';
import { WRTC_SIGNAL } from '../shared/webrtc-signal';

// Use the same encoder settings as @automerge/automerge-repo's cbor helper
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });

// Read a positive integer from the environment, falling back to a default.
function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Largest WebSocket frame the relay will accept (`RELAY_MAX_PAYLOAD_BYTES`).
 *
 * The relay forwards whole automerge-repo protocol messages, and the initial
 * sync of a large document arrives as a single message that can be tens of MB.
 * 64 MiB comfortably fits that while still bounding what one hostile frame can
 * make the process allocate; `ws` itself closes the connection (1009) when a
 * frame exceeds it.
 */
export function relayMaxPayloadBytes(): number {
  return envInt('RELAY_MAX_PAYLOAD_BYTES', 64 * 1024 * 1024);
}

/**
 * WebSocketServer factory used by every relay entrypoint (relay-server, serve,
 * caldav-server, relay-plugin) so the payload bound is applied consistently.
 */
export function createRelayWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: relayMaxPayloadBytes() });
}

/**
 * Client IP for the per-IP connection cap. Behind a proxy (e.g. the Heroku
 * router) `socket.remoteAddress` is the proxy, so prefer the first
 * `x-forwarded-for` hop. That header is spoofable when no proxy fronts the
 * relay, but a spoofer only spreads itself across buckets — the global cap
 * still bounds the total.
 */
function clientIp(request?: IncomingMessage): string | undefined {
  const fwd = request?.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || request?.socket?.remoteAddress || undefined;
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
 *
 * Threat model: the relay is exposed to the public internet and every client
 * is untrusted. Malformed frames must be dropped (never crash the process),
 * peerIds are unauthenticated routing hints (anyone can claim any id), and
 * per-connection resource use must stay bounded.
 */
export class WebSocketRelay {
  private sockets = new Map<string, WebSocket>();
  /**
   * Encrypted rendezvous topics: rendezvousId → sockets currently listening.
   * Used to hand a large encrypted payload between two peers who only share a
   * short id+key (e.g. via a QR code). The relay never inspects `data`.
   */
  private rendezvous = new Map<string, Set<WebSocket>>();
  /** Open connections, total and per client IP, for the anti-DoS caps below. */
  private connectionCount = 0;
  private connectionsPerIp = new Map<string, number>();
  /** Liveness per connection for the heartbeat reaper (true = pong seen since last ping). */
  private heartbeats = new Map<WebSocket, boolean>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(opts?: { heartbeatMs?: number }) {
    this.heartbeatMs = opts?.heartbeatMs ?? envInt('RELAY_HEARTBEAT_MS', 30_000);
  }

  handleConnection(ws: WebSocket, request?: IncomingMessage): void {
    // Optional browser-origin allowlist (RELAY_ALLOWED_ORIGINS, comma-separated).
    // Default (unset): allow all. Requests without an Origin header (non-browser
    // clients like the CLI) are always allowed — Origin only stops cross-origin
    // browser abuse; it is trivially spoofable outside a browser.
    const allowedOrigins = (process.env.RELAY_ALLOWED_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request?.headers.origin;
    if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
      console.error(`[relay] refusing connection: origin ${origin} not allowed`);
      ws.on('error', () => {}); // a refused socket must not crash on transport errors
      ws.close(1008, 'origin not allowed');
      return;
    }

    // Connection caps: an attacker must not be able to exhaust the process by
    // holding sockets open. Per-IP when the upgrade request is available (all
    // production entrypoints pass it), plus a global ceiling either way.
    const ip = clientIp(request);
    const maxConnections = envInt('RELAY_MAX_CONNECTIONS', 1024);
    const maxPerIp = envInt('RELAY_MAX_CONNECTIONS_PER_IP', 64);
    if (this.connectionCount >= maxConnections || (ip !== undefined && (this.connectionsPerIp.get(ip) ?? 0) >= maxPerIp)) {
      console.error(`[relay] refusing connection${ip ? ` from ${ip}` : ''}: too many connections (${this.connectionCount} open)`);
      ws.on('error', () => {});
      ws.close(1013, 'relay at capacity'); // 1013 = Try Again Later
      return;
    }
    this.connectionCount++;
    if (ip !== undefined) this.connectionsPerIp.set(ip, (this.connectionsPerIp.get(ip) ?? 0) + 1);

    // Heartbeat: a peer that vanishes without a clean close (network drop,
    // laptop sleep) never fires 'close', so its slot — and its "online"
    // announcement to other peers — would leak forever. Ping every socket each
    // heartbeatMs and terminate any whose previous ping went unanswered;
    // terminate fires the 'close' handler below, which broadcasts the leave.
    // Browsers answer protocol-level pings automatically.
    this.heartbeats.set(ws, true);
    ws.on('pong', () => this.heartbeats.set(ws, true));
    this.startHeartbeat();

    let myPeerId: string | null = null;

    ws.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
      // `ws` emits 'message' synchronously: anything thrown here escapes as an
      // uncaughtException and would kill the whole process. The guards below
      // reject known-bad shapes; this catch is the backstop for the rest.
      try {
        this.handleMessage(ws, normalizeBuffer(rawData), myPeerId, (id) => { myPeerId = id; });
      } catch (e) {
        console.error('[relay] error handling message:', e);
      }
    });

    ws.on('close', () => {
      this.connectionCount--;
      if (ip !== undefined) {
        const remaining = (this.connectionsPerIp.get(ip) ?? 1) - 1;
        if (remaining <= 0) this.connectionsPerIp.delete(ip);
        else this.connectionsPerIp.set(ip, remaining);
      }

      // Drop this socket from any rendezvous topics it was listening on.
      for (const [rid, set] of this.rendezvous) {
        if (set.delete(ws) && set.size === 0) this.rendezvous.delete(rid);
      }
      this.heartbeats.delete(ws);
      if (this.heartbeats.size === 0 && this.heartbeatTimer !== null) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      // Only unregister if this socket still owns the id — a rejected duplicate
      // or replaced stale socket closing later must not evict the live one.
      if (myPeerId && this.sockets.get(myPeerId) === ws) {
        this.sockets.delete(myPeerId);
        console.log(`[relay] peer left: ${shortId(myPeerId)} (${this.sockets.size} remaining)`);

        // Notify remaining peers of the departure
        const leaveMsg = { type: RELAY_LEAVE, senderId: myPeerId };
        const leaveBytes = encoder.encode(leaveMsg);
        for (const [pid, peerWs] of this.sockets) {
          if (this.safeSend(peerWs, leaveBytes, pid)) logMessage('→', pid, leaveMsg);
        }
      }
    });

    ws.on('error', (err) => {
      console.error(`[relay] WebSocket error${myPeerId ? ` (${shortId(myPeerId)})` : ''}:`, err);
    });
  }

  /** Started with the first connection; stopped (in the close handler) with the last. */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, alive] of this.heartbeats) {
        if (ws.readyState !== WebSocket.OPEN) continue; // closing — 'close' cleans up
        if (!alive) { ws.terminate(); continue; }
        this.heartbeats.set(ws, false);
        ws.ping();
      }
    }, this.heartbeatMs);
    // Never hold the process open for the reaper alone.
    this.heartbeatTimer.unref();
  }

  private handleMessage(
    ws: WebSocket,
    buf: Buffer,
    myPeerId: string | null,
    setPeerId: (id: string) => void
  ): void {
    let message: any;
    try {
      message = decode(buf);
    } catch (e) {
      console.error('[relay] Failed to decode CBOR message:', e);
      return;
    }

    // CBOR happily decodes scalar frames (null/undefined/numbers/strings…).
    // Only object frames with a string `type` are protocol messages; anything
    // else is dropped so a one-byte frame (e.g. 0xf6) can't crash the relay.
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;

    if (message.type === 'join') {
      // senderId is an untrusted routing hint — require a sane string before it
      // touches the sockets map (real peerIds are ~50 chars of base64).
      const senderId = message.senderId;
      if (typeof senderId !== 'string' || senderId.length === 0 || senderId.length > 256) return;

      logMessage('←', senderId, message);

      // peerIds are public (broadcast during discovery) and unauthenticated, so
      // a newcomer claiming an already-connected id must never evict the
      // incumbent — otherwise any client could kick any peer offline. Reject
      // the newcomer instead; ids whose socket is no longer OPEN may be reused.
      const existing = this.sockets.get(senderId);
      if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
        console.error(`[relay] rejecting join: ${shortId(senderId)} is already connected`);
        ws.close(1008, 'peer id already connected');
        return;
      }
      setPeerId(senderId);
      myPeerId = senderId;
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
      if (this.safeSend(ws, encoder.encode(ack), myPeerId)) logMessage('→', myPeerId, ack);

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
        if (this.safeSend(ws, encoder.encode(introToNewcomer), myPeerId)) {
          logMessage('→', myPeerId, introToNewcomer);
        }

        // Introduce the newcomer to the existing peer
        const introToExisting = {
          type: 'peer',
          senderId: myPeerId,
          targetId: existingId,
          peerMetadata: {},
          selectedProtocolVersion: version,
        };
        if (this.safeSend(existingWs, encoder.encode(introToExisting), existingId)) {
          logMessage('→', existingId, introToExisting);
        }
      }
    } else if (message.type === RDV_SUB || message.type === RDV_UNSUB || message.type === RDV_MSG) {
      this.handleRendezvous(ws, message);
    } else if (message.type === WRTC_SIGNAL) {
      // WebRTC signaling (SDP offer/answer + ICE candidates). Unicast verbatim
      // to the named peer so two peers can negotiate a direct data channel.
      // The relay never inspects the `signal` payload, but it DOES require
      // senderId to be the sending socket's joined id: signaling drives
      // RTCPeerConnection setup/teardown on the receiver, so a client must not
      // be able to speak as another live peer (join squatting is rejected above).
      if (!myPeerId || message.senderId !== myPeerId) return;
      const targetId = typeof message.targetId === 'string' ? message.targetId : undefined;
      logMessage('←', myPeerId, message);
      if (targetId && this.sockets.has(targetId)) {
        const targetWs = this.sockets.get(targetId)!;
        if (this.safeSend(targetWs, buf, targetId)) logMessage('→', targetId, message);
      }
    } else if (myPeerId) {
      logMessage('←', myPeerId, message);
      const targetId = typeof message.targetId === 'string' ? message.targetId : undefined;

      if (targetId === RELAY_PEER_ID) {
        // Addressed to the relay's own identity. The relay is not a real
        // participant — keyhive peers probe it (e.g. sync-request-contact-card)
        // because it now decodes as a normal Identifier — so drop it rather
        // than broadcasting a message nobody can act on.
      } else if (targetId && this.sockets.has(targetId)) {
        // Unicast: deliver raw bytes to the named peer
        const targetWs = this.sockets.get(targetId)!;
        if (this.safeSend(targetWs, buf, targetId)) logMessage('→', targetId, message);
      } else {
        // Broadcast: message has no specific target (or the target is gone)
        for (const [pid, peerWs] of this.sockets) {
          if (pid === myPeerId) continue;
          if (this.safeSend(peerWs, buf, pid)) logMessage('→', pid, message);
        }
      }
    }
  }

  /**
   * Forward bytes to a peer unless its socket is too far behind. `ws.send`
   * queues without bound, so a peer that stops reading would otherwise make
   * the relay buffer its traffic until the process dies. Disconnect it
   * instead — clients reconnect and resync. Threshold: RELAY_MAX_BUFFERED_BYTES,
   * default 2× the max payload so one legitimately large sync frame in flight
   * never trips it.
   */
  private safeSend(ws: WebSocket, bytes: Buffer | Uint8Array, peerLabel: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const maxBuffered = envInt('RELAY_MAX_BUFFERED_BYTES', 2 * relayMaxPayloadBytes());
    if (ws.bufferedAmount > maxBuffered) {
      console.error(`[relay] ${shortId(peerLabel)} is ${ws.bufferedAmount} bytes behind (limit ${maxBuffered}) — disconnecting slow peer`);
      ws.terminate();
      return false;
    }
    ws.send(bytes);
    return true;
  }

  /**
   * Route encrypted-rendezvous frames by `rendezvousId` (not peer id). The relay
   * keeps a per-topic socket set so two peers who only share a short id+key can
   * find each other and exchange one opaque encrypted blob.
   */
  private handleRendezvous(ws: WebSocket, message: any): void {
    const rid = message.rendezvousId;
    // rendezvousId is untrusted input used as a Map key — require a sane string.
    if (typeof rid !== 'string' || rid.length === 0 || rid.length > 256) return;

    if (message.type === RDV_SUB) {
      let set = this.rendezvous.get(rid);
      if (!set) { set = new Set(); this.rendezvous.set(rid, set); }
      // Announce presence symmetrically: tell each existing listener a peer
      // arrived, and tell the newcomer about each existing listener.
      const peerMsg = encoder.encode({ type: RDV_PEER, rendezvousId: rid });
      for (const other of set) {
        if (other === ws || other.readyState !== WebSocket.OPEN) continue;
        this.safeSend(other, peerMsg, rid);
        this.safeSend(ws, peerMsg, rid);
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
        if (other === ws) continue;
        this.safeSend(other, fwd, rid);
      }
    }
  }
}

function normalizeBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
