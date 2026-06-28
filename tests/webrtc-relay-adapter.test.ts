/**
 * Unit tests for the transport-multiplexing WebRTCRelayAdapter.
 *
 * These exercise the routing logic in isolation (no real WebRTC / repo): a mock
 * inner adapter stands in for the relay WebSocket, and a fake MessagePort stands
 * in for the main-thread WebRTC bridge. We assert the adapter:
 *   - routes a peer's `send()` over the data channel once it is marked open,
 *   - falls back to the relay (inner.send) when no channel is open,
 *   - re-emits inbound data-channel bytes as repo `message` events,
 *   - picks a deterministic initiator and skips the relay's own peerId.
 */

import { EventEmitter } from 'events';
import { Encoder, decode } from 'cbor-x';
import { makeWebRTCRelayAdapter } from '../src/client/webrtc-relay-adapter';
import { WRTC_SIGNAL } from '../src/shared/webrtc-signal';

const cbor = new Encoder({ tagUint8Array: false, useRecords: false });
const RELAY_ID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Minimal stand-in for automerge-repo's NetworkAdapter base (just needs emit). */
class FakeBase extends EventEmitter {
  peerId?: string;
  peerMetadata?: unknown;
}

/** Mock relay adapter: an EventEmitter with spy-able connect/send. */
function makeInner() {
  const inner = new EventEmitter() as any;
  inner.connect = jest.fn();
  inner.send = jest.fn();
  inner.disconnect = jest.fn();
  inner.isReady = jest.fn(() => true);
  inner.whenReady = jest.fn(() => Promise.resolve());
  inner.state = jest.fn(() => ({ value: 'ready' }));
  return inner;
}

/** Fake MessagePort capturing everything the adapter posts to the bridge. */
function makePort() {
  const posted: any[] = [];
  const port = {
    posted,
    onmessage: null as null | ((e: MessageEvent) => void),
    postMessage: (msg: any, _transfer?: any[]) => { posted.push(msg); },
    // helper to simulate a bridge → adapter message
    deliver(msg: any) { this.onmessage?.({ data: msg } as MessageEvent); },
  };
  return port;
}

function build(extra?: { onTransportChange?: (p: string, t: 'direct' | 'relay') => void }) {
  const inner = makeInner();
  const port = makePort();
  const signals: any[] = [];
  const adapter = makeWebRTCRelayAdapter(FakeBase as any, inner, {
    sendSignalFrame: (f) => signals.push(f),
    relayPeerId: RELAY_ID,
    onTransportChange: extra?.onTransportChange,
  });
  return { inner, port, signals, adapter };
}

