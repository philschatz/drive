/**
 * Discovery tokens (src/shared/discovery-tokens.ts): what a device shows the
 * relay so that it is introduced to the devices it should meet, and to no
 * others, without the relay learning who anyone is.
 */
import {
  agreementKeyOf, pairSecret, discoveryToken, makeDiscoveryTokenBuilder, utcDay,
  readLinkedDevices, pendingLinkedDevices, LINKED_DEVICE_TTL_MS,
} from '../src/shared/discovery-tokens';

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 10, 25, 12);

/** A device as keyhive makes one: an extractable Ed25519 key pair. Returns the pieces the tokens are built from. */
async function device() {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const agreementKey = agreementKeyOf(pair.privateKey);
  return {
    key: Buffer.from(publicRaw).toString('base64'), // the device key, as an agent id
    publicRaw,
    agreementKey,
    builder: makeDiscoveryTokenBuilder(agreementKey),
  };
}
const shared = (a: string[], b: string[]) => a.filter((t) => b.includes(t));

describe('a pair secret', () => {
  it('is the same on both devices, computed by each from its own key and the other\'s public one', async () => {
    const a = await device(), b = await device();
    const atA = await pairSecret(await a.agreementKey, b.publicRaw);
    const atB = await pairSecret(await b.agreementKey, a.publicRaw);
    expect(Buffer.from(atA).equals(Buffer.from(atB))).toBe(true);
    expect(atA).toHaveLength(32);
  });

  it('is not what a third device gets from the two public keys', async () => {
    const a = await device(), b = await device(), c = await device();
    const ab = await pairSecret(await a.agreementKey, b.publicRaw);
    for (const guess of [await pairSecret(await c.agreementKey, a.publicRaw), await pairSecret(await c.agreementKey, b.publicRaw)]) {
      expect(Buffer.from(guess).equals(Buffer.from(ab))).toBe(false);
    }
  });

  it('is refused for something that is not a device key', async () => {
    const a = await device();
    await expect(pairSecret(await a.agreementKey, new Uint8Array(32).fill(0xff))).rejects.toThrow();
  });
});

describe('a token', () => {
  it('is sixteen bytes that say nothing of the secret, and another sixteen the next day', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const today = await discoveryToken(secret, utcDay(NOON));
    expect(Buffer.from(today, 'base64')).toHaveLength(16);
    expect(await discoveryToken(secret, utcDay(NOON))).toBe(today);
    expect(await discoveryToken(secret, utcDay(NOON) + 1)).not.toBe(today);
    expect(await discoveryToken(crypto.getRandomValues(new Uint8Array(32)), utcDay(NOON))).not.toBe(today);
  });
});

describe('what a device presents', () => {
  it('two devices that list each other present a token in common; a device neither lists shares none', async () => {
    const a = await device(), b = await device(), c = await device();
    const fromA = await a.builder.tokens([b.key], NOON);
    const fromB = await b.builder.tokens([a.key], NOON);
    // c knows both their keys — as a former friend, or the relay, would.
    const fromC = await c.builder.tokens([a.key, b.key], NOON);
    expect(shared(fromA, fromB).length).toBe(2); // today's and yesterday's
    expect(shared(fromA, fromC)).toEqual([]);
    expect(shared(fromB, fromC)).toEqual([]);
  });

  it('knowing a device is not enough: it has to list you too', async () => {
    const a = await device(), b = await device();
    const fromA = await a.builder.tokens([b.key], NOON);
    const fromB = await b.builder.tokens([], NOON);
    expect(fromB).toEqual([]);
    expect(shared(fromA, fromB)).toEqual([]);
  });

  it('bridges midnight and a clock that is a day out, but not two', async () => {
    const a = await device(), b = await device();
    const fromA = await a.builder.tokens([b.key], NOON);
    expect(shared(fromA, await b.builder.tokens([a.key], NOON + DAY)).length).toBe(1);
    expect(shared(fromA, await b.builder.tokens([a.key], NOON - DAY)).length).toBe(1);
    expect(shared(fromA, await b.builder.tokens([a.key], NOON + 2 * DAY))).toEqual([]);
  });

  it('is a different set every day: nothing presented today is presented the day after tomorrow', async () => {
    const a = await device(), b = await device(), c = await device();
    const today = await a.builder.tokens([b.key, c.key], NOON);
    const later = await a.builder.tokens([b.key, c.key], NOON + 2 * DAY);
    expect(today).toHaveLength(4);
    expect(shared(today, later)).toEqual([]);
  });

  it('is the same frame for the same devices, whatever their order, and skips what is not a key', async () => {
    const a = await device(), b = await device(), c = await device();
    const one = await a.builder.tokens([b.key, c.key, b.key], NOON);
    const two = await a.builder.tokens([c.key, 'not a key', b.key], NOON);
    expect(two).toEqual(one);
    expect([...one].sort()).toEqual(one);
    expect(one).toHaveLength(4);
  });
});

describe('devices remembered from a link', () => {
  const key = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64');
  const NOW = NOON;

  it('are presented until keyhive lists them, and not after', () => {
    const linked = { [key(1)]: NOW - 1_000, [key(2)]: NOW - 1_000 };
    expect(pendingLinkedDevices(linked, () => false, NOW)).toEqual(linked);
    // keyhive lists the first now: from here on it answers for that device,
    // including on the day it stops listing it.
    expect(pendingLinkedDevices(linked, (k) => k === key(1), NOW)).toEqual({ [key(2)]: NOW - 1_000 });
  });

  it('are forgotten when the link never settled', () => {
    const linked = { [key(1)]: NOW - LINKED_DEVICE_TTL_MS - 1, [key(2)]: NOW - LINKED_DEVICE_TTL_MS + 60_000 };
    expect(Object.keys(pendingLinkedDevices(linked, () => false, NOW))).toEqual([key(2)]);
  });

  it('take nothing from storage that is not a device key and a time', () => {
    expect(readLinkedDevices(null)).toEqual({});
    expect(readLinkedDevices('nonsense')).toEqual({});
    expect(readLinkedDevices({ [key(1)]: 5, short: 5, [key(2)]: 'yesterday', [key(3)]: Number.NaN })).toEqual({ [key(1)]: 5 });
  });
});
