/**
 * Discovery tokens: how two devices tell the relay they want to meet without
 * telling it who they are.
 *
 * The relay introduces two sockets when they present a token in common, by
 * string equality (src/relay/relay.ts). A token is
 *
 *     HMAC-SHA256(secret, the UTC day), cut to 16 bytes
 *
 * so it says nothing of what the secret is for, cannot be produced without the
 * secret, and is a different string every day: the relay learns no group id,
 * no friend list, and cannot recognise today's device tomorrow by its tokens.
 * Each device presents today's and yesterday's token for every secret it
 * holds, which covers midnight and clocks that disagree by hours.
 *
 * The secret is a **pair secret**: one per pair of devices, X25519 between
 * their identity keys (the Ed25519 device keys keyhive already hands out,
 * converted), through HKDF. Both ends compute it alone, from what they already
 * have — nothing is stored, exchanged or rotated for it, and it never reaches
 * the relay. Two devices are introduced when each presents the token of the
 * pair, which each does for the devices it is *related* to: this user's other
 * devices, a friend's, a document's other members (KeyhiveOps.relatedDevices).
 * Getting introduced to a device therefore takes the private key of a device
 * it lists; knowing its group id, as before, is no longer enough. A device
 * removed from a group stops being listed, and with that stops being met.
 *
 * One case needs a little more. A device that has just been linked is not yet
 * listed by keyhive on its side — the group that names its siblings has to
 * arrive first, from the device that linked it, which it must be introduced to
 * to get. So the two devices of a link remember each other's key
 * (`LinkedDevices`) and present that pair's token too, until keyhive lists the
 * device or a week has passed.
 *
 * What the relay still sees: which sockets it introduced, how many tokens each
 * presents, and the device key in each peer id. Hiding those needs another
 * handshake, not other tokens.
 */
import { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';

const DAY_MS = 86_400_000;
const TOKEN_BYTES = 16;
const SECRET_BYTES = 32;
/** How long a device remembered from a link is presented without keyhive listing it. */
export const LINKED_DEVICE_TTL_MS = 7 * DAY_MS;

const utf8 = (s: string) => new TextEncoder().encode(s);
const buf = (bytes: Uint8Array) => bytes as unknown as BufferSource;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The UTC day a moment falls in, counted from the epoch. */
export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * This device's key for agreeing pair secrets: its Ed25519 identity key, as the
 * X25519 key the same seed gives.
 */
export async function agreementKeyOf(devicePrivateKey: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey('jwk', devicePrivateKey);
  if (typeof jwk.d !== 'string') throw new Error('the device key cannot be read');
  return edwardsToMontgomeryPriv(fromBase64(jwk.d));
}

/**
 * The secret this device shares with the device whose (Ed25519) key is
 * `theirDeviceKey`: the same bytes that device computes from its own key and
 * this device's. Throws for a key that is not a usable curve point.
 */
export async function pairSecret(agreementKey: Uint8Array, theirDeviceKey: Uint8Array): Promise<Uint8Array> {
  const shared = x25519.getSharedSecret(agreementKey, edwardsToMontgomeryPub(theirDeviceKey));
  const base = await crypto.subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(new Uint8Array(0)), info: buf(utf8('drive-discovery/1 pair')) },
    base, SECRET_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** The token a secret gives on a day. */
export async function discoveryToken(secret: Uint8Array, day: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', buf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf(utf8(`drive-discovery/1 day ${day}`))));
  return toBase64(mac.subarray(0, TOKEN_BYTES));
}

/**
 * Builds what a device presents to the relay. Pair secrets are kept once
 * computed (one curve operation per device, ever); tokens are cheap.
 */
export interface DiscoveryTokenBuilder {
  /**
   * Today's and yesterday's token for each device named: deduplicated and
   * sorted, so that the same devices give the same frame.
   */
  tokens(deviceKeys: Iterable<string>, now?: number): Promise<string[]>;
}

export function makeDiscoveryTokenBuilder(agreementKey: Promise<Uint8Array>): DiscoveryTokenBuilder {
  // Device key (base64) → the pair secret, or null for a key that gives none.
  const pairs = new Map<string, Promise<Uint8Array | null>>();
  const pairWith = (deviceKey: string): Promise<Uint8Array | null> => {
    let secret = pairs.get(deviceKey);
    if (!secret) {
      secret = agreementKey.then((mine) => pairSecret(mine, fromBase64(deviceKey))).catch(() => null);
      pairs.set(deviceKey, secret);
    }
    return secret;
  };
  return {
    async tokens(deviceKeys, now = Date.now()) {
      const today = utcDay(now);
      const out = new Set<string>();
      for (const deviceKey of new Set(deviceKeys)) {
        const secret = await pairWith(deviceKey);
        if (!secret) continue;
        out.add(await discoveryToken(secret, today));
        out.add(await discoveryToken(secret, today - 1));
      }
      return [...out].sort();
    },
  };
}

// ── Devices remembered from a link ───────────────────────────────────────────

/**
 * The devices this one was linked with and keyhive does not list yet: device
 * key (base64) → when the link was made (ms). See the file header.
 */
export type LinkedDevices = Record<string, number>;

/** Whatever of `value` is a well-formed record (it came from storage). */
export function readLinkedDevices(value: unknown): LinkedDevices {
  const out: LinkedDevices = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Za-z0-9+/]{43}=$/.test(key) && typeof at === 'number' && Number.isFinite(at)) out[key] = at;
  }
  return out;
}

/**
 * The remembered devices still worth presenting a token for: not ones keyhive
 * lists by now (it answers for those from here on — including when it stops
 * listing them), and not ones remembered longer than a link takes to settle.
 */
export function pendingLinkedDevices(
  linked: LinkedDevices, isListed: (deviceKey: string) => boolean, now: number,
): LinkedDevices {
  const out: LinkedDevices = {};
  for (const [key, at] of Object.entries(linked)) {
    if (!isListed(key) && now - at < LINKED_DEVICE_TTL_MS) out[key] = at;
  }
  return out;
}
