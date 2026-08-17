/**
 * WebRTC bridge core — the runtime-neutral half of the direct-channel upgrade.
 *
 * Owns the peer connections and data channels for the `WebRTCRelayAdapter`
 * (`webrtc-relay-adapter.ts`), which drives it over a MessagePort: the adapter
 * decides when to attempt a connection (on relay peer discovery) and pumps
 * signaling frames between the relay socket and this bridge. Once a data
 * channel opens, the adapter routes that peer's sync traffic through it instead
 * of the relay; if it never opens, the relay keeps working unchanged.
 *
 * The RTC implementation is injected (`createPeerConnection`), because each
 * host has a different one:
 *   - browser: the window-only `RTCPeerConnection`, wrapped by
 *     `src/client/ui/webrtc-bridge.ts` (the repo lives in a Worker, so bytes
 *     cross the worker↔main boundary over the port);
 *   - Node CLI: a werift-backed driver (`src/cli/werift-rtc.ts`), with the
 *     port pair living in-process.
 * The structural Minimal* types below name exactly the API surface this core
 * touches — a driver satisfies them, it does not extend any platform class.
 *
 * Negotiation is best-effort and self-healing: a watchdog retries (fresh offer)
 * if a channel does not open in time — trickle-ICE/offer frames can be dropped,
 * and ICE can stall in `checking` with no `failed` event — then gives up after a
 * few attempts and leaves that peer on the relay.
 */

import type { WebRTCSignal } from './webrtc-signal';
import { frameMessage, FrameReassembler, FrameOverflowError } from './webrtc-chunk';
import type { WorkerToBridgeMsg, BridgeToWorkerMsg } from './worker-protocol';
import type { IceServer } from './ice-config';
import { createLogger } from './logger';

const log = createLogger('webrtc');

/** Reliable, ordered channel label (TCP-like) for automerge sync messages. */
export const DATA_CHANNEL_LABEL = 'drive-sync';
/** Retry negotiation if no channel opens within this window. */
export const NEGOTIATION_TIMEOUT_MS = 6_000;
/** Give up (stay on the relay) after this many failed negotiation attempts. */
export const MAX_NEGOTIATION_RETRIES = 4;
/**
 * Hard cap on simultaneously-allocated peer connections (open + negotiating).
 * Legitimate swarms are far smaller; peers beyond the cap simply stay on the
 * relay, so an attacker announced by the relay can't force unbounded peer
 * connections + watchdog timers.
 */
export const MAX_PEER_CONNECTIONS = 32;

/** An offer/answer session description (structural RTCSessionDescriptionInit). */
export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp?: string;
}

/** The slice of RTCDataChannel the core touches. */
export interface MinimalDataChannel {
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

/** The slice of RTCPeerConnection the core touches. */
export interface MinimalPeerConnection {
  iceConnectionState: string;
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  ondatachannel: ((e: { channel: MinimalDataChannel }) => void) | null;
  createDataChannel(label: string, init: { ordered: boolean }): MinimalDataChannel;
  createOffer(): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(desc: SessionDescription): Promise<void>;
  setRemoteDescription(desc: SessionDescription): Promise<void>;
  /** `candidate` is an RTCIceCandidateInit-shaped plain object off the wire. */
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
}

export interface WebRTCBridgeCoreOptions {
  iceServers: IceServer[];
  createPeerConnection(config: { iceServers: IceServer[] }): MinimalPeerConnection;
}

interface PeerConn {
  pc: MinimalPeerConnection;
  dc: MinimalDataChannel | null;
  open: boolean;
  initiator: boolean;
  /** ICE candidates received before the remote description was applied. */
  pendingCandidates: unknown[];
  remoteDescSet: boolean;
  /** Watchdog that retries negotiation if the channel doesn't open in time. */
  openTimer: ReturnType<typeof setTimeout> | null;
  /** Reassembles inbound chunked frames back into whole sync messages. */
  reasm: FrameReassembler;
}

/**
 * Attach the bridge to a MessagePort whose other end is held by the
 * WebRTCRelayAdapter. Returns a teardown function.
 */
export function startWebRTCBridgeCore(port: MessagePort, opts: WebRTCBridgeCoreOptions): () => void {
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

  function wireDataChannel(peerId: string, entry: PeerConn, dc: MinimalDataChannel): void {
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
    dc.onmessage = (e: { data: unknown }) => {
      // Buffer (Node) is already a Uint8Array; the browser delivers ArrayBuffer.
      const frame = e.data instanceof Uint8Array
        ? e.data
        : e.data instanceof ArrayBuffer
          ? new Uint8Array(e.data)
          : new Uint8Array(e.data as ArrayBufferLike);
      // Frames arrive chunked (see webrtc-chunk); deliver only once a whole
      // message has been reassembled. The result is a fresh buffer owned solely
      // by the adapter after transfer. The reassembler enforces hard size/frame
      // bounds — a peer that exceeds them (e.g. streams never-final frames) is
      // hostile or broken, so drop its channel; sync falls back to the relay.
      let full: Uint8Array | null;
      try {
        full = entry.reasm.push(frame);
      } catch (err) {
        if (err instanceof FrameOverflowError) log.warn('closing channel to', peerId, '—', err.message);
        else log.warn('closing channel to', peerId, 'after reassembly failure:', err);
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
      log.warn(`peer-connection cap (${MAX_PEER_CONNECTIONS}) reached — not negotiating with`, peerId);
      return null;
    }

    const pc = opts.createPeerConnection({ iceServers: opts.iceServers });
    entry = { pc, dc: null, open: false, initiator, pendingCandidates: [], remoteDescSet: false, openTimer: null, reasm: new FrameReassembler() };
    peers.set(peerId, entry);

    pc.onicecandidate = (e) => {
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
          log.warn('offer failed for', peerId, err);
          retryNegotiation(peerId);
        }
      })();
    } else {
      // Responder: the channel arrives via the initiator's offer.
      pc.ondatachannel = (e) => wireDataChannel(peerId, entry!, e.channel);
    }
    armWatchdog(peerId, entry);
    return entry;
  }

  async function flushCandidates(entry: PeerConn): Promise<void> {
    const pending = entry.pendingCandidates;
    entry.pendingCandidates = [];
    for (const c of pending) {
      try { await entry.pc.addIceCandidate(c); } catch (err) { log.warn('addIceCandidate (flush) failed:', err); }
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
        log.warn('handleSignal(offer) failed for', peerId, err);
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
        if (entry.remoteDescSet) await entry.pc.addIceCandidate(signal.candidate);
        else entry.pendingCandidates.push(signal.candidate);
      }
    } catch (err) {
      log.warn('handleSignal(' + signal.kind + ') failed for', peerId, err);
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
            for (const frame of frameMessage(msg.bytes)) entry.dc.send(frame);
          } catch (err) { log.warn('dc.send failed:', err); }
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
