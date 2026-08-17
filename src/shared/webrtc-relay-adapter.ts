/**
 * WebRTCRelayAdapter — a transport-multiplexing automerge-repo NetworkAdapter.
 *
 * This wraps the existing relay WebSocket adapter and is the SINGLE adapter
 * handed to the keyhive integration, so keyhive's end-to-end encryption and
 * access control are completely unchanged — from the repo/keyhive's point of
 * view there is one adapter, the same peerIds, and the same `Message`s.
 *
 * Underneath, for each peer it opportunistically negotiates a direct WebRTC
 * data channel (via the relay for signaling + public STUN for NAT traversal):
 *   - peer discovery, signaling transport, and fallback all ride the relay.
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
import { WRTC_SIGNAL, type WebRTCSignalFrame } from './webrtc-signal';
import type { BridgeToWorkerMsg, WorkerToBridgeMsg } from './worker-protocol';
import type { Message, NetworkAdapterInterface, PeerId, PeerMetadata } from '@automerge/automerge-repo';
import { createLogger } from './logger';

const log = createLogger('webrtc');

export interface WebRTCRelayAdapterOptions {
  /** Write a WebRTC signaling frame to the relay socket (unicast by targetId). */
  sendSignalFrame: (frame: WebRTCSignalFrame) => void;
  /** Notified when a peer's transport flips between the direct channel and the relay. */
  onTransportChange?: (peerId: string, transport: 'direct' | 'relay') => void;
  /** The relay's own peerId — never attempt a direct connection to the router. */
  relayPeerId: string;
}

/** The wrapped adapter plus the two hooks the worker drives it with. */
export type WebRTCRelayAdapter = NetworkAdapterInterface & {
  /** Wire up the MessagePort to the main-thread WebRTC bridge. Until this is
   *  called the adapter behaves exactly like the relay-only adapter. */
  attachPort(port: MessagePort): void;
  /** Feed an inbound `WRTC_SIGNAL` frame intercepted off the relay socket. */
  handleSignal(frame: WebRTCSignalFrame): void;
};

/** Minimal shape of the automerge-repo `NetworkAdapter` base class we extend. */
type NetworkAdapterBase = new () => NetworkAdapterInterface & { emit: (event: string, payload?: unknown) => void };

export function makeWebRTCRelayAdapter(
  Base: NetworkAdapterBase,
  inner: NetworkAdapterInterface,
  opts: WebRTCRelayAdapterOptions,
): WebRTCRelayAdapter {
  // Peers with an open direct data channel — their traffic skips the relay.
  const openChannels = new Set<string>();
  // Peers discovered via the relay (negotiation may still be pending/failed).
  const discovered = new Set<string>();
  let port: MessagePort | null = null;
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
        discovered.delete(p.peerId);
        port?.postMessage({ kind: 'disconnect-peer', peerId: p.peerId } satisfies WorkerToBridgeMsg);
        this.emit('peer-disconnected', p);
      });
      inner.on('peer-candidate', (p: { peerId: PeerId; peerMetadata: PeerMetadata }) => {
        this.emit('peer-candidate', p);
        maybeConnect(p.peerId);
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
      // Negotiate with any peers discovered before the bridge was ready.
      for (const peerId of discovered) maybeConnect(peerId);
    }

    handleSignal(frame: WebRTCSignalFrame): void {
      // Only peers the relay actually announced may drive negotiation — a
      // signal from an unknown senderId must not be able to allocate or tear
      // down RTCPeerConnections (the relay also enforces that senderId is the
      // sending socket's joined id, so a live peer can't be impersonated).
      if (!discovered.has(frame.senderId)) return;
      port?.postMessage({ kind: 'signal-in', peerId: frame.senderId, signal: frame.signal } satisfies WorkerToBridgeMsg);
    }
  }

  const adapter = new WebRTCRelayAdapterImpl();

  /** Kick off (or remember) a direct-connection attempt to a relay-discovered peer. */
  function maybeConnect(peerId: string): void {
    if (peerId === opts.relayPeerId) return; // the relay router is not a real peer
    discovered.add(peerId);
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
        opts.sendSignalFrame({ type: WRTC_SIGNAL, senderId: adapter.peerId as string, targetId: msg.peerId, signal: msg.signal });
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
