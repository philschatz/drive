/**
 * Unit tests for the portable WebRTC bridge core.
 *
 * The RTC driver is injected, so the negotiation logic that used to hide
 * behind a hard-coded `new RTCPeerConnection` is exercised directly with a
 * scripted fake: offer/answer flow, trickle-ICE candidate buffering, the
 * negotiation watchdog (retry then give-up), offer-supersedes-stale, the
 * peer-connection cap, chunked sends, and hostile-frame teardown.
 */

import {
  startWebRTCBridgeCore,
  MAX_NEGOTIATION_RETRIES,
  MAX_PEER_CONNECTIONS,
  NEGOTIATION_TIMEOUT_MS,
  DATA_CHANNEL_LABEL,
  type MinimalDataChannel,
  type MinimalPeerConnection,
  type SessionDescription,
} from '../src/shared/webrtc-bridge-core';
import { frameMessage, FrameReassembler, MAX_MESSAGE_FRAMES } from '../src/shared/webrtc-chunk';

let sdpSeq = 0;

class FakeDC implements MinimalDataChannel {
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;
  constructor(public label: string) {}
  send(data: Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; }
}

class FakePC implements MinimalPeerConnection {
  iceConnectionState = 'new';
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: MinimalDataChannel }) => void) | null = null;
  channels: FakeDC[] = [];
  local: SessionDescription | null = null;
  remote: SessionDescription | null = null;
  candidates: unknown[] = [];
  closed = false;
  createDataChannel(label: string): MinimalDataChannel {
    const dc = new FakeDC(label);
    this.channels.push(dc);
    return dc;
  }
  async createOffer(): Promise<SessionDescription> { return { type: 'offer', sdp: `offer-${++sdpSeq}` }; }
  async createAnswer(): Promise<SessionDescription> { return { type: 'answer', sdp: `answer-${++sdpSeq}` }; }
  async setLocalDescription(d: SessionDescription) { this.local = d; }
  async setRemoteDescription(d: SessionDescription) { this.remote = d; }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  close() { this.closed = true; }
}

/** Fake MessagePort capturing everything the bridge posts to the adapter. */
function makePort() {
  const posted: any[] = [];
  return {
    posted,
    onmessage: null as null | ((e: MessageEvent) => void),
    postMessage: (msg: any, _transfer?: any[]) => { posted.push(msg); },
    close() { /* spy target */ },
    deliver(msg: any) { this.onmessage?.({ data: msg } as MessageEvent); },
  };
}

const stops: Array<() => void> = [];

function build() {
  const pcs: FakePC[] = [];
  const port = makePort();
  const stop = startWebRTCBridgeCore(port as unknown as MessagePort, {
    iceServers: [],
    createPeerConnection: () => { const pc = new FakePC(); pcs.push(pc); return pc; },
  });
  stops.push(stop);
  return { pcs, port, stop };
}

/** Drain the promise chains behind createOffer/createAnswer etc. */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

afterEach(() => {
  // Stop every bridge so no negotiation watchdog outlives its test.
  while (stops.length) stops.pop()!();
  jest.useRealTimers();
});

