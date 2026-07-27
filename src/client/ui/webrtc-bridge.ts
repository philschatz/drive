/**
 * Main-thread WebRTC bridge.
 *
 * The Automerge repo (and its network adapter) live in a Web Worker, but
 * `RTCPeerConnection` is a window-only API — it does not exist in Workers. So
 * the actual peer connections and data channels are owned here on the main
 * thread, and bytes cross the worker↔main boundary over a `MessagePort` (the
 * same pattern the HyperFormula worker uses, see `hf-bridge.ts`).
 *
 * The worker's `WebRTCRelayAdapter` (see `webrtc-relay-adapter.ts`) drives this
 * bridge: it decides when to attempt a connection (on relay peer discovery) and
 * pumps signaling frames between the relay socket and this bridge. Once a data
 * channel opens, the adapter routes that peer's sync traffic through it instead
 * of the relay; if it never opens, the relay keeps working unchanged.
 *
 * Negotiation is best-effort and self-healing: a watchdog retries (fresh offer)
 * if a channel does not open in time — trickle-ICE/offer frames can be dropped,
 * and ICE can stall in `checking` with no `failed` event — then gives up after a
 * few attempts and leaves that peer on the relay.
 */

import type { WebRTCSignal } from '../../shared/webrtc-signal';
import { frameMessage, FrameReassembler, FrameOverflowError } from '../webrtc-chunk';

/** Worker → bridge commands. */
export type WorkerToBridgeMsg =
  | { kind: 'connect-peer'; peerId: string; initiator: boolean }
  | { kind: 'disconnect-peer'; peerId: string }
  | { kind: 'signal-in'; peerId: string; signal: WebRTCSignal }
  | { kind: 'data-out'; peerId: string; bytes: Uint8Array };

/** Bridge → worker events. */
export type BridgeToWorkerMsg =
  | { kind: 'signal-out'; peerId: string; signal: WebRTCSignal }
  | { kind: 'channel-open'; peerId: string }
  | { kind: 'channel-closed'; peerId: string }
  | { kind: 'data-in'; peerId: string; bytes: Uint8Array };

/** Reliable, ordered channel label (TCP-like) for automerge sync messages. */
const DATA_CHANNEL_LABEL = 'drive-sync';
/** Retry negotiation if no channel opens within this window. */
const NEGOTIATION_TIMEOUT_MS = 6_000;
/** Give up (stay on the relay) after this many failed negotiation attempts. */
const MAX_NEGOTIATION_RETRIES = 4;
/**
 * Hard cap on simultaneously-allocated RTCPeerConnections (open + negotiating).
 * Legitimate swarms are far smaller; peers beyond the cap simply stay on the
 * relay, so an attacker announced by the relay can't force unbounded peer
 * connections + watchdog timers.
 */
const MAX_PEER_CONNECTIONS = 32;

/** Default public STUN servers (no TURN — symmetric-NAT peers stay on the relay). */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

function resolveIceServers(): RTCIceServer[] {
  // Optional build-time override: VITE_ICE_SERVERS = JSON array of RTCIceServer.
  try {
    const raw = (import.meta as any)?.env?.VITE_ICE_SERVERS;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (err) {
    console.warn('[webrtc] invalid VITE_ICE_SERVERS, using defaults:', err);
  }
  return DEFAULT_ICE_SERVERS;
}

interface PeerConn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  open: boolean;
  initiator: boolean;
  /** ICE candidates received before the remote description was applied. */
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  /** Watchdog that retries negotiation if the channel doesn't open in time. */
  openTimer: ReturnType<typeof setTimeout> | null;
  /** Reassembles inbound chunked frames back into whole sync messages. */
  reasm: FrameReassembler;
}

/**
 * Attach the bridge to a MessagePort whose other end is held by the worker's
 * WebRTCRelayAdapter. Returns a teardown function.
 */
