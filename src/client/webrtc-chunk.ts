/**
 * Message chunking for WebRTC data channels.
 *
 * An SCTP data channel rejects any single message larger than the negotiated
 * `maxMessageSize` (commonly ~256 KB, and as small as ~16 KB on some browsers) —
 * a large doc's sync message easily exceeds it. The relay/WebSocket transport has
 * no such limit, so this is WebRTC-specific: the bridge splits an outgoing message
 * into small frames and the receiving bridge reassembles them.
 *
 * Wire format — each frame is `[flag byte][payload]`:
 *   flag 0x01 = final frame of a message  → deliver the reassembled message
 *   flag 0x00 = more frames follow
 * The channel is reliable + ordered and carries one message's frames contiguously,
 * so a simple final-flag accumulator is sufficient (no per-message id needed). A
 * small message still produces a single (final) frame, keeping the receive path
 * uniform. Both peers must run this scheme — it rides the direct channel only.
 */

/** Max bytes per data-channel message. 16 KiB is safe across every browser's SCTP maxMessageSize. */
export const MAX_FRAME_BYTES = 16 * 1024;

/**
 * Hard cap on one reassembled message. The peer at the other end is untrusted
 * (the channel is negotiated below keyhive, before any document access), so a
 * stream of never-final frames must not grow memory without bound. 64 MiB
 * matches the relay's frame cap (`RELAY_MAX_PAYLOAD_BYTES` default) — anything
 * legitimately syncable over the relay path also fits the direct channel.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Cap on frames per message, so a flood of tiny frames can't bloat the part
 *  list: a max-size message in legit 16 KiB frames needs ~4 100 — allow 2×. */
export const MAX_MESSAGE_FRAMES = 8192;

/** Thrown by {@link FrameReassembler.push} when a sender exceeds the reassembly
 *  bounds. The reassembler has already reset itself; the bridge reacts by
 *  closing that peer's data channel (sync falls back to the relay). */
export class FrameOverflowError extends Error {
  constructor(detail: string) {
    super(`WebRTC frame reassembly overflow: ${detail}`);
    this.name = 'FrameOverflowError';
  }
}

const FRAME_MORE = 0x00;
const FRAME_FINAL = 0x01;

/**
 * Split a message into framed chunks no larger than `maxFrameBytes` (header
 * included). Always returns at least one frame, so an empty message round-trips.
 */
export function frameMessage(bytes: Uint8Array, maxFrameBytes: number = MAX_FRAME_BYTES): Uint8Array[] {
  const maxPayload = maxFrameBytes - 1;
  const frames: Uint8Array[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + maxPayload, bytes.byteLength);
    const final = end >= bytes.byteLength;
    const frame = new Uint8Array(end - offset + 1);
    frame[0] = final ? FRAME_FINAL : FRAME_MORE;
    frame.set(bytes.subarray(offset, end), 1);
    frames.push(frame);
    offset = end;
  } while (offset < bytes.byteLength);
  return frames;
}

/** Reassembles framed chunks (see {@link frameMessage}) back into whole messages. */
export class FrameReassembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  private readonly maxMessageBytes: number;
  private readonly maxFrames: number;

  constructor(limits?: { maxMessageBytes?: number; maxFrames?: number }) {
    this.maxMessageBytes = limits?.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.maxFrames = limits?.maxFrames ?? MAX_MESSAGE_FRAMES;
  }

  /**
   * Feed one received frame. Returns the complete message (a fresh buffer) once
   * its final frame arrives, otherwise null. Frames shorter than the 1-byte
   * header are ignored. Throws {@link FrameOverflowError} (after resetting) if
   * the sender exceeds the size/count bounds — the caller should drop the channel.
   */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.byteLength < 1) return null;
    const final = frame[0] === FRAME_FINAL;
    const payload = frame.subarray(1);
    this.parts.push(payload);
    this.size += payload.byteLength;
    if (this.size > this.maxMessageBytes || this.parts.length > this.maxFrames) {
      const detail = `${this.size} bytes in ${this.parts.length} frames (max ${this.maxMessageBytes} bytes / ${this.maxFrames} frames)`;
      this.parts = [];
      this.size = 0;
      throw new FrameOverflowError(detail);
    }
    if (!final) return null;

    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    this.parts = [];
    this.size = 0;
    return out;
  }
}
