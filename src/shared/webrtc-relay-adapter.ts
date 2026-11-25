/**
 * WebRTCRelayAdapter — a transport-multiplexing automerge-repo NetworkAdapter.
 *
 * This wraps the existing relay WebSocket adapter and is the SINGLE adapter
 * under everything else: the secure channel (secure-channel.ts) wraps it, and
 * the keyhive integration wraps that. So which route a peer's traffic takes is
 * invisible above — to the channel, keyhive and the repo there is one adapter,
 * the same peerIds, and the same `Message`s — and what travels on either route
 * is already sealed for the peer it is addressed to.
 *
 * Underneath, for a peer it has been told to (`allowDirect`), it negotiates a
 * direct WebRTC data channel:
 *   - **It never starts one on its own.** The relay introducing a peer proves
 *     nothing about who that peer is, and negotiating hands the other side this
 *     device's network addresses (ICE candidates: the LAN address and the
 *     public one). So the layer that knows who a peer is decides: keyhive-repo.ts
 *     calls `allowDirect` only once the secure channel has proved the peer's key
 *     AND that key belongs to a device this one is related to.
 *   - **Signaling does not cross the relay in the clear.** The offer, answer and
 *     candidates are handed to `setSignalSender`'s callback, which keyhive-repo.ts
 *     sends as sealed secure-channel messages; inbound ones come back through
 *     `handleSignal`. The relay carries them as opaque sealed frames, so it can
 *     neither read the addresses nor alter the session description.
 *   - the actual peer connections live in the bridge (`webrtc-bridge-core.ts`),
 *     reached over a MessagePort. In the browser that is the main thread
 *     (WebRTC is not available in Workers — `src/client/ui/webrtc-bridge.ts`);
 *     in the Node CLI the port pair is in-process (`src/cli/webrtc-node-bridge.ts`).
 *   - once a data channel is open, `send()` for that peer routes through it;
 *     otherwise it falls back to the relay. Correctness never depends on the
 *     direct channel — if it never opens, the relay path is exactly today's.
 *
 * Constructed via the `makeWebRTCRelayAdapter` factory so the automerge-repo
 * `NetworkAdapter` base class can be injected (the worker imports automerge-repo
 * dynamically; tests inject a lightweight stand-in).
 */

import { Encoder, decode } from 'cbor-x';
import { MAX_MESSAGE_BYTES } from './webrtc-chunk';
import type { WebRTCSignal } from './webrtc-signal';
import type { BridgeToWorkerMsg, WorkerToBridgeMsg } from './worker-protocol';
import type { Message, NetworkAdapterInterface, PeerId, PeerMetadata } from '@automerge/automerge-repo';
import { createLogger } from './logger';

const log = createLogger('webrtc');

export interface WebRTCRelayAdapterOptions {
  /** Notified when a peer's transport flips between the direct channel and the relay. */
  onTransportChange?: (peerId: string, transport: 'direct' | 'relay') => void;
  /** The relay's own peerId — never attempt a direct connection to the router. */
  relayPeerId: string;
}

/** The wrapped adapter plus the hooks it is driven with. */
export type WebRTCRelayAdapter = NetworkAdapterInterface & {
  /** Wire up the MessagePort to the main-thread WebRTC bridge. Until this is
   *  called the adapter behaves exactly like the relay-only adapter. */
  attachPort(port: MessagePort): void;
  /**
   * Allow — and start — a direct connection with a peer the relay has
   * introduced. Only for a peer whose device key has been proved and is a
   * device this one is related to (see the file header). Until then the peer
   * stays on the relay and is told nothing about this device's addresses.
   */
  allowDirect(peerId: string): void;
  /** Where outbound signaling goes (a sealed secure-channel message). Unset, signaling is dropped. */
  setSignalSender(send: (peerId: string, signal: WebRTCSignal) => void): void;
  /** An inbound signal from `peerId`, authenticated by the caller. Ignored unless that peer was allowed. */
  handleSignal(peerId: string, signal: WebRTCSignal): void;
};

/** Minimal shape of the automerge-repo `NetworkAdapter` base class we extend. */
type NetworkAdapterBase = new () => NetworkAdapterInterface & { emit: (event: string, payload?: unknown) => void };

/** Whether a value has the shape of a signal: enough to hand it to the bridge. */
export function isWebRTCSignal(value: unknown): value is WebRTCSignal {
  const kind = (value as any)?.kind;
  return kind === 'offer' || kind === 'answer' || kind === 'candidate';
}

