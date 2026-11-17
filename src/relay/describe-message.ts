import { decode } from 'cbor-x';
import { createLogger } from '../shared/logger';

// Formatting for the relay's message log: `logMessage` renders one routed
// message, and everything below it exists to describe an opaque encrypted
// payload without loading the keyhive WASM module (which the relay deliberately
// avoids).
//
// There is no relay-specific logging switch. This used to be relay-log.ts, with
// its own RELAY_QUIET env var gating relayInfo/relayError; both are gone. The
// firehose is `debug` and the rest is levelled like anywhere else, so LOG_LEVEL
// (=error under Jest and Playwright) covers what RELAY_QUIET used to.
const log = createLogger('relay');

/** Truncate the base64 key but keep any `-suffix` intact — the suffix is the
 * per-service part of a peerId ('drive', 'caldav-server'), so it's what tells
 * two services of the same device apart in collision/routing logs.
 *
 * Tolerates a non-string: ids come off the wire, so a malformed frame can carry
 * an object here (see relay.test.ts "does not throw on non-string targetId").
 * Formatting a log line must never be what takes the relay's message handler
 * into its error backstop. */
export function shortId(id: string): string {
  if (typeof id !== 'string') return String(id);
  const dash = id.indexOf('-');
  if (dash === -1) return id.length > 8 ? id.slice(0, 6) + '…' : id;
  const key = id.slice(0, dash);
  const suffix = id.slice(dash); // includes the '-'
  return (key.length > 8 ? key.slice(0, 6) + '…' : key) + suffix;
}

// Render bytes as printable ASCII, replacing non-printable/high bytes with '.'
function sanitizeAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
    .join('');
}

function describeData(data: unknown): string {
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const prefix = sanitizeAscii(data.subarray(0, 10));
    const suffix = sanitizeAscii(data.subarray(Math.max(0, data.length - 10)));
    // Simple FNV-1a 32-bit checksum for cheap payload fingerprinting
    let hash = 0x811c9dc5;
    for (const b of data) {
      hash = (Math.imul(hash ^ b, 0x01000193) >>> 0);
    }
    const checksum = hash.toString(16).padStart(8, '0');
    return `[hash=${checksum} ${data.length} bytes, "${prefix}…${suffix}"]`;
  }
  return `[unknown size]`;
}

/**
 * Width of the length prefix keyhive's frame uses for a payload of `n` bytes.
 *
 * The prefix is a canonical variable-width integer: one byte for n < 248, and
 * above that a marker byte followed by k big-endian bytes, where each width
 * starts counting where the previous one ended (so every length has exactly one
 * encoding): 248..503 take 2 bytes, 504..66039 take 3, and so on.
 */
function lengthPrefixSize(n: number): number {
  let limit = 248;
  let span = 256;
  let size = 1;
  while (n >= limit) {
    limit += span;
    span *= 256;
    size++;
  }
  return size;
}

/**
 * Extract the signed payload from a keyhive `SignedBytes` frame without loading
 * the keyhive WASM module (which the relay deliberately avoids).
 *
 * The frame is
 *   "KHB" | version (1) | issuer verifying key (32) | payload length | payload | signature (64)
 * with a variable-width length (see lengthPrefixSize). Rather than decode that
 * integer, find the one prefix width consistent with the frame's total size:
 * everything else in the frame is fixed-width, so the payload is whatever lies
 * between the prefix and the trailing signature.
 *
 * Returns undefined for anything that is not such a frame. The relay only logs
 * with this; nothing is verified.
 */
export function extractSignedPayload(signedBytes: Uint8Array): Uint8Array | undefined {
  const HEADER = 4 + 32; // magic + version, issuer
  const SIGNATURE = 64;
  if (signedBytes.length < HEADER + 1 + SIGNATURE) return undefined;
  if (signedBytes[0] !== 0x4b || signedBytes[1] !== 0x48 || signedBytes[2] !== 0x42) return undefined; // "KHB"
  const body = signedBytes.length - HEADER - SIGNATURE; // prefix + payload
  for (let prefix = 1; prefix <= 9; prefix++) {
    const n = body - prefix;
    if (n < 0) break;
    if (lengthPrefixSize(n) === prefix) return signedBytes.subarray(HEADER + prefix, HEADER + prefix + n);
  }
  return undefined;
}

