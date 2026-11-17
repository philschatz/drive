/**
 * How presence values are encrypted: one stable content ref per (device,
 * channel), with a random salt inside the plaintext.
 *
 * keyhive remembers a key for every content ref a peer writes or reads, and
 * keeps them in the archive. Presence is re-encrypted on every heartbeat and
 * every caret move; under a fresh random ref per message that is ~65 bytes of
 * archive growth per message, on the sender AND on every receiver, forever.
 * These run the real keyhive, because the property is keyhive's, not ours.
 */
import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import {
  Keyhive, Signer, CiphertextStore, ChangeId, Encrypted, ContactCard, MemberedId, Power,
} from '@keyhive/keyhive/slim';
import {
  presenceContentRef, sealPresenceValue, openPresenceValue, presenceEpochOf,
  flushPresenceOutbox, newPresenceOutbox, type PresenceCiphertext,
} from '../src/shared/engine-presence';

initKeyhiveWasm();

async function peer() {
  const kh = await Keyhive.init(Signer.generateMemory(), CiphertextStore.newInMemory(), () => {});
  return { kh, id: kh.id.toIdentifier(), agentId: kh.id.toBytes() as Uint8Array };
}
async function sync(a: any, b: any) {
  for (const [from, to] of [[a, b], [b, a], [a, b]]) {
    await to.kh.ingestEventsBytes([...(await from.kh.allAgentEvents()).events.values()]);
  }
}
/** Two peers who both have edit access to one document. */
async function sharedDoc() {
  const a = await peer(), b = await peer();
  await a.kh.receiveContactCard(ContactCard.fromBytes((await b.kh.contactCard()).toBytes()));
  await b.kh.receiveContactCard(ContactCard.fromBytes((await a.kh.contactCard()).toBytes()));
  const docId = await a.kh.generateDocument([], new ChangeId(new Uint8Array(32)), []);
  await a.kh.addMember(b.id, MemberedId.document(docId), Power.edit());
  await sync(a, b);
  return { a, b, docId };
}
const archiveSize = async (p: any) => (await p.kh.toArchive()).toBytes().length;

describe('presenceContentRef', () => {
  const agent = Uint8Array.from({ length: 32 }, (_, i) => i);
  const other = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

  it('is 32 bytes and stable for one device and channel', async () => {
    const ref = await presenceContentRef(agent, 'viewing');
    expect(ref).toHaveLength(32);
    expect(Array.from(await presenceContentRef(agent, 'viewing'))).toEqual(Array.from(ref));
  });

  it('differs per channel and per device', async () => {
    const viewing = Buffer.from(await presenceContentRef(agent, 'viewing')).toString('hex');
    const focused = Buffer.from(await presenceContentRef(agent, 'focusedField')).toString('hex');
    const theirs = Buffer.from(await presenceContentRef(other, 'viewing')).toString('hex');
    expect(new Set([viewing, focused, theirs]).size).toBe(3);
  });
});

describe('sealPresenceValue / openPresenceValue', () => {
  it('round-trips every JSON value, including the ones that look like the envelope', () => {
    for (const value of [true, null, 0, 'x', ['events', 'uid-1', 'title'], { viewing: true }, { s: 'not-a-salt', v: 1 }]) {
      expect(openPresenceValue(sealPresenceValue(value))).toEqual(value);
    }
  });

  it('treats undefined as null (there is no undefined in JSON)', () => {
    expect(openPresenceValue(sealPresenceValue(undefined))).toBeNull();
  });

  it('never produces the same bytes twice for the same value', () => {
    // The cipher is deterministic for one key + ref, so without a salt a peer
    // watching the relay could tell "same state as before" from "changed".
    const a = Buffer.from(sealPresenceValue(true)).toString('hex');
    const b = Buffer.from(sealPresenceValue(true)).toString('hex');
    expect(a).not.toBe(b);
  });
});