export function makeWebRTCRelayAdapter(
  Base: NetworkAdapterBase,
  inner: NetworkAdapterInterface,
  opts: WebRTCRelayAdapterOptions,
): WebRTCRelayAdapter {
  // Peers with an open direct data channel — their traffic skips the relay.
  const openChannels = new Set<string>();
  // Peers the relay has introduced and not yet reported gone.
  const present = new Set<string>();
  // Of those, the ones a direct connection is allowed with.
  const allowed = new Set<string>();
  let port: MessagePort | null = null;
  let sendSignal: ((peerId: string, signal: WebRTCSignal) => void) | null = null;
  // Same CBOR settings as the relay so `Message.data` (Uint8Array) round-trips.
  const encoder = new Encoder({ tagUint8Array: false, useRecords: false });

  class WebRTCRelayAdapterImpl extends (Base as NetworkAdapterBase) {
    constructor() {
      super();
      // Re-emit the relay adapter's events so the repo sees one unified stream.
      inner.on('message', (m: Message) => this.emit('message', m));
      inner.on('close', () => this.emit('close'));
      inner.on('peer-disconnected', (p: { peerId: PeerId }) => {
        openChannels.delete(p.peerId);
        present.delete(p.peerId);
        allowed.delete(p.peerId);
        port?.postMessage({ kind: 'disconnect-peer', peerId: p.peerId } satisfies WorkerToBridgeMsg);
        this.emit('peer-disconnected', p);
      });
      inner.on('peer-candidate', (p: { peerId: PeerId; peerMetadata: PeerMetadata }) => {
        // Announced, and nothing more: who this is has not been established.
        if (p.peerId !== opts.relayPeerId) present.add(p.peerId);
        this.emit('peer-candidate', p);
      });
    }

    connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
      this.peerId = peerId;
      this.peerMetadata = peerMetadata;
      inner.connect(peerId, peerMetadata);
    }

    send(message: Message): void {
      if (openChannels.has(message.targetId) && port) {
        const encoded = encoder.encode(message) as Uint8Array;
        // Fresh buffer per encode → safe to transfer to the main thread.
        const bytes = encoded.slice();
        port.postMessage({ kind: 'data-out', peerId: message.targetId, bytes } satisfies WorkerToBridgeMsg, [bytes.buffer]);
      } else {
        inner.send(message);
      }
    }

    disconnect(): void { inner.disconnect(); }
    isReady(): boolean { return inner.isReady(); }
    whenReady(): Promise<void> { return inner.whenReady(); }
    state() { return inner.state(); }

    attachPort(p: MessagePort): void {
      port = p;
      p.onmessage = onBridgeMsg;
      // Negotiate with any peers allowed before the bridge was ready.
      for (const peerId of allowed) startDirect(peerId);
    }

    allowDirect(peerId: string): void {
      // The relay router is not a real peer, and a peer that has left (or was
      // never introduced) has nobody to negotiate with.
      if (peerId === opts.relayPeerId || !present.has(peerId)) return;
      allowed.add(peerId);
      startDirect(peerId);
    }

    setSignalSender(send: (peerId: string, signal: WebRTCSignal) => void): void {
      sendSignal = send;
    }

    handleSignal(peerId: string, signal: WebRTCSignal): void {
      // Signaling allocates and tears down RTCPeerConnections, so only a peer a
      // direct connection is wanted with may drive it.
      if (!allowed.has(peerId) || !isWebRTCSignal(signal)) return;
      port?.postMessage({ kind: 'signal-in', peerId, signal } satisfies WorkerToBridgeMsg);
    }
  }

  const adapter = new WebRTCRelayAdapterImpl();

  /** Kick off a direct-connection attempt to an allowed peer. */
  function startDirect(peerId: string): void {
    if (!port || openChannels.has(peerId)) return;
    const me = adapter.peerId;
    if (!me) return;
    // Deterministic initiator so exactly one side creates the offer.
    const initiator = me < peerId;
    port.postMessage({ kind: 'connect-peer', peerId, initiator } satisfies WorkerToBridgeMsg);
  }

  function onBridgeMsg(e: MessageEvent<BridgeToWorkerMsg>): void {
    const msg = e.data;
    switch (msg.kind) {
      case 'signal-out':
        // The bridge only negotiates with peers it was told to connect to, but
        // this is where addresses leave the device: check again.
        if (allowed.has(msg.peerId)) sendSignal?.(msg.peerId, msg.signal);
        break;
      case 'channel-open':
        openChannels.add(msg.peerId);
        opts.onTransportChange?.(msg.peerId, 'direct');
        break;
      case 'channel-closed':
        openChannels.delete(msg.peerId);
        opts.onTransportChange?.(msg.peerId, 'relay');
        break;
      case 'data-in': {
        const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes);
        // Defense in depth: the bridge's reassembler already caps message size,
        // but never hand the CBOR decoder more than the transport bound allows.
        if (bytes.byteLength > MAX_MESSAGE_BYTES) {
          log.warn('dropping oversized data-channel message:', bytes.byteLength, 'bytes');
          break;
        }
        try {
          adapter.emit('message', decode(bytes) as Message);
        } catch (err) {
          log.warn('failed to decode data-channel message:', err);
        }
        break;
      }
    }
  }

  return adapter as unknown as WebRTCRelayAdapter;
}
