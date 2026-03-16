/**
 * Encode/decode invite payloads.
 *
 * Format: the 32-byte seed, base64url-encoded (~43 chars).
 */

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode an invite payload — seed only. */
export function encodeInvitePayload(seed: Uint8Array): string {
  return toBase64url(seed);
}

/** Decode an invite payload. Returns the 32-byte seed. */
export function decodeInvitePayload(b64url: string): { seed: Uint8Array } {
  const seed = fromBase64url(b64url);
  if (seed.length !== 32) {
    throw new Error(`Invalid invite payload: expected 32-byte seed, got ${seed.length} bytes`);
  }
  return { seed };
}
