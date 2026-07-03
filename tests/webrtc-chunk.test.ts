/**
 * WebRTC message chunking — reproduces the "Message size exceeds maxMessageSize"
 * failure and verifies frame/reassemble round-trips.
 *
 * A single RTCDataChannel message larger than the negotiated maxMessageSize is
 * rejected by the browser (the bug: a ~1.5 MB sync message threw). frameMessage
 * must split it into frames no larger than the limit, and FrameReassembler must
 * rebuild the exact original bytes on the other side.
 */

import { frameMessage, FrameReassembler, MAX_FRAME_BYTES } from '../src/client/webrtc-chunk';

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