describe('webrtc-bridge-core negotiation', () => {
  test('initiator creates the data channel and posts an offer', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();

    expect(pcs).toHaveLength(1);
    expect(pcs[0].channels).toHaveLength(1);
    expect(pcs[0].channels[0].label).toBe(DATA_CHANNEL_LABEL);
    const offer = port.posted.find((m) => m.kind === 'signal-out' && m.signal.kind === 'offer');
    expect(offer).toBeTruthy();
    expect(pcs[0].local?.sdp).toBe(offer.signal.sdp);
  });

  test('responder applies the offer and posts an answer; channel-open on dc open', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'offer', sdp: 'their-offer' } });
    await flush();

    expect(pcs[0].remote).toEqual({ type: 'offer', sdp: 'their-offer' });
    const answer = port.posted.find((m) => m.kind === 'signal-out' && m.signal.kind === 'answer');
    expect(answer).toBeTruthy();

    // The initiator's channel arrives; opening it reports channel-open.
    const dc = new FakeDC(DATA_CHANNEL_LABEL);
    pcs[0].ondatachannel?.({ channel: dc });
    dc.onopen?.();
    expect(port.posted).toContainEqual({ kind: 'channel-open', peerId: 'A' });
  });

  test('candidates arriving before the remote description are buffered, then flushed', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'candidate', candidate: { c: 1 } } });
    await flush();
    expect(pcs[0].candidates).toEqual([]); // buffered, not applied

    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'offer', sdp: 'their-offer' } });
    await flush();
    expect(pcs[0].candidates).toEqual([{ c: 1 }]); // flushed after setRemoteDescription

    // Candidates after the remote description apply immediately.
    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'candidate', candidate: { c: 2 } } });
    await flush();
    expect(pcs[0].candidates).toEqual([{ c: 1 }, { c: 2 }]);
  });

  test('local ICE candidates are posted as signal-out', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();

    pcs[0].onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'cand-1' }) } });
    expect(port.posted).toContainEqual({
      kind: 'signal-out', peerId: 'B', signal: { kind: 'candidate', candidate: { candidate: 'cand-1' } },
    });
    // End-of-candidates (null) posts nothing.
    const before = port.posted.length;
    pcs[0].onicecandidate?.({ candidate: null });
    expect(port.posted).toHaveLength(before);
  });

  test('watchdog retries with a fresh connection, then gives up after the retry cap', async () => {
    jest.useFakeTimers();
    const { pcs, port } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();
    expect(pcs).toHaveLength(1);

    for (let retry = 1; retry <= MAX_NEGOTIATION_RETRIES; retry++) {
      jest.advanceTimersByTime(NEGOTIATION_TIMEOUT_MS);
      await flush();
      expect(pcs).toHaveLength(1 + retry);       // fresh pc per retry
      expect(pcs[retry - 1].closed).toBe(true);  // the stalled one is closed
    }

    // One more timeout exhausts the budget: teardown, no new connection.
    jest.advanceTimersByTime(NEGOTIATION_TIMEOUT_MS);
    await flush();
    expect(pcs).toHaveLength(1 + MAX_NEGOTIATION_RETRIES);
    expect(pcs[pcs.length - 1].closed).toBe(true);
    expect(port.posted.filter((m) => m.kind === 'channel-open')).toHaveLength(0);
    // Every attempt (initial + retries) sent a fresh offer.
    expect(port.posted.filter((m) => m.kind === 'signal-out' && m.signal.kind === 'offer'))
      .toHaveLength(1 + MAX_NEGOTIATION_RETRIES);
  });

  test('ICE failure short-circuits the watchdog and retries immediately', async () => {
    jest.useFakeTimers();
    const { pcs, port } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();

    pcs[0].iceConnectionState = 'failed';
    pcs[0].oniceconnectionstatechange?.();
    await flush();
    expect(pcs).toHaveLength(2);
    expect(pcs[0].closed).toBe(true);
  });

  test('a fresh offer supersedes a half-negotiated connection', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'offer', sdp: 'offer-1' } });
    await flush();
    expect(pcs).toHaveLength(1);

    port.deliver({ kind: 'signal-in', peerId: 'A', signal: { kind: 'offer', sdp: 'offer-2' } });
    await flush();
    expect(pcs).toHaveLength(2);
    expect(pcs[0].closed).toBe(true);
    expect(pcs[1].remote).toEqual({ type: 'offer', sdp: 'offer-2' });
    expect(port.posted.filter((m) => m.kind === 'signal-out' && m.signal.kind === 'answer')).toHaveLength(2);
  });

  test('refuses to allocate past MAX_PEER_CONNECTIONS', async () => {
    const { pcs, port } = build();
    for (let i = 0; i < MAX_PEER_CONNECTIONS + 1; i++) {
      port.deliver({ kind: 'connect-peer', peerId: `peer-${i}`, initiator: false });
    }
    await flush();
    expect(pcs).toHaveLength(MAX_PEER_CONNECTIONS);
  });

  test('disconnect-peer tears the connection down', async () => {
    const { pcs, port } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();

    port.deliver({ kind: 'disconnect-peer', peerId: 'B' });
    expect(pcs[0].closed).toBe(true);
    expect(pcs[0].channels[0].closed).toBe(true);
  });

  test('teardown closes every peer connection', async () => {
    const { pcs, port, stop } = build();
    port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    port.deliver({ kind: 'connect-peer', peerId: 'C', initiator: false });
    await flush();

    stop();
    expect(pcs.every((pc) => pc.closed)).toBe(true);
    expect(port.onmessage).toBeNull();
  });
});

describe('webrtc-bridge-core data path', () => {
  /** Build with an open initiator channel to peer B; returns its FakeDC. */
  async function withOpenChannel() {
    const built = build();
    built.port.deliver({ kind: 'connect-peer', peerId: 'B', initiator: true });
    await flush();
    const dc = built.pcs[0].channels[0];
    dc.onopen?.();
    return { ...built, dc };
  }

  test('data-out is chunked into [flag][payload] frames', async () => {
    const { dc, port } = await withOpenChannel();
    const bytes = new Uint8Array(40_000).fill(7);
    port.deliver({ kind: 'data-out', peerId: 'B', bytes });

    expect(dc.sent).toHaveLength(3); // 40 000 bytes over 16 KiB frames
    expect(dc.sent[0][0]).toBe(0x00);
    expect(dc.sent[1][0]).toBe(0x00);
    expect(dc.sent[2][0]).toBe(0x01);
    const reasm = new FrameReassembler();
    const roundTripped = dc.sent.map((f) => reasm.push(f)).find(Boolean);
    expect(roundTripped).toEqual(bytes);
  });

  test('inbound frames are reassembled and posted as data-in', async () => {
    const { dc, port } = await withOpenChannel();
    const msg = new Uint8Array(20_000).fill(9);
    for (const frame of frameMessage(msg)) {
      // The browser delivers ArrayBuffer (binaryType), Node delivers Uint8Array —
      // exercise both normalization paths.
      dc.onmessage?.({ data: frame.buffer });
    }
    const delivered = port.posted.find((m) => m.kind === 'data-in');
    expect(delivered.peerId).toBe('B');
    expect(new Uint8Array(delivered.bytes)).toEqual(msg);
  });

  test('a frame flood beyond the reassembly bounds drops the channel', async () => {
    const { dc, pcs, port } = await withOpenChannel();
    expect(port.posted).toContainEqual({ kind: 'channel-open', peerId: 'B' });

    const neverFinal = new Uint8Array([0x00, 1]);
    for (let i = 0; i <= MAX_MESSAGE_FRAMES; i++) dc.onmessage?.({ data: neverFinal });

    expect(pcs[0].closed).toBe(true);
    expect(port.posted).toContainEqual({ kind: 'channel-closed', peerId: 'B' });
  });

  test('data-out for a peer with no open channel is dropped, not thrown', async () => {
    const { port } = build();
    expect(() => port.deliver({ kind: 'data-out', peerId: 'nobody', bytes: new Uint8Array([1]) })).not.toThrow();
  });
});