describe('presence encryption against real keyhive', () => {
  const ROUNDS = 150;

  async function run(refFor: (agentId: Uint8Array) => Promise<Uint8Array>) {
    const { a, b, docId } = await sharedDoc();
    const send = async (i: number) =>
      (await a.kh.tryEncrypt(docId, new ChangeId(await refFor(a.agentId)), [], sealPresenceValue({ n: i })))
        .encryptedContent().toBytes();
    const receive = async (wire: Uint8Array) =>
      openPresenceValue(await b.kh.tryDecrypt(docId, Encrypted.fromBytes(wire)));
    const exchange = async (i: number) => ({ value: await receive(await send(i)) });
    // The first encrypt after the share rotates the key; b needs that op before
    // it can read anything. Settle it before measuring.
    const first = await send(-1);
    await sync(a, b);
    await receive(first);
    const before = { a: await archiveSize(a), b: await archiveSize(b) };
    for (let i = 0; i < ROUNDS; i++) expect((await exchange(i)).value).toEqual({ n: i });
    return { a, b, docId, grewA: (await archiveSize(a)) - before.a, grewB: (await archiveSize(b)) - before.b };
  }

  it('a fresh random ref per message grows both archives without bound (why the ref is stable)', async () => {
    const { grewA, grewB } = await run(async () => crypto.getRandomValues(new Uint8Array(32)));
    expect(grewA).toBeGreaterThan(ROUNDS * 32);
    expect(grewB).toBeGreaterThan(ROUNDS * 32);
  });

  it('the stable ref leaves both archives the same size, however many messages', async () => {
    const { grewA, grewB } = await run((agentId) => presenceContentRef(agentId, 'focusedField'));
    expect(grewA).toBe(0);
    expect(grewB).toBe(0);
  });

  it('equal states still encrypt to different ciphertexts under the stable ref', async () => {
    const { a, docId } = await sharedDoc();
    const ref = await presenceContentRef(a.agentId, 'viewing');
    const once = await a.kh.tryEncrypt(docId, new ChangeId(ref), [], sealPresenceValue(true));
    const again = await a.kh.tryEncrypt(docId, new ChangeId(ref), [], sealPresenceValue(true));
    expect(Buffer.from(once.encryptedContent().toBytes()).equals(Buffer.from(again.encryptedContent().toBytes()))).toBe(false);
  });

  it('a peer still decrypts after the key rotates, under the same ref', async () => {
    // A membership change rotates the document key. The receiver has already
    // remembered a key for this ref from the previous epoch; it must not get
    // stuck on it.
    const { a, b, docId } = await run((agentId) => presenceContentRef(agentId, 'viewing'));
    const c = await peer();
    await a.kh.receiveContactCard(ContactCard.fromBytes((await c.kh.contactCard()).toBytes()));
    await a.kh.addMember(c.id, MemberedId.document(docId), Power.edit());
    const enc = await a.kh.tryEncrypt(docId, new ChangeId(await presenceContentRef(a.agentId, 'viewing')), [], sealPresenceValue('after'));
    expect(enc.updateOp()).toBeDefined(); // it really was a new epoch
    await sync(a, b);
    const out = await b.kh.tryDecrypt(docId, Encrypted.fromBytes(enc.encryptedContent().toBytes()));
    expect(openPresenceValue(out)).toBe('after');
  });
});

