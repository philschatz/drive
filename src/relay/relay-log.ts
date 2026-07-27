import { decode } from 'cbor-x';

// Relay logging is a per-message firehose. Tests set RELAY_QUIET=1 to silence
// the informational output (peer join/leave + every routed message) while
// keeping console.error for genuine failures. Default (unset) preserves the
// full dev/prod logging.
const RELAY_QUIET = process.env.RELAY_QUIET === '1';

/** Informational relay log — suppressed when RELAY_QUIET=1 (e.g. under tests). */
export function relayInfo(...args: unknown[]): void {
  if (!RELAY_QUIET) console.log(...args);
}

/**
 * Expected-condition relay log — a policy/hardening response the relay makes on
 * purpose (peer-id squat rejection, connection-cap refusal, slow-peer
 * disconnect, malformed-frame rejection). These are normal for an
 * internet-facing relay and are exercised by tests, so they're gated by
 * RELAY_QUIET. Genuinely-unexpected internal failures should stay on raw
 * console.error so real bugs surface even under RELAY_QUIET.
 */
export function relayWarn(...args: unknown[]): void {
  if (!RELAY_QUIET) console.warn(...args);
}
export function relayError(...args: unknown[]): void {
  if (!RELAY_QUIET) console.error(...args);
}

/** Truncate the base64 key but keep any `-suffix` intact — the suffix is the
 * per-service part of a peerId ('drive', 'caldav-server'), so it's what tells
 * two services of the same device apart in collision/routing logs. */
export function shortId(id: string): string {
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
 * Extract the signed payload from a keyhive `Signed` blob without loading the
 * keyhive WASM module (which the relay deliberately avoids).
 *
 * `Signed::to_bytes()` is `bincode::serialize(Signed<Vec<u8>>)`. With bincode's
 * default config (little-endian, fixed-width lengths) and the struct field order
 * `payload, issuer, signature`, the layout is:
 *   [u64-LE payload length][payload bytes][32-byte issuer][64-byte signature]
 * Since `payload` is first, we can slice it off using just the leading length.
 */
function extractSignedPayload(signedBytes: Uint8Array): Uint8Array | undefined {
  if (signedBytes.length < 8) return undefined;
  const view = new DataView(
    signedBytes.buffer,
    signedBytes.byteOffset,
    signedBytes.byteLength
  );
  const len = Number(view.getBigUint64(0, true));
  if (len < 0 || 8 + len > signedBytes.length) return undefined;
  return signedBytes.subarray(8, 8 + len);
}

// Prefix byte keyhive uses to mark a signed payload as encrypted document
// content (mirrors ENC_ENCRYPTED in the keyhive network adapter's messages.ts).
const ENC_ENCRYPTED = 0x01;

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

// Format the inner (post-envelope) payload according to the message type. Every
// keyhive payload is CBOR; sync/change payloads are an encryption-prefixed blob.
function describePayload(type: string, payload: Uint8Array): string {
  switch (type) {
    case 'ephemeral': {
      // The broadcast payload (e.g. presence state) is CBOR-encoded.
      return `ephemeral=${stringifyValue(decode(payload))}`;
    }
    case 'keyhive-sync-check': {
      const d = decode(payload) as { myTotal?: number; beliefOfTheirTotal?: number };
      return `check{myTotal=${d.myTotal}, beliefOfTheirTotal=${d.beliefOfTheirTotal}}`;
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
      // Document content is encrypted; we can only confirm the encryption marker
      // and show a sanitized peek at the ciphertext for correlation.
      const head = sanitizeAscii(payload.subarray(0, 10));
      const tail = sanitizeAscii(payload.subarray(Math.max(0, payload.length - 10)));
      if (payload[0] === ENC_ENCRYPTED) {
        return `[encrypted, ${payload.length} bytes, "${head}…${tail}"]`;
      }
      const prefix = payload[0].toString(16).padStart(2, '0');
      return `[plaintext?! prefix=0x${prefix}, ${payload.length} bytes, "${head}…${tail}"]`;
    }
    default:
      return describeData(payload);
  }
}

/**
 * Decode a keyhive message envelope and describe its contents.
 *
 * Every keyhive-adapter message wraps `data` as CBOR `{ contactCard, signed }`,
 * where `signed` is a `Signed` blob over the real payload. We peel both layers
 * (see extractSignedPayload) and format the payload per message type. The
 * contact card and signer are always carried in the envelope, so we note their
 * presence rather than decoding them.
 */
function describeMessageData(type: string, data: unknown): string {
  if (!isBytes(data)) return describeData(data);

  let envelope: { contactCard?: string; signed?: unknown };
  try {
    envelope = decode(data) as { contactCard?: string; signed?: unknown };
  } catch {
    return describeData(data);
  }
  if (!envelope || !isBytes(envelope.signed)) return describeData(data);

  const payload = extractSignedPayload(envelope.signed);
  if (!payload) return describeData(data);

  let body: string;
  try {
    body = describePayload(type, payload);
  } catch {
    body = describeData(payload);
  }

  // Note (don't decode) the envelope-level signer and optional contact card.
  const notes = ['signer'];
  if (envelope.contactCard && envelope.contactCard.length > 0) notes.push('card');
  return `${body} +(${notes.join(', ')})`;
}

export function logMessage(dir: '←' | '→', peerId: string, message: any) {
  if (RELAY_QUIET) return;
  const type = message.type ?? message;
  const parts = [`[relay] ${dir} ${shortId(peerId)} ${type}`];

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

  if (message.supportedProtocolVersions) {
    parts.push(`versions=[${message.supportedProtocolVersions.join(',')}]`);
  }
  if (message.selectedProtocolVersion) {
    parts.push(`version=${message.selectedProtocolVersion}`);
  }

  console.log(parts.join(' '));
}
