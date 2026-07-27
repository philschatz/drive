/**
 * WebRTC message chunking — reproduces the "Message size exceeds maxMessageSize"
 * failure and verifies frame/reassemble round-trips.
 *
 * A single RTCDataChannel message larger than the negotiated maxMessageSize is
 * rejected by the browser (the bug: a ~1.5 MB sync message threw). frameMessage
 * must split it into frames no larger than the limit, and FrameReassembler must
 * rebuild the exact original bytes on the other side.
 */

import {
  frameMessage,
  FrameReassembler,
  FrameOverflowError,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_FRAMES,
} from '../src/client/shared/webrtc-chunk';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

/** Feed a peer's frames (in order) through a reassembler, collecting whole messages. */
function reassembleAll(frames: Uint8Array[]): Uint8Array[] {
  const reasm = new FrameReassembler();
  const messages: Uint8Array[] = [];
  for (const f of frames) {
    const full = reasm.push(f);
    if (full) messages.push(full);
  }
  return messages;
}

describe('webrtc-chunk', () => {
  it('reproduces the bug: a 1.5 MB message is split into channel-safe frames', () => {
    const big = randomBytes(1_549_604); // the size from the reported error
    const frames = frameMessage(big);

    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(f.byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
  });

  it.each([0, 1, 100, MAX_FRAME_BYTES - 2, MAX_FRAME_BYTES - 1, MAX_FRAME_BYTES, MAX_FRAME_BYTES + 1, 1_549_604])(
    'round-trips a %i-byte message',
    (size) => {
      const original = randomBytes(size);
      const [restored, ...extra] = reassembleAll(frameMessage(original));
      expect(extra).toHaveLength(0); // exactly one message delivered
      expect(restored).toEqual(original);
    },
  );

  it('keeps consecutive messages separate across one channel', () => {
    const a = randomBytes(MAX_FRAME_BYTES * 3 + 10);
    const b = randomBytes(50);
    const messages = reassembleAll([...frameMessage(a), ...frameMessage(b)]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(a);
    expect(messages[1]).toEqual(b);
  });

  it('ignores empty frames without a header byte', () => {
    const reasm = new FrameReassembler();
    expect(reasm.push(new Uint8Array(0))).toBeNull();
  });
});

describe('webrtc-chunk reassembly bounds (hostile peer)', () => {
  it('the default caps fit anything the relay path would carry (64 MiB)', () => {
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024); // relay RELAY_MAX_PAYLOAD_BYTES default
    // The frame-count cap must not reject a max-size message sent in legit frames.
    expect(MAX_MESSAGE_FRAMES * (MAX_FRAME_BYTES - 1)).toBeGreaterThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('a never-final stream overflows at the default byte cap instead of growing unboundedly', () => {
    const reasm = new FrameReassembler();
    // One shared MORE frame re-fed forever: parts are subarray views of the same
    // buffer, so the test itself stays cheap while `size` climbs to the cap.
    const frame = new Uint8Array(MAX_FRAME_BYTES); // frame[0] = 0x00 = FRAME_MORE
    const pushesToExceed = Math.floor(MAX_MESSAGE_BYTES / (MAX_FRAME_BYTES - 1)) + 1;
    expect(() => {
      for (let i = 0; i <= pushesToExceed; i++) reasm.push(frame);
    }).toThrow(FrameOverflowError);
  });

  it('a flood of tiny never-final frames trips the frame-count cap', () => {
    const reasm = new FrameReassembler();
    const tiny = new Uint8Array([0x00, 1]); // MORE + 1 payload byte
    expect(() => {
      for (let i = 0; i <= MAX_MESSAGE_FRAMES; i++) reasm.push(tiny);
    }).toThrow(FrameOverflowError);
  });

  it('a message exactly at the byte cap still reassembles (no false positive)', () => {
    const reasm = new FrameReassembler({ maxMessageBytes: 1024 });
    const original = randomBytes(1024);
    let out: Uint8Array | null = null;
    for (const f of frameMessage(original, 256)) out = reasm.push(f);
    expect(out).toEqual(original);
  });

  it('one byte over the cap overflows, even on the final frame', () => {
    const reasm = new FrameReassembler({ maxMessageBytes: 1024 });
    const original = randomBytes(1025);
    expect(() => {
      for (const f of frameMessage(original, 256)) reasm.push(f);
    }).toThrow(FrameOverflowError);
  });

  it('resets after overflow so a subsequent legitimate message still works', () => {
    const reasm = new FrameReassembler({ maxMessageBytes: 64, maxFrames: 4 });
    expect(() => {
      for (let i = 0; i < 5; i++) reasm.push(new Uint8Array([0x00, 1, 2]));
    }).toThrow(FrameOverflowError);

    const original = randomBytes(50);
    let out: Uint8Array | null = null;
    for (const f of frameMessage(original, 32)) out = reasm.push(f);
    expect(out).toEqual(original);
  });
});