describe('presenceEpochOf (when a peer needs new key material)', () => {
  // After sending presence the engine pushes a keyhive sync if the ciphertext
  // was written under a key the peers may not have yet — otherwise they sit on
  // undecryptable bytes until keyhive's own 1 s debounce fires. It used to read
  // `updateOp()` for that, which under-reports: a member's first encrypt starts
  // a new epoch and leaves updateOp() unset. The key the ciphertext itself
  // names is the signal that cannot be wrong.
  const send = async (p: any, docId: any, text: string) =>
    p.kh.tryEncrypt(docId, new ChangeId(await presenceContentRef(p.agentId, 'viewing')), [], sealPresenceValue(text));

  it('changes on a member\'s first encrypt, which updateOp() does not report', async () => {
    const { a, b, docId } = await sharedDoc();
    const fromA = await send(a, docId, 'a');
    await sync(a, b);
    await b.kh.tryDecrypt(docId, Encrypted.fromBytes(fromA.encryptedContent().toBytes()));

    const fromB = await send(b, docId, 'b first');
    expect(presenceEpochOf(fromB)).not.toBe(presenceEpochOf(fromA));
    // The peer really cannot read it until the op behind that key arrives…
    await expect(a.kh.tryDecrypt(docId, Encrypted.fromBytes(fromB.encryptedContent().toBytes()))).rejects.toThrow('Key not found');
    // …and updateOp() says nothing happened. If this starts failing, keyhive
    // reports it again and either signal would do.
    expect(fromB.updateOp()).toBeUndefined();
  });

  it('is unchanged for later messages in the same epoch', async () => {
    const { a, b, docId } = await sharedDoc();
    const first = await send(a, docId, 'one');
    const second = await send(a, docId, 'two');
    expect(presenceEpochOf(second)).toBe(presenceEpochOf(first));
    await sync(a, b);
    expect(openPresenceValue(await b.kh.tryDecrypt(docId, Encrypted.fromBytes(second.encryptedContent().toBytes())))).toBe('two');
  });
});