describe('WebRTCRelayAdapter routing', () => {
  test('routes send() over the data channel once the channel is open', () => {
    const { inner, port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    port.deliver({ kind: 'channel-open', peerId: 'peerB' });

    const msg = { type: 'sync', senderId: 'me', targetId: 'peerB', data: new Uint8Array([1, 2, 3]) };
    adapter.send(msg as any);

    expect(inner.send).not.toHaveBeenCalled();
    const out = port.posted.find((m) => m.kind === 'data-out');
    expect(out).toBeTruthy();
    expect(out.peerId).toBe('peerB');
    // The encoded bytes round-trip back to the original message.
    expect(decode(out.bytes)).toEqual(msg);
  });

  test('falls back to the relay when no channel is open', () => {
    const { inner, port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    const msg = { type: 'sync', senderId: 'me', targetId: 'peerC', data: new Uint8Array([9]) };
    adapter.send(msg as any);

    expect(inner.send).toHaveBeenCalledWith(msg);
    expect(port.posted.find((m) => m.kind === 'data-out')).toBeUndefined();
  });

  test('reverts to relay after the channel closes', () => {
    const { inner, port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    port.deliver({ kind: 'channel-open', peerId: 'peerB' });
    port.deliver({ kind: 'channel-closed', peerId: 'peerB' });

    const msg = { type: 'sync', senderId: 'me', targetId: 'peerB', data: new Uint8Array([5]) };
    adapter.send(msg as any);
    expect(inner.send).toHaveBeenCalledWith(msg);
  });

  test('re-emits inbound data-channel bytes as message events', () => {
    const { port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    const received: any[] = [];
    adapter.on('message', (m) => received.push(m));

    const msg = { type: 'sync', senderId: 'peerB', targetId: 'me', data: new Uint8Array([7, 8]) };
    port.deliver({ kind: 'data-in', peerId: 'peerB', bytes: cbor.encode(msg) });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  test('also re-emits messages arriving over the relay', () => {
    const { inner, adapter } = build();
    adapter.connect('me' as any);
    const received: any[] = [];
    adapter.on('message', (m) => received.push(m));

    const msg = { type: 'sync', senderId: 'peerB', targetId: 'me', data: new Uint8Array([1]) };
    inner.emit('message', msg);
    expect(received).toEqual([msg]);
  });

  test('initiator is deterministic by peerId comparison', () => {
    const { inner, port, adapter } = build();
    adapter.connect('mmm' as any);
    adapter.attachPort(port as any);

    inner.emit('peer-candidate', { peerId: 'aaa', peerMetadata: {} }); // mmm > aaa → not initiator
    inner.emit('peer-candidate', { peerId: 'zzz', peerMetadata: {} }); // mmm < zzz → initiator

    const calls = port.posted.filter((m) => m.kind === 'connect-peer');
    expect(calls).toContainEqual({ kind: 'connect-peer', peerId: 'aaa', initiator: false });
    expect(calls).toContainEqual({ kind: 'connect-peer', peerId: 'zzz', initiator: true });
  });

  test('never attempts a direct connection to the relay peer', () => {
    const { inner, port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    inner.emit('peer-candidate', { peerId: RELAY_ID, peerMetadata: {} });
    expect(port.posted.find((m) => m.kind === 'connect-peer')).toBeUndefined();
  });

  test('peers discovered before the port attaches are negotiated on attach', () => {
    const { inner, port, adapter } = build();
    adapter.connect('me' as any);
    // peer-candidate arrives before the bridge port is wired
    inner.emit('peer-candidate', { peerId: 'zzz', peerMetadata: {} });
    expect(port.posted.find((m) => m.kind === 'connect-peer')).toBeUndefined();

    adapter.attachPort(port as any);
    expect(port.posted).toContainEqual({ kind: 'connect-peer', peerId: 'zzz', initiator: true });
  });

  test('signal-out from the bridge becomes a WRTC_SIGNAL frame on the relay', () => {
    const { port, signals, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    const signal = { kind: 'offer', sdp: 'v=0...' };
    port.deliver({ kind: 'signal-out', peerId: 'peerB', signal });

    expect(signals).toEqual([{ type: WRTC_SIGNAL, senderId: 'me', targetId: 'peerB', signal }]);
  });

  test('handleSignal forwards an inbound frame to the bridge as signal-in', () => {
    const { port, adapter } = build();
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    const signal = { kind: 'answer', sdp: 'v=0...' };
    adapter.handleSignal({ type: WRTC_SIGNAL, senderId: 'peerB', targetId: 'me', signal } as any);

    expect(port.posted).toContainEqual({ kind: 'signal-in', peerId: 'peerB', signal });
  });

  test('peer-disconnected clears the open channel and tears down the bridge peer', () => {
    const { inner, port, adapter } = build({ onTransportChange: () => {} });
    adapter.connect('me' as any);
    adapter.attachPort(port as any);
    port.deliver({ kind: 'channel-open', peerId: 'peerB' });

    inner.emit('peer-disconnected', { peerId: 'peerB' });
    expect(port.posted).toContainEqual({ kind: 'disconnect-peer', peerId: 'peerB' });

    // After disconnect, sends fall back to the relay again.
    const msg = { type: 'sync', senderId: 'me', targetId: 'peerB', data: new Uint8Array([1]) };
    adapter.send(msg as any);
    expect(inner.send).toHaveBeenCalledWith(msg);
  });

  test('onTransportChange fires on open and close', () => {
    const changes: Array<[string, string]> = [];
    const { port, adapter } = build({ onTransportChange: (p, t) => changes.push([p, t]) });
    adapter.connect('me' as any);
    adapter.attachPort(port as any);

    port.deliver({ kind: 'channel-open', peerId: 'peerB' });
    port.deliver({ kind: 'channel-closed', peerId: 'peerB' });
    expect(changes).toEqual([['peerB', 'direct'], ['peerB', 'relay']]);
  });
});