function isBytes(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array || Buffer.isBuffer(v);
}

// Hex preview of the first `max` bytes, with an ellipsis if truncated.
function hexPreview(bytes: Uint8Array, max = 8): string {
  let s = '';
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return bytes.length > max ? `${s}…(${bytes.length}b)` : s;
}

// Render an array of byte strings (op hashes / event blobs) as a count plus a
// capped list of hex previews so individual ops can be correlated across peers.
const MAX_ITEMS = 8;
function describeByteList(arr: unknown): string {
  if (!Array.isArray(arr)) return '0';
  const shown = arr
    .slice(0, MAX_ITEMS)
    .map((item) => (isBytes(item) ? hexPreview(item) : String(item)));
  const more = arr.length > MAX_ITEMS ? `, +${arr.length - MAX_ITEMS} more` : '';
  return `${arr.length} [${shown.join(', ')}${more}]`;
}

// JSON-stringify a decoded CBOR value for logging: byte strings become hex
// previews, bigints become decimal, and the whole thing is length-capped.
function stringifyValue(value: unknown): string {
  const MAX = 300;
  try {
    const json = JSON.stringify(value, (_k, v) => {
      if (isBytes(v)) return `<${hexPreview(v)}>`;
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
    if (json === undefined) return String(value);
    return json.length > MAX ? `${json.slice(0, MAX)}…` : json;
  } catch {
    return String(value);
  }
}

// Format a message payload according to its type. keyhive-* payloads (found
// inside the signed envelope) are CBOR. `ephemeral` is CBOR too, and `sync` /
// `change` are raw Automerge sync messages: the keyhive bridge signs only its
// own keyhive-* messages and passes every other message through untouched, so
// document content crosses the relay unencrypted.
function describePayload(type: string, payload: Uint8Array): string {
  switch (type) {
    case 'ephemeral': {
      // The broadcast payload (e.g. presence state) is CBOR-encoded.
      return `ephemeral=${stringifyValue(decode(payload))}`;
    }
    case 'keyhive-sync-check': {
      const d = decode(payload) as { senderTotal?: number; senderSyncpoint?: number; senderDigest?: unknown };
      const digest = isBytes(d.senderDigest) ? hexPreview(d.senderDigest) : String(d.senderDigest);
      return `check{senderTotal=${d.senderTotal}, senderSyncpoint=${d.senderSyncpoint}, digest=${digest}}`;
    }
    case 'keyhive-sync-request': {
      const d = decode(payload) as { found?: unknown[]; pending?: unknown[] };
      return `request{found=${describeByteList(d.found)}, pending=${describeByteList(d.pending)}}`;
    }
    case 'keyhive-sync-response': {
      const d = decode(payload) as {
        requested?: unknown[]; found?: unknown[]; senderTotal?: number; receiverTotal?: number;
      };
      return `response{requested=${describeByteList(d.requested)}, found=${describeByteList(d.found)}, senderTotal=${d.senderTotal}, receiverTotal=${d.receiverTotal}}`;
    }
    case 'keyhive-sync-ops': {
      const d = decode(payload) as
        | unknown[]
        | { ops?: unknown[]; senderTotal?: number; receiverTotal?: number };
      // Legacy path encodes a bare array; current path encodes an object.
      if (Array.isArray(d)) return `ops{ops=${describeByteList(d)}}`;
      return `ops{ops=${describeByteList(d.ops)}, senderTotal=${d.senderTotal}, receiverTotal=${d.receiverTotal}}`;
    }
    case 'keyhive-sync-confirmation': {
      const d = decode(payload) as { myTotalForThem?: number; theirTotalForMe?: number };
      return `confirmation{myTotalForThem=${d.myTotalForThem}, theirTotalForMe=${d.theirTotalForMe}}`;
    }
    case 'sync':
    case 'change': {
      if (payload.length === 0) return '[empty]';
      // A raw Automerge sync message. Say so plainly; do not print its bytes —
      // they are the user's document content.
      return `[automerge sync, ${payload.length} bytes, not encrypted]`;
    }
    default:
      return describeData(payload);
  }
}

/** Describe a payload by type, falling back to a fingerprint if it will not decode. */
function describePayloadSafely(type: string, payload: Uint8Array): string {
  try {
    return describePayload(type, payload);
  } catch {
    return describeData(payload);
  }
}

/**
 * Describe a message's `data`.
 *
 * A keyhive-* message wraps its payload as CBOR `{ contactCard, signed }`, where
 * `signed` is a keyhive signed frame over the real payload. We peel both layers
 * (see extractSignedPayload) and format the payload per message type; the signer
 * and the optional contact card are noted, not decoded. Every other message
 * (document sync, ephemeral) is not enveloped at all and is described directly.
 */
function describeMessageData(type: string, data: unknown): string {
  if (!isBytes(data)) return describeData(data);
  if (!type.startsWith('keyhive-')) return describePayloadSafely(type, data);

  let envelope: { contactCard?: unknown; signed?: unknown };
  try {
    envelope = decode(data) as { contactCard?: unknown; signed?: unknown };
  } catch {
    return describeData(data);
  }
  if (!envelope || !isBytes(envelope.signed)) return describeData(data);

  const payload = extractSignedPayload(envelope.signed);
  if (!payload) return describeData(data);

  const body = describePayloadSafely(type, payload);

  // Note (don't decode) the envelope-level signer and optional contact card.
  const notes = ['signer'];
  if (isBytes(envelope.contactCard) && envelope.contactCard.length > 0) notes.push('card');
  return `${body} +(${notes.join(', ')})`;
}

/**
 * One line per routed message: a firehose, hence debug.
 *
 * The level check comes FIRST and guards everything below it. Describing a
 * message decodes CBOR, peels a keyhive signed frame and hashes the
 * payload — far too much to do per message on the off chance someone is
 * watching. (This replaced an `if (RELAY_QUIET) return` that had the same job.)
 */
export function logMessage(dir: '←' | '→', peerId: string, message: any) {
  if (!log.enabled('debug')) return;
  const type = message.type ?? message;
  const parts = [`${dir} ${shortId(peerId)} ${type}`];

  if (message.senderId) parts.push(`from=${shortId(message.senderId)}`);
  if (message.targetId) parts.push(`to=${shortId(message.targetId)}`);
  if (message.documentId) parts.push(`doc=${shortId(message.documentId)}`);
  if (message.count !== undefined) parts.push(`count=${message.count}`);
  if (message.sessionId) parts.push(`session=${message.sessionId}`);

  if (message.data != null) {
    parts.push(`data=${describeMessageData(type, message.data)}`);
  }

  if (message.peerMetadata) {
    const meta = message.peerMetadata;
    const metaParts: string[] = [];
    if (meta.storageId) metaParts.push(`storageId=${shortId(meta.storageId)}`);
    if (meta.isEphemeral !== undefined) metaParts.push(`ephemeral=${meta.isEphemeral}`);
    if (metaParts.length > 0) parts.push(`meta={${metaParts.join(', ')}}`);
  }

  // Array-check, not truthy-check: this comes off the wire (see shortId).
  if (Array.isArray(message.supportedProtocolVersions)) {
    parts.push(`versions=[${message.supportedProtocolVersions.join(',')}]`);
  }
  if (message.selectedProtocolVersion) {
    parts.push(`version=${message.selectedProtocolVersion}`);
  }

  log.debug(parts.join(' '));
}
