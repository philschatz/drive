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

  /**
   * Feed one received frame. Returns the complete message (a fresh buffer) once
   * its final frame arrives, otherwise null. Frames shorter than the 1-byte
   * header are ignored.
   */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.byteLength < 1) return null;
    const final = frame[0] === FRAME_FINAL;
    const payload = frame.subarray(1);
    this.parts.push(payload);
    this.size += payload.byteLength;
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
