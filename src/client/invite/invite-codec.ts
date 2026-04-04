/**
 * Encode/decode invite payloads.
 *
 * Format: 32-byte seed, optionally followed by the inviter's agent ID bytes,
 * all base64url-encoded.
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

/** Encode an invite payload — seed + optional inviter agent ID. */
export function encodeInvitePayload(seed: Uint8Array, inviterAgentId?: Uint8Array): string {
  if (inviterAgentId && inviterAgentId.length > 0) {
    const combined = new Uint8Array(32 + inviterAgentId.length);
    combined.set(seed, 0);
    combined.set(inviterAgentId, 32);
    return toBase64url(combined);
  }
  return toBase64url(seed);
}

/** Decode an invite payload. Returns the 32-byte seed and optional inviter agent ID. */
export function decodeInvitePayload(b64url: string): { seed: Uint8Array; inviterAgentId?: Uint8Array } {
  const bytes = fromBase64url(b64url);
  if (bytes.length < 32) {
    throw new Error(`Invalid invite payload: expected at least 32 bytes, got ${bytes.length}`);
  }
  const seed = bytes.slice(0, 32);
  const inviterAgentId = bytes.length > 32 ? bytes.slice(32) : undefined;
  return { seed, inviterAgentId };
}
