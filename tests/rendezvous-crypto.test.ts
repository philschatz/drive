/**
 * The relay carries rendezvous frames, and could hand one back to its sender
 * or replay it elsewhere: each message is bound to its rendezvous and to the
 * side that sent it, and opens nowhere else.
 */
import { generateRendezvous, encryptString, decryptString } from '../src/shared/rendezvous-crypto';

describe('rendezvous messages', () => {
  const { rendezvousId, key } = generateRendezvous();

  it('open for the other side of the same rendezvous', async () => {
    const framed = await encryptString(key, 'hello', { rendezvousId, from: 'host' });
    expect(await decryptString(key, framed, { rendezvousId, from: 'host' })).toBe('hello');
  });

  it('do not open when handed back to the side that sent them', async () => {
    const framed = await encryptString(key, 'hello', { rendezvousId, from: 'host' });
    // The host expects a message from the guest; its own, reflected, is not one.
    await expect(decryptString(key, framed, { rendezvousId, from: 'guest' })).rejects.toThrow();
  });

  it('do not open under another rendezvous, even with the same key', async () => {
    const framed = await encryptString(key, 'hello', { rendezvousId, from: 'host' });
    await expect(decryptString(key, framed, { rendezvousId: generateRendezvous().rendezvousId, from: 'host' })).rejects.toThrow();
  });

  it('do not open under another key, or when altered', async () => {
    const framed = await encryptString(key, 'hello', { rendezvousId, from: 'host' });
    await expect(decryptString(generateRendezvous().key, framed, { rendezvousId, from: 'host' })).rejects.toThrow();
    const altered = framed.slice();
    altered[altered.length - 1] ^= 1;
    await expect(decryptString(key, altered, { rendezvousId, from: 'host' })).rejects.toThrow();
  });
});
