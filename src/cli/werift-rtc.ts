/**
 * werift RTC driver for the shared WebRTC bridge core.
 *
 * werift is a pure-TypeScript WebRTC stack (ICE/DTLS/SCTP over Node's dgram) —
 * chosen over native bindings because a prebuilt `.node` binary has no reliable
 * way to load on NixOS (no global loader paths), and the systemd sync unit runs
 * outside any dev shell. Its API is W3C-like but not identical, so this file
 * adapts exactly the surface `webrtc-bridge-core.ts` touches:
 *   - `dc.send` requires a Buffer (wrap the Uint8Array frame, no copy);
 *   - inbound messages arrive as Buffer (already a Uint8Array — pass through);
 *   - `binaryType` does not exist (the shim carries an inert property);
 *   - `onicecandidate` delivers `candidate: RTCIceCandidate | undefined`
 *     (W3C `null` at end-of-gathering), and the candidate's `toJSON()` is
 *     already RTCIceCandidateInit-shaped, matching what browsers expect.
 */
import {
  RTCPeerConnection as WeriftRTCPeerConnection,
  type RTCDataChannel as WeriftDataChannel,
  type RTCIceCandidateInit,
} from 'werift';
import type { MinimalDataChannel, MinimalPeerConnection } from '../shared/webrtc-bridge-core';
import type { IceServer } from '../shared/ice-config';

function wrapChannel(dc: WeriftDataChannel): MinimalDataChannel {
  const shim: MinimalDataChannel = {
    binaryType: 'arraybuffer', // inert: werift always delivers Buffer
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: (data) => dc.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
    close: () => dc.close(),
  };
  dc.onopen = () => shim.onopen?.();
  dc.onclose = () => shim.onclose?.();
  dc.onerror = (e) => shim.onerror?.(e);
  dc.onmessage = (e) => shim.onmessage?.({ data: e.data });
  // werift emits ondatachannel *before* flipping the channel open (the core
  // wires its handlers synchronously in between), but guard against a future
  // version delivering an already-open channel: fire once on the microtask
  // after the core's handlers are attached.
  if (dc.readyState === 'open') queueMicrotask(() => shim.onopen?.());
  return shim;
}

export function createWeriftPeerConnection(cfg: { iceServers: IceServer[] }): MinimalPeerConnection {
  const pc = new WeriftRTCPeerConnection({
    iceServers: cfg.iceServers.map((s) => ({ urls: s.urls, username: s.username, credential: s.credential })),
  });
  const shim: MinimalPeerConnection = {
    get iceConnectionState() { return pc.iceConnectionState; },
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel: (label, init) => wrapChannel(pc.createDataChannel(label, { ordered: init.ordered })),
    createOffer: async () => {
      const offer = await pc.createOffer();
      return { type: 'offer', sdp: offer.sdp };
    },
    createAnswer: async () => {
      const answer = await pc.createAnswer();
      return { type: 'answer', sdp: answer.sdp };
    },
    setLocalDescription: async (desc) => { await pc.setLocalDescription(desc); },
    setRemoteDescription: async (desc) => { await pc.setRemoteDescription(desc); },
    addIceCandidate: async (candidate) => { await pc.addIceCandidate(candidate as RTCIceCandidateInit); },
    close: () => { void pc.close().catch(() => { /* already closed */ }); },
  };
  pc.onicecandidate = (e) => shim.onicecandidate?.({ candidate: e.candidate ?? null });
  pc.oniceconnectionstatechange = () => shim.oniceconnectionstatechange?.();
  pc.ondatachannel = (e) => shim.ondatachannel?.({ channel: wrapChannel(e.channel) });
  return shim;
}
