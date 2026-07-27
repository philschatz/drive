/**
 * Regression tests for relay hardening (untrusted public-internet clients).
 *
 * The relay is the only deployed backend, so a single malformed frame must
 * never crash the process, a client must not be able to kick another peer
 * offline by claiming its (publicly broadcast) peerId, and a peer that stops
 * reading must not make the relay buffer unboundedly.
 */
import { EventEmitter } from 'events';
import { Encoder, decode } from 'cbor-x';
import { WebSocketRelay, relayMaxPayloadBytes, createRelayWebSocketServer } from './relay';
import { RDV_SUB } from '../shared/rendezvous-protocol';
import { WRTC_SIGNAL } from '../shared/webrtc-signal';

// Same encoder settings as relay.ts / @automerge/automerge-repo's cbor helper
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });

/** Minimal stand-in for a `ws` WebSocket: an EventEmitter with the fields the relay touches. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  send = jest.fn();
  close = jest.fn();
  terminate = jest.fn();
  ping = jest.fn();

  /** Emit a CBOR-encoded message frame, exactly as `ws` would deliver it. */
  frame(message: unknown): void {
    this.emit('message', encoder.encode(message));
  }
}

function connect(relay: WebSocketRelay, req?: any): FakeSocket {
  const ws = new FakeSocket();
  relay.handleConnection(ws as any, req);
  return ws;
}

function join(relay: WebSocketRelay, peerId: string): FakeSocket {
  const ws = connect(relay);
  ws.frame({ type: 'join', senderId: peerId, supportedProtocolVersions: ['1'] });
  return ws;
}

function sentTypes(ws: FakeSocket): string[] {
  return ws.send.mock.calls.map(([bytes]) => (decode(bytes) as any).type);
}

afterEach(() => {
  delete process.env.RELAY_MAX_PAYLOAD_BYTES;
  delete process.env.RELAY_MAX_CONNECTIONS;
  delete process.env.RELAY_MAX_CONNECTIONS_PER_IP;
  delete process.env.RELAY_MAX_BUFFERED_BYTES;
  jest.restoreAllMocks();
});

describe('handshake (must keep working)', () => {
  it('completes join → peer ack and mutual discovery', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    expect(sentTypes(alice)).toEqual(['peer']); // relay ack

    const bob = join(relay, 'bob');
    expect(sentTypes(bob)).toEqual(['peer', 'peer']); // ack + intro of alice
    expect(sentTypes(alice)).toEqual(['peer', 'peer']); // ack + intro of bob

    // Unicast routing still works
    alice.send.mockClear();
    bob.frame({ type: 'sync', senderId: 'bob', targetId: 'alice', data: new Uint8Array([1]) });
    expect(alice.send).toHaveBeenCalledTimes(1);
  });
});

describe('C1: malformed frames must not crash the process', () => {
  it('does not throw on top-level null / undefined / number / string frames', () => {
    const relay = new WebSocketRelay();
    const ws = connect(relay);

    // Hand-crafted single-byte CBOR scalars: 0xf6 = null, 0xf7 = undefined
    expect(() => ws.emit('message', Buffer.from([0xf6]))).not.toThrow();
    expect(() => ws.emit('message', Buffer.from([0xf7]))).not.toThrow();
    expect(() => ws.frame(42)).not.toThrow();
    expect(() => ws.frame('hello')).not.toThrow();

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled(); // socket survives; only the frame is dropped
  });

  it('handles a join with a non-string senderId without registering a bogus socket', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    alice.send.mockClear();

    const bogus = connect(relay);
    expect(() => bogus.frame({ type: 'join', senderId: {} })).not.toThrow();
    expect(() => bogus.frame({ type: 'join', senderId: ['x'] })).not.toThrow();
    expect(() => bogus.frame({ type: 'join', senderId: 7 })).not.toThrow();
    expect(() => bogus.frame({ type: 'join' })).not.toThrow();

    // A bogus join gets no handshake ack and no discovery intros are pushed.
    expect(bogus.send).not.toHaveBeenCalled();
    expect(alice.send).not.toHaveBeenCalled();
    // Nothing was evicted: alice is still routable.
    const carol = join(relay, 'carol');
    alice.send.mockClear();
    carol.frame({ type: 'sync', senderId: 'carol', targetId: 'alice', data: new Uint8Array([1]) });
    expect(alice.send).toHaveBeenCalledTimes(1);
  });

  it('does not throw on non-string targetId / rendezvousId', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    expect(() => alice.frame({ type: 'sync', senderId: 'alice', targetId: { evil: true } })).not.toThrow();
    expect(() => alice.frame({ type: RDV_SUB, rendezvousId: { evil: true } })).not.toThrow();
    expect(() => alice.frame({ type: 'join', senderId: 'alice', supportedProtocolVersions: 5 })).not.toThrow();
  });
});

