/**
 * AES-GCM helpers for the encrypted relay rendezvous (see rendezvous-protocol.ts).
 *
 * Runs in the automerge worker (WebCrypto is available there). The symmetric key
 * and rendezvous id are random bytes encoded as base64url so they fit in a QR /
 * URL fragment; only the two peers ever hold the key — the relay sees ciphertext.
 */

const ID_BYTES = 16;
const KEY_BYTES = 32; // AES-256-GCM
const IV_BYTES = 12;

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate a fresh rendezvous id + raw key (both base64url). */
export function generateRendezvous(): { rendezvousId: string; key: string } {
  const id = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  return { rendezvousId: bytesToB64url(id), key: bytesToB64url(key) };
}

async function importKey(keyB64url: string): Promise<CryptoKey> {
  const raw = b64urlToBytes(keyB64url);
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a UTF-8 string under `keyB64url`. Returns `iv ‖ ciphertext`. */
export async function encryptString(keyB64url: string, plaintext: string): Promise<Uint8Array> {
  const key = await importKey(keyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/** Inverse of encryptString. Throws if the key/data don't match (GCM auth fail). */
export async function decryptString(keyB64url: string, framed: Uint8Array): Promise<string> {
  const key = await importKey(keyB64url);
  const iv = framed.subarray(0, IV_BYTES) as BufferSource;
  const ct = framed.subarray(IV_BYTES) as BufferSource;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}
