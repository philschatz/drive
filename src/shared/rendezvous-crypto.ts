/**
 * AES-GCM helpers for the encrypted relay rendezvous (see rendezvous-protocol.ts).
 *
 * Runs in the automerge worker (WebCrypto is available there). The symmetric key
 * and rendezvous id are random bytes encoded as base64url so they fit in a QR /
 * URL fragment; only the two peers ever hold the key — the relay sees ciphertext.
 *
 * Every message is bound to the rendezvous it belongs to and to which side sent
 * it (`RendezvousBinding`, as AES-GCM additional data). A message handed back to
 * its own sender, or to the other side under the wrong role, does not decrypt —
 * the relay carries these frames and could otherwise reflect one.
 *
 * The key in a link is a bearer secret: whoever has the link can take either
 * side's part. That is why a device link is asked about before it links, and
 * stops working after a few minutes (engine-rendezvous.ts).
 */

/** Which side of a rendezvous a message comes from: the one that made the link, or the one that opened it. */
export type RendezvousRole = 'host' | 'guest';
export const otherRole = (role: RendezvousRole): RendezvousRole => (role === 'host' ? 'guest' : 'host');

/** What a message is bound to: its rendezvous, and the side that sent it. */
export interface RendezvousBinding { rendezvousId: string; from: RendezvousRole }

const utf8 = (s: string) => new TextEncoder().encode(s);
const bindingBytes = (b: RendezvousBinding) => utf8(`drive-rdv/1|${b.rendezvousId}|${b.from}`);

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

/** Encrypt a UTF-8 string under `keyB64url`, bound to `binding`. Returns `iv ‖ ciphertext`. */
export async function encryptString(keyB64url: string, plaintext: string, binding: RendezvousBinding): Promise<Uint8Array> {
  const key = await importKey(keyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: bindingBytes(binding) as BufferSource }, key, utf8(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/**
 * Inverse of encryptString. Throws if the key, the data or the binding do not
 * match (GCM auth fail): `binding` names the side the message must have come from.
 */
export async function decryptString(keyB64url: string, framed: Uint8Array, binding: RendezvousBinding): Promise<string> {
  const key = await importKey(keyB64url);
  const iv = framed.subarray(0, IV_BYTES) as BufferSource;
  const ct = framed.subarray(IV_BYTES) as BufferSource;
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: bindingBytes(binding) as BufferSource }, key, ct,
  );
  return new TextDecoder().decode(pt);
}
