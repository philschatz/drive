/**
 * Loopback integration test for the Node WebRTC stack: two real bridge cores,
 * each backed by a real werift RTCPeerConnection, negotiate over an in-memory
 * signaling wire (the role the relay plays in production) and open a direct
 * data channel over UDP loopback — real ICE, real DTLS, real SCTP. Then a
 * >16 KiB message round-trips to exercise chunking end-to-end.
 *
 * `iceServers: []` keeps ICE to host candidates only, so no network beyond
 * loopback is touched. If a sandboxed environment blocks UDP entirely, skip
 * with DRIVE_SKIP_LOOPBACK_TEST=1 rather than deleting — never a silent green.
 */

import { startWebRTCBridgeCore } from '../src/shared/webrtc-bridge-core';
import { createWeriftPeerConnection } from '../src/cli/werift-rtc';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const maybeTest = process.env.DRIVE_SKIP_LOOPBACK_TEST ? test.skip : test;

describe('werift loopback', () => {
  maybeTest('two Node bridges open a direct channel and round-trip 100 KB', async () => {
    const a = new MessageChannel();
    const b = new MessageChannel();
    const stopA = startWebRTCBridgeCore(a.port2 as unknown as MessagePort, {
      iceServers: [], createPeerConnection: createWeriftPeerConnection,
    });
    const stopB = startWebRTCBridgeCore(b.port2 as unknown as MessagePort, {
      iceServers: [], createPeerConnection: createWeriftPeerConnection,
    });

    try {
      const openA = deferred();
      const openB = deferred();
      const dataAtB = deferred<Uint8Array>();

      // The in-memory signaling wire: each side's signal-out becomes the other
      // side's signal-in, exactly what the relay's WRTC_SIGNAL routing does.
      (a.port1 as any).onmessage = (e: { data: any }) => {
        const msg = e.data;
        if (msg.kind === 'signal-out') b.port1.postMessage({ kind: 'signal-in', peerId: 'A', signal: msg.signal });
        if (msg.kind === 'channel-open') openA.resolve();
      };
      (b.port1 as any).onmessage = (e: { data: any }) => {
        const msg = e.data;
        if (msg.kind === 'signal-out') a.port1.postMessage({ kind: 'signal-in', peerId: 'B', signal: msg.signal });
        if (msg.kind === 'channel-open') openB.resolve();
        if (msg.kind === 'data-in') dataAtB.resolve(new Uint8Array(msg.bytes));
      };

      // Deterministic roles, as the adapter's peerId tie-break would assign them.
      a.port1.postMessage({ kind: 'connect-peer', peerId: 'B', initiator: true });
      b.port1.postMessage({ kind: 'connect-peer', peerId: 'A', initiator: false });

      await Promise.all([openA.promise, openB.promise]);

      const payload = new Uint8Array(100_000);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      a.port1.postMessage({ kind: 'data-out', peerId: 'B', bytes: payload });

      const received = await dataAtB.promise;
      expect(received).toEqual(payload); // survived chunking over real SCTP
    } finally {
      stopA();
      stopB();
      a.port1.close();
      b.port1.close();
    }
  }, 30_000);
});