describe('C2: peerId squatting must not evict a live peer', () => {
  it('keeps the incumbent connected when a newcomer claims its id', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');

    const squatter = connect(relay);
    squatter.frame({ type: 'join', senderId: 'alice' });

    // The incumbent must NOT be closed — peerIds are public routing hints.
    expect(alice.close).not.toHaveBeenCalled();
    expect(alice.terminate).not.toHaveBeenCalled();
    // The newcomer is the one rejected.
    expect(squatter.close).toHaveBeenCalled();

    // Incumbent is still routable after the squat attempt.
    const bob = join(relay, 'bob');
    alice.send.mockClear();
    bob.frame({ type: 'sync', senderId: 'bob', targetId: 'alice', data: new Uint8Array([1]) });
    expect(alice.send).toHaveBeenCalledTimes(1);
  });

  it('allows re-registering an id whose previous socket is no longer open', () => {
    const relay = new WebSocketRelay();
    const stale = join(relay, 'alice');
    stale.readyState = 3; // WebSocket.CLOSED (close event not yet processed)

    const fresh = connect(relay);
    fresh.frame({ type: 'join', senderId: 'alice' });
    expect(fresh.close).not.toHaveBeenCalled();
    expect(sentTypes(fresh)).toContain('peer'); // handshake ack
  });
});

describe('C2: backpressure', () => {
  it('disconnects a peer that is too far behind instead of buffering unboundedly', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    const bob = join(relay, 'bob');

    bob.send.mockClear();
    bob.bufferedAmount = 2 * relayMaxPayloadBytes() + 1;
    alice.frame({ type: 'sync', senderId: 'alice', targetId: 'bob', data: new Uint8Array([1]) });

    expect(bob.send).not.toHaveBeenCalled();
    expect(bob.terminate).toHaveBeenCalled();
  });
});

describe('C2: connection caps', () => {
  it('refuses connections above the global cap', () => {
    process.env.RELAY_MAX_CONNECTIONS = '2';
    const relay = new WebSocketRelay();
    const a = connect(relay);
    const b = connect(relay);
    const c = connect(relay);
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled();
    expect(c.close).toHaveBeenCalledWith(1013, expect.any(String)); // 1013 = Try Again Later
  });

  it('refuses connections above the per-IP cap, keyed by x-forwarded-for when present', () => {
    process.env.RELAY_MAX_CONNECTIONS_PER_IP = '1';
    const relay = new WebSocketRelay();
    const req = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '10.0.0.1' } });
    const a = connect(relay, req('1.1.1.1'));
    const b = connect(relay, req('1.1.1.1'));
    const c = connect(relay, req('2.2.2.2'));
    expect(a.close).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(c.close).not.toHaveBeenCalled();
  });

  it('frees a slot when a connection closes', () => {
    process.env.RELAY_MAX_CONNECTIONS = '1';
    const relay = new WebSocketRelay();
    const a = connect(relay);
    a.emit('close');
    const b = connect(relay);
    expect(b.close).not.toHaveBeenCalled();
  });
});

describe('C2: WebRTC signaling senderId must not be spoofable', () => {
  it('forwards a WRTC_SIGNAL only when senderId matches the joined peer', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    const bob = join(relay, 'bob');
    const mallory = join(relay, 'mallory');
    bob.send.mockClear();

    // Spoof: mallory claims to be alice. Signaling drives RTCPeerConnection
    // setup/teardown on the receiver, so this must be dropped.
    mallory.frame({ type: WRTC_SIGNAL, senderId: 'alice', targetId: 'bob', signal: { kind: 'offer', sdp: 'v=0' } });
    expect(bob.send).not.toHaveBeenCalled();

    // A socket that never joined has no identity to speak as.
    const anon = connect(relay);
    anon.frame({ type: WRTC_SIGNAL, senderId: 'alice', targetId: 'bob', signal: { kind: 'offer', sdp: 'v=0' } });
    expect(bob.send).not.toHaveBeenCalled();

    // The truthful frame still goes through.
    alice.frame({ type: WRTC_SIGNAL, senderId: 'alice', targetId: 'bob', signal: { kind: 'offer', sdp: 'v=0' } });
    expect(bob.send).toHaveBeenCalledTimes(1);
    expect((decode(bob.send.mock.calls[0][0]) as any).type).toBe(WRTC_SIGNAL);
  });
});

