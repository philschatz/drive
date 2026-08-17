/**
 * Unit tests for the relay overlay-frame plumbing shared by the browser worker
 * and the Node CLI.
 *
 * The regression that matters: a WRTC_SIGNAL frame must reach its handler and
 * NEVER fall through to the stock adapter's receiveMessage — before the CLI's
 * intercept learned about signaling, every browser peer's connection offers
 * landed in the repo's NetworkSubsystem as "invalid message" warnings.
 */

import { Encoder, decode } from 'cbor-x';
import { installOverlayIntercept, makeOverlayFrameSender } from '../src/shared/relay-overlay';
import { WRTC_SIGNAL } from '../src/shared/webrtc-signal';
import { RDV_MSG } from '../src/shared/rendezvous-protocol';
import { RELAY_LEAVE } from '../src/shared/relay-identity';

const cbor = new Encoder({ tagUint8Array: false, useRecords: false });

function build() {
  const origReceive = jest.fn();
  const wsAdapter = { receiveMessage: origReceive, emit: jest.fn() };
  const onRendezvous = jest.fn();
  const onWebRTCSignal = jest.fn();
  installOverlayIntercept(wsAdapter, { onRendezvous, onWebRTCSignal });
  return { wsAdapter, origReceive, onRendezvous, onWebRTCSignal };
}

describe('installOverlayIntercept', () => {
  test('WRTC_SIGNAL frames reach the handler and never the repo adapter', () => {
    const { wsAdapter, origReceive, onWebRTCSignal } = build();
    const frame = { type: WRTC_SIGNAL, senderId: 'peerB', targetId: 'me', signal: { kind: 'offer', sdp: 'v=0...' } };

    wsAdapter.receiveMessage(cbor.encode(frame));

    expect(onWebRTCSignal).toHaveBeenCalledWith(frame);
    expect(origReceive).not.toHaveBeenCalled();
  });

  test('rendezvous frames route to the rendezvous handler only', () => {
    const { wsAdapter, origReceive, onRendezvous, onWebRTCSignal } = build();
    const frame = { type: RDV_MSG, rendezvousId: 'r1', data: new Uint8Array([1, 2]) };

    wsAdapter.receiveMessage(cbor.encode(frame));

    expect(onRendezvous).toHaveBeenCalledWith(frame);
    expect(onWebRTCSignal).not.toHaveBeenCalled();
    expect(origReceive).not.toHaveBeenCalled();
  });

  test('a relay leave frame becomes a peer-disconnected emit', () => {
    const { wsAdapter, origReceive } = build();
    const frame = { type: RELAY_LEAVE, senderId: 'peerB' };

    wsAdapter.receiveMessage(cbor.encode(frame));

    expect(wsAdapter.emit).toHaveBeenCalledWith('peer-disconnected', { peerId: 'peerB' });
    expect(origReceive).not.toHaveBeenCalled();
  });

  test('genuine repo protocol bytes fall through to the stock adapter', () => {
    const { wsAdapter, origReceive, onRendezvous, onWebRTCSignal } = build();
    const bytes = cbor.encode({ type: 'sync', senderId: 'peerB', targetId: 'me', data: new Uint8Array([7]) });

    wsAdapter.receiveMessage(bytes);

    expect(origReceive).toHaveBeenCalledWith(bytes);
    expect(onRendezvous).not.toHaveBeenCalled();
    expect(onWebRTCSignal).not.toHaveBeenCalled();
  });

  test('undecodable bytes fall through rather than being swallowed', () => {
    const { wsAdapter, origReceive } = build();
    const junk = new Uint8Array([0xff, 0x00, 0xff]);

    wsAdapter.receiveMessage(junk);

    expect(origReceive).toHaveBeenCalledWith(junk);
  });
});

describe('makeOverlayFrameSender', () => {
  test('CBOR-encodes onto an OPEN socket', () => {
    const sent: Uint8Array[] = [];
    const send = makeOverlayFrameSender({ socket: { readyState: 1, send: (b: Uint8Array) => sent.push(b) } });
    const frame = { type: WRTC_SIGNAL, senderId: 'me', targetId: 'you', signal: { kind: 'offer', sdp: 'v=0' } };

    send(frame);

    expect(sent).toHaveLength(1);
    expect(decode(sent[0])).toEqual(frame);
  });

  test('silently drops when the socket is absent or not open', () => {
    const sent: unknown[] = [];
    expect(() => makeOverlayFrameSender({})({ type: 'x' })).not.toThrow();
    makeOverlayFrameSender({ socket: { readyState: 0, send: (b: unknown) => sent.push(b) } })({ type: 'x' });
    expect(sent).toHaveLength(0);
  });

  test('reads the socket lazily, so a reconnect-swapped socket is picked up', () => {
    const sent: unknown[] = [];
    const wsAdapter: any = {}; // no socket yet — the adapter creates it on connect
    const send = makeOverlayFrameSender(wsAdapter);
    send({ type: 'dropped' });
    wsAdapter.socket = { readyState: 1, send: (b: unknown) => sent.push(b) };
    send({ type: 'delivered' });
    expect(sent).toHaveLength(1);
  });
});
