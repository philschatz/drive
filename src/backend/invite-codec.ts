/**
 * Node.js port of src/client/invite/invite-codec.ts.
 *
 * Format: the 32-byte seed, base64url-encoded (~43 chars).
 */

function toBase64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(b64url: string): Buffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

export function encodeInvitePayload(seed: Uint8Array): string {
  return toBase64url(Buffer.from(seed));
}

export function decodeInvitePayload(b64url: string): { seed: Uint8Array } {
  const buf = fromBase64url(b64url);
  if (buf.length !== 32) {
    throw new Error(`Invalid invite payload: expected 32-byte seed, got ${buf.length} bytes`);
  }
  return { seed: new Uint8Array(buf) };
}

/**
 * Parse an invite URL and extract the docId and payload.
 * Supports formats:
 *   http://host/#/invite/{docId}/{docType}/{payload}
 *   http://host/#/invite/{docId}/{payload}
 */
export function parseInviteUrl(url: string): { docId: string; docType?: string; payload: string } {
  const hash = url.includes('#') ? url.split('#')[1] : url;
  const parts = hash.replace(/^\//, '').split('/');
  // parts: ["invite", docId, docType?, payload]
  if (parts[0] !== 'invite' || parts.length < 3) {
    throw new Error('Invalid invite URL format');
  }
  if (parts.length >= 4) {
    return { docId: parts[1], docType: parts[2], payload: parts[3] };
  }
  return { docId: parts[1], payload: parts[2] };
}