describe('C2: maxPayload wiring', () => {
  it('defaults to a bound that still fits a large-doc initial sync', () => {
    expect(relayMaxPayloadBytes()).toBe(64 * 1024 * 1024);
  });

  it('is env-configurable and passed to every relay WebSocketServer', () => {
    process.env.RELAY_MAX_PAYLOAD_BYTES = '1048576';
    const wss = createRelayWebSocketServer();
    // maxPayload enforcement lives inside `ws` itself; assert the wiring.
    expect((wss as any).options.maxPayload).toBe(1048576);
    expect((wss as any).options.noServer).toBe(true);
    wss.close();
  });
});

describe('peer departure', () => {
  /** Decoded frames of a given type that `ws` received. */
  function sentOfType(ws: FakeSocket, type: string): any[] {
    return ws.send.mock.calls.map(([bytes]) => decode(bytes) as any).filter((m) => m.type === type);
  }

  it('broadcasts a leave to remaining peers when a socket closes', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    const bob = join(relay, 'bob');

    bob.emit('close');

    expect(sentOfType(alice, 'leave')).toEqual([{ type: 'leave', senderId: 'bob' }]);
    // The departed socket itself gets nothing extra.
    expect(sentOfType(bob, 'leave')).toEqual([]);
  });

  it('does not broadcast a leave when a rejected duplicate socket closes', () => {
    const relay = new WebSocketRelay();
    const alice = join(relay, 'alice');
    const bob = join(relay, 'bob');
    const squatter = join(relay, 'bob'); // rejected — bob's socket still owns the id

    alice.send.mockClear();
    // The rejected socket closing must NOT make bob appear to leave.
    squatter.emit('close');
    expect(sentOfType(alice, 'leave')).toEqual([]);

    // The real bob closing still broadcasts exactly one leave.
    bob.emit('close');
    expect(sentOfType(alice, 'leave')).toEqual([{ type: 'leave', senderId: 'bob' }]);
  });
});

describe('heartbeat reaper', () => {
  afterEach(() => jest.useRealTimers());

  it('pings connected sockets and terminates one that stops answering', () => {
    jest.useFakeTimers();
    const relay = new WebSocketRelay({ heartbeatMs: 1_000 });
    const alice = join(relay, 'alice');
    const bob = join(relay, 'bob');

    // Tick 1: both were alive → both get pinged, nobody terminated.
    jest.advanceTimersByTime(1_000);
    expect(alice.ping).toHaveBeenCalledTimes(1);
    expect(bob.ping).toHaveBeenCalledTimes(1);
    expect(bob.terminate).not.toHaveBeenCalled();

    // Alice answers; bob has gone dark (no pong).
    alice.emit('pong');

    // Tick 2: alice is pinged again, bob is reaped.
    jest.advanceTimersByTime(1_000);
    expect(alice.ping).toHaveBeenCalledTimes(2);
    expect(alice.terminate).not.toHaveBeenCalled();
    expect(bob.terminate).toHaveBeenCalledTimes(1);

    // A real `ws` terminate fires 'close', which broadcasts the leave.
    bob.emit('close');
    const leaves = alice.send.mock.calls
      .map(([bytes]) => decode(bytes) as any)
      .filter((m) => m.type === 'leave');
    expect(leaves).toEqual([{ type: 'leave', senderId: 'bob' }]);
  });

  it('skips sockets that are no longer OPEN instead of pinging them', () => {
    jest.useFakeTimers();
    const relay = new WebSocketRelay({ heartbeatMs: 1_000 });
    const alice = join(relay, 'alice');
    alice.readyState = 2; // CLOSING

    jest.advanceTimersByTime(2_000);
    expect(alice.ping).not.toHaveBeenCalled();
    expect(alice.terminate).not.toHaveBeenCalled();
  });
});