export function startWebRTCBridge(port: MessagePort): () => void {
  const iceServers = resolveIceServers();
  const peers = new Map<string, PeerConn>();
  const retryCounts = new Map<string, number>();

  const post = (msg: BridgeToWorkerMsg, transfer?: Transferable[]) =>
    transfer ? port.postMessage(msg, transfer) : port.postMessage(msg);

  function teardownPeer(peerId: string): void {
    const entry = peers.get(peerId);
    if (!entry) return;
    peers.delete(peerId);
    if (entry.openTimer) clearTimeout(entry.openTimer);
    try { entry.dc?.close(); } catch { /* already closed */ }
    try { entry.pc.close(); } catch { /* already closed */ }
    if (entry.open) post({ kind: 'channel-closed', peerId });
  }

  /** Retry a stalled negotiation (or give up and stay on the relay). */
  function retryNegotiation(peerId: string): void {
    const entry = peers.get(peerId);
    if (!entry || entry.open) return;
    const count = retryCounts.get(peerId) ?? 0;
    if (count >= MAX_NEGOTIATION_RETRIES) {
      teardownPeer(peerId); // give up — the relay keeps syncing this peer
      return;
    }
    retryCounts.set(peerId, count + 1);
    const initiator = entry.initiator;
    teardownPeer(peerId);
    getOrCreatePeer(peerId, initiator);
  }

  function armWatchdog(peerId: string, entry: PeerConn): void {
    if (entry.openTimer) clearTimeout(entry.openTimer);
    entry.openTimer = setTimeout(() => retryNegotiation(peerId), NEGOTIATION_TIMEOUT_MS);
  }

  function wireDataChannel(peerId: string, entry: PeerConn, dc: RTCDataChannel): void {
    entry.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      entry.open = true;
      if (entry.openTimer) { clearTimeout(entry.openTimer); entry.openTimer = null; }
      retryCounts.delete(peerId);
      post({ kind: 'channel-open', peerId });
    };
    dc.onclose = () => {
      if (entry.open) {
        entry.open = false;
        post({ kind: 'channel-closed', peerId });
      }
    };
    dc.onerror = () => { /* surfaced via onclose / ICE state */ };
    dc.onmessage = (e: MessageEvent) => {
      const frame = e.data instanceof ArrayBuffer
        ? new Uint8Array(e.data)
        : new Uint8Array(e.data as ArrayBufferLike);
      // Frames arrive chunked (see webrtc-chunk); deliver only once a whole
      // message has been reassembled. The result is a fresh buffer owned solely
      // by the worker after transfer. The reassembler enforces hard size/frame
      // bounds — a peer that exceeds them (e.g. streams never-final frames) is
      // hostile or broken, so drop its channel; sync falls back to the relay.
      let full: Uint8Array | null;
      try {
        full = entry.reasm.push(frame);
      } catch (err) {
        if (err instanceof FrameOverflowError) console.warn('[webrtc] closing channel to', peerId, '—', err.message);
        else console.warn('[webrtc] closing channel to', peerId, 'after reassembly failure:', err);
        teardownPeer(peerId);
        return;
      }
      if (full) post({ kind: 'data-in', peerId, bytes: full }, [full.buffer]);
    };
  }

  function getOrCreatePeer(peerId: string, initiator: boolean): PeerConn | null {
    let entry = peers.get(peerId);
    if (entry) return entry;
    if (peers.size >= MAX_PEER_CONNECTIONS) {
      // Refuse to allocate beyond the cap — this peer stays on the relay.
      console.warn(`[webrtc] peer-connection cap (${MAX_PEER_CONNECTIONS}) reached — not negotiating with`, peerId);
      return null;
    }

    const pc = new RTCPeerConnection({ iceServers });
    entry = { pc, dc: null, open: false, initiator, pendingCandidates: [], remoteDescSet: false, openTimer: null, reasm: new FrameReassembler() };
    peers.set(peerId, entry);

    pc.onicecandidate = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate) {
        post({ kind: 'signal-out', peerId, signal: { kind: 'candidate', candidate: e.candidate.toJSON() } });
      }
    };
    pc.oniceconnectionstatechange = () => {
      // A stalled or failed connection is retried by the watchdog; 'failed'
      // short-circuits the wait so we recover faster than the timeout.
      if (pc.iceConnectionState === 'failed' && !entry!.open) retryNegotiation(peerId);
    };

    if (initiator) {
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      wireDataChannel(peerId, entry, dc);
      void (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          post({ kind: 'signal-out', peerId, signal: { kind: 'offer', sdp: offer.sdp } });
        } catch (err) {
          console.warn('[webrtc] offer failed for', peerId, err);
          retryNegotiation(peerId);
        }
      })();
    } else {
      // Responder: the channel arrives via the initiator's offer.
      pc.ondatachannel = (e: RTCDataChannelEvent) => wireDataChannel(peerId, entry!, e.channel);
    }
    armWatchdog(peerId, entry);
    return entry;
  }

  async function flushCandidates(entry: PeerConn): Promise<void> {
    const pending = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const c of pending) {
      try { await entry.pc.addIceCandidate(c); } catch (err) { console.warn('[webrtc] addIceCandidate (flush) failed:', err); }
    }
  }

  async function handleSignal(peerId: string, signal: WebRTCSignal): Promise<void> {
    if (signal.kind === 'offer') {
      // A fresh offer supersedes any stale/half-negotiated connection (e.g. the
      // initiator retried). Start clean so setRemoteDescription is in a valid state.
      let entry = peers.get(peerId);
      if (entry && (entry.remoteDescSet || entry.open)) { teardownPeer(peerId); entry = undefined; }
      entry = entry ?? getOrCreatePeer(peerId, false) ?? undefined;
      if (!entry) return;
      try {
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        entry.remoteDescSet = true;
        await flushCandidates(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        post({ kind: 'signal-out', peerId, signal: { kind: 'answer', sdp: answer.sdp } });
      } catch (err) {
        console.warn('[webrtc] handleSignal(offer) failed for', peerId, err);
      }
      return;
    }

    // answer / candidate: drive the existing connection (create lazily if needed).
    const entry = getOrCreatePeer(peerId, false);
    if (!entry) return;
    try {
      if (signal.kind === 'answer') {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        entry.remoteDescSet = true;
        await flushCandidates(entry);
      } else if (signal.kind === 'candidate') {
        const init = signal.candidate as RTCIceCandidateInit;
        if (entry.remoteDescSet) await entry.pc.addIceCandidate(init);
        else entry.pendingCandidates.push(init);
      }
    } catch (err) {
      console.warn('[webrtc] handleSignal(' + signal.kind + ') failed for', peerId, err);
    }
  }

  port.onmessage = (e: MessageEvent<WorkerToBridgeMsg>) => {
    const msg = e.data;
    switch (msg.kind) {
      case 'connect-peer':
        getOrCreatePeer(msg.peerId, msg.initiator);
        break;
      case 'disconnect-peer':
        retryCounts.delete(msg.peerId);
        teardownPeer(msg.peerId);
        break;
      case 'signal-in':
        void handleSignal(msg.peerId, msg.signal);
        break;
      case 'data-out': {
        const entry = peers.get(msg.peerId);
        if (entry?.dc && entry.open) {
          // Chunk into frames small enough for the channel's maxMessageSize; a
          // large sync message would otherwise be rejected outright.
          try {
            for (const frame of frameMessage(msg.bytes)) entry.dc.send(frame as unknown as ArrayBuffer);
          } catch (err) { console.warn('[webrtc] dc.send failed:', err); }
        }
        break;
      }
    }
  };

  return () => {
    for (const peerId of [...peers.keys()]) teardownPeer(peerId);
    retryCounts.clear();
    port.onmessage = null;
    try { port.close(); } catch { /* ignore */ }
  };
}