describe('flushPresenceOutbox (what gets encrypted, and when)', () => {
  // One side of a conversation: its outbox, the keyhive it encrypts with, and
  // a record of what it encrypted and what it put on the wire.
  async function sender(p: any, docId: any) {
    const outbox = newPresenceOutbox();
    const encrypted: string[] = [];
    const wire = new Map<string, Uint8Array>(); // channel -> the peer's current copy
    const io = {
      encrypt: async (channel: string, value: unknown): Promise<PresenceCiphertext | null> => {
        encrypted.push(channel);
        const r = await p.kh.tryEncrypt(docId, new ChangeId(await presenceContentRef(p.agentId, channel)), [], sealPresenceValue(value));
        return { enc: r.encryptedContent().toBytes(), epoch: presenceEpochOf(r) };
      },
      broadcast: (channel: string, enc: Uint8Array) => { wire.set(channel, enc); },
      currentEpoch: async () => {
        const hash: Uint8Array | undefined = await p.kh.tryPcsKeyHash(docId);
        return hash ? Buffer.from(hash).toString('base64') : null;
      },
    };
    const flush = (desired: Record<string, unknown>, opts?: { resend?: boolean }) => flushPresenceOutbox(outbox, desired, io, opts);
    return { outbox, encrypted, wire, flush };
  }
  const read = async (p: any, docId: any, wire: Map<string, Uint8Array>) => {
    const out: Record<string, unknown> = {};
    for (const [ch, enc] of wire) {
      try { out[ch] = openPresenceValue(await p.kh.tryDecrypt(docId, Encrypted.fromBytes(enc))); }
      catch (e: any) { out[ch] = `<${e.message}>`; }
    }
    return out;
  };
  const STATE = { viewing: true, focusedField: null, userGroupId: 'g' };

  it('re-sending an unchanged state encrypts nothing: the same bytes go out again', async () => {
    const { a, docId } = await sharedDoc();
    const s = await sender(a, docId);
    await s.flush(STATE);
    const first = new Map(s.wire);
    s.encrypted.length = 0;

    const result = await s.flush(STATE);

    expect(s.encrypted).toEqual([]);
    expect(result).toEqual({ allOk: true, newEpoch: false });
    for (const [ch, enc] of first) expect(Buffer.from(s.wire.get(ch)!).equals(Buffer.from(enc))).toBe(true);
  });

  it('encrypts only the channel whose value changed', async () => {
    const { a, docId } = await sharedDoc();
    const s = await sender(a, docId);
    await s.flush(STATE);
    s.encrypted.length = 0;
    await s.flush({ ...STATE, focusedField: ['content', 3] });
    expect(s.encrypted).toEqual(['focusedField']);
  });

  it('with resend off, an unchanged state puts nothing on the wire at all', async () => {
    const { a, docId } = await sharedDoc();
    const s = await sender(a, docId);
    await s.flush(STATE);
    s.wire.clear();
    await s.flush(STATE, { resend: false });
    expect(s.wire.size).toBe(0);
  });

  it('retries a channel whose encrypt failed, and reports the failure meanwhile', async () => {
    const outbox = newPresenceOutbox();
    let fail = true;
    const sent: string[] = [];
    const io = {
      encrypt: async (channel: string) => (fail && channel === 'viewing' ? null : { enc: Uint8Array.of(1), epoch: 'e' }),
      broadcast: (channel: string) => { sent.push(channel); },
    };
    expect((await flushPresenceOutbox(outbox, { viewing: true, focusedField: null }, io)).allOk).toBe(false);
    expect(sent).toEqual(['focusedField']);
    fail = false;
    sent.length = 0;
    expect((await flushPresenceOutbox(outbox, { viewing: true, focusedField: null }, io, { resend: false })).allOk).toBe(true);
    expect(sent).toEqual(['viewing']); // only the one that was missing
  });

  it('moves every channel to a new key epoch, once, when one of them starts it', async () => {
    // Otherwise a channel that never changes ("viewing") would stay readable
    // under a key the document has since rotated away from.
    const { a, b, docId } = await sharedDoc();
    const s = await sender(a, docId);
    await s.flush(STATE);
    await sync(a, b);
    const c = await peer();
    await a.kh.receiveContactCard(ContactCard.fromBytes((await c.kh.contactCard()).toBytes()));
    await a.kh.addMember(c.id, MemberedId.document(docId), Power.edit()); // the next encrypt rotates
    s.encrypted.length = 0;

    const result = await s.flush({ ...STATE, focusedField: ['content', 1] });

    expect(result.newEpoch).toBe(true);
    expect([...s.encrypted].sort()).toEqual(['focusedField', 'userGroupId', 'viewing']);
    const epochs = new Set([...s.outbox.sent.values()].map((e) => e.epoch));
    expect(epochs.size).toBe(1);
    await sync(a, b);
    expect(await read(b, docId, s.wire)).toEqual({ ...STATE, focusedField: ['content', 1] });
  });

  // The failure this design exists to prevent. Two peers open a freshly shared
  // document at the same moment: each encrypts before it has the other's key
  // operation, so each starts its own epoch. Under keyhive >= 0.6 EVERY
  // concurrent encrypt does that. The old recovery — re-encrypt and re-send
  // whenever the peer cannot be read — therefore replaced each ciphertext with
  // one from a newer epoch before the key for the last had arrived, on both
  // sides, in step, forever: presence never appeared.
  it('two peers that keep re-sending in step still read each other: concurrent epochs are only late, not lost', async () => {
    const { a, b, docId } = await sharedDoc();
    const sa = await sender(a, docId), sb = await sender(b, docId);

    // Round 1: both send before either has synced the other's op.
    await sa.flush(STATE);
    await sb.flush({ ...STATE, userGroupId: 'h' });
    expect(Object.values(await read(b, docId, sa.wire))).toEqual(['<Key not found>', '<Key not found>', '<Key not found>']);
    expect(Object.values(await read(a, docId, sb.wire))).toEqual(['<Key not found>', '<Key not found>', '<Key not found>']);

    // The lockstep retries: both re-send, repeatedly, still without syncing.
    const epochsBefore = [sa.outbox.epoch, sb.outbox.epoch];
    sa.encrypted.length = 0; sb.encrypted.length = 0;
    for (let round = 0; round < 5; round++) {
      await sa.flush(STATE);
      await sb.flush({ ...STATE, userGroupId: 'h' });
    }
    expect(sa.encrypted).toEqual([]);
    expect(sb.encrypted).toEqual([]);
    expect([sa.outbox.epoch, sb.outbox.epoch]).toEqual(epochsBefore);

    // Key material arrives; the SAME bytes each side already holds now decrypt.
    await sync(a, b);
    expect(await read(b, docId, sa.wire)).toEqual(STATE);
    expect(await read(a, docId, sb.wire)).toEqual({ ...STATE, userGroupId: 'h' });

    // And having merged two concurrent epochs, neither side has a key it could
    // encrypt under without rotating again — so a re-send still encrypts nothing.
    await sa.flush(STATE);
    await sb.flush({ ...STATE, userGroupId: 'h' });
    expect(sa.encrypted).toEqual([]);
    expect(sb.encrypted).toEqual([]);
  });

  // The other half of "never re-encrypt to help": sometimes the bytes on the
  // wire really are no use to a peer. A device that restarts can lose the
  // secret for the latest epoch; it recovers by rotating on its next encrypt,
  // and from then on can read only that new epoch and later. What everyone
  // else has out is under the old one. They can tell: keyhive now names a
  // current key that is not the one they encrypted under — and, unlike after a
  // merge, it is one they can use without rotating.
  it('moves to an epoch a peer started alone, without starting another', async () => {
    const { a, b, docId } = await sharedDoc();
    const sa = await sender(a, docId);
    await sa.flush(STATE);
    await sync(a, b);
    // b rotates by itself (here: its first encrypt; in the app: healing after a restart).
    const sb = await sender(b, docId);
    await sb.flush({ ...STATE, userGroupId: 'h' });
    await sync(a, b);
    expect(sb.outbox.epoch).not.toBe(sa.outbox.epoch);
    sa.encrypted.length = 0;
    const opsBefore = (await a.kh.stats()).cgkaOperations;

    const result = await sa.flush(STATE);

    expect([...sa.encrypted].sort()).toEqual(['focusedField', 'userGroupId', 'viewing']);
    expect(sa.outbox.epoch).toBe(sb.outbox.epoch);            // joined b's epoch…
    expect((await a.kh.stats()).cgkaOperations).toBe(opsBefore); // …rather than minting one
    expect(result.allOk).toBe(true);
    expect(await read(b, docId, sa.wire)).toEqual(STATE);
    // Settled: nothing more to do on the next re-send.
    sa.encrypted.length = 0;
    await sa.flush(STATE);
    expect(sa.encrypted).toEqual([]);
  });

  it('contrast: re-encrypting on every round keeps both peers one epoch behind', async () => {
    const { a, b, docId } = await sharedDoc();
    const always = async (p: any) => {
      const r = await p.kh.tryEncrypt(docId, new ChangeId(await presenceContentRef(p.agentId, 'viewing')), [], sealPresenceValue(true));
      return { bytes: r.encryptedContent().toBytes() as Uint8Array, epoch: presenceEpochOf(r) };
    };
    const canRead = async (p: any, c: { bytes: Uint8Array }) =>
      p.kh.tryDecrypt(docId, Encrypted.fromBytes(c.bytes)).then(() => true, () => false);
    const epochs = new Set<string>();
    for (let round = 0; round < 4; round++) {
      // Both re-encrypt at once; each reads what just arrived; THEN keys sync.
      const fromA = await always(a), fromB = await always(b);
      epochs.add(fromA.epoch); epochs.add(fromB.epoch);
      expect(await canRead(b, fromA)).toBe(false);
      expect(await canRead(a, fromB)).toBe(false);
      await sync(a, b);
    }
    expect(epochs.size).toBe(8); // a new epoch from each side, every round
  });
});
