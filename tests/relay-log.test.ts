// The relay's logging had no test, and it used to carry its own env var
// (RELAY_QUIET) that both jest.config.js and playwright.config.ts set. That flag
// is gone: LOG_LEVEL=error now does the same job. These tests pin the properties
// the flag used to guarantee, so its removal can't quietly regress.
import { Encoder } from 'cbor-x';
import * as Automerge from '@automerge/automerge';
import { initKeyhiveWasm } from '@automerge/automerge-repo-keyhive';
import { Keyhive, Signer, CiphertextStore } from '@keyhive/keyhive/slim';
import { logMessage, shortId, extractSignedPayload } from '../src/relay/describe-message';
import { resetLogging, setLogLevel, setLogSink, type EmitLevel } from '../src/shared/logger';

const cbor = new Encoder({ tagUint8Array: false, useRecords: false });

function capture(): { level: EmitLevel; tag: string; args: unknown[] }[] {
  const out: { level: EmitLevel; tag: string; args: unknown[] }[] = [];
  setLogSink((level, tag, args) => { out.push({ level, tag, args }); });
  return out;
}

const JOIN = {
  type: 'join', senderId: 'abcdefghijkl-drive', targetId: 'zyxwvutsrqpo-drive',
  supportedProtocolVersions: ['1'],
};

afterEach(() => { resetLogging(); });

describe('relay message logging', () => {
  it('emits nothing at error level — what RELAY_QUIET=1 used to buy', () => {
    const records = capture();
    setLogLevel('error'); // jest.config.js + playwright.config.ts
    logMessage('←', 'abcdefghijkl-drive', JOIN);
    expect(records).toEqual([]);
  });

  it('emits nothing at info either: the firehose is debug-only', () => {
    const records = capture();
    setLogLevel('info');
    logMessage('←', 'abcdefghijkl-drive', JOIN);
    expect(records).toEqual([]);
  });

  it('emits one tagged debug line at debug level', () => {
    const records = capture();
    setLogLevel('debug');
    logMessage('←', 'abcdefghijkl-drive', JOIN);
    expect(records).toHaveLength(1);
    expect(records[0].level).toBe('debug');
    expect(records[0].tag).toBe('[relay]');
    expect(String(records[0].args[0])).toContain('← abcdef…-drive join');
  });

  it('does not describe the message at all when the level would discard it', () => {
    // The formatter decodes CBOR and hashes payloads, so it must not run per
    // message just to have its output thrown away. A getter that throws proves
    // nothing touched the message. (This is what the old `if (RELAY_QUIET) return`
    // did; the level check has to come first for the same reason.)
    setLogLevel('error');
    const booby = {
      type: 'sync',
      get data(): never { throw new Error('formatter ran when it should not have'); },
    };
    expect(() => logMessage('←', 'abcdefghijkl-drive', booby)).not.toThrow();
  });

  it('survives a malformed frame at debug level', () => {
    // Frames come off the wire, so a peer can send a non-string id or a
    // non-array version list. Formatting a log line must never be what drops the
    // relay's message handler into its error backstop — see the matching
    // hardening test in src/relay/relay.test.ts.
    setLogLevel('debug');
    capture();
    expect(() => logMessage('←', { evil: true } as any, {
      type: 'sync', targetId: { evil: true }, supportedProtocolVersions: 5,
    })).not.toThrow();
  });
});

describe('shortId', () => {
  it('truncates the key but keeps the service suffix', () => {
    expect(shortId('abcdefghijkl-drive')).toBe('abcdef…-drive');
  });

  it('leaves a short un-suffixed id alone', () => {
    expect(shortId('alice')).toBe('alice');
  });

  it('tolerates a non-string id from a malformed frame', () => {
    expect(() => shortId({ evil: true } as any)).not.toThrow();
  });
});

describe('describing what a message carries', () => {
  // The relay reads keyhive's signed frame by hand (it deliberately does not
  // load the keyhive WASM), so these run REAL keyhive to produce the frames: a
  // format change upstream must fail here rather than silently turn the debug
  // log into hashes.
  initKeyhiveWasm();
  let kh: any;
  beforeAll(async () => {
    kh = await Keyhive.init(Signer.generateMemory(), CiphertextStore.newInMemory(), () => {});
  });
  const line = (records: { args: unknown[] }[]) => String(records[0].args[0]);

  it.each([0, 5, 247, 248, 300, 503, 504, 70_000])(
    'peels a %i-byte payload out of a keyhive signed frame',
    async (n) => {
      // The frame's length prefix is variable-width; these sizes sit on and
      // around every boundary a relayed keyhive message can realistically hit.
      const payload = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      const signed: Uint8Array = (await kh.trySign(payload)).toBytes();
      expect(Array.from(extractSignedPayload(signed)!)).toEqual(Array.from(payload));
    },
  );

  it('returns nothing for bytes that are not a signed frame', () => {
    expect(extractSignedPayload(new Uint8Array(200))).toBeUndefined();
    expect(extractSignedPayload(Uint8Array.of(0x4b, 0x48, 0x42))).toBeUndefined();
  });

  it('decodes a keyhive sync check from inside its signed envelope', async () => {
    const records = capture();
    setLogLevel('debug');
    const inner = cbor.encode({ senderTotal: 12, senderSyncpoint: 9, senderDigest: new Uint8Array(32) });
    const signed: Uint8Array = (await kh.trySign(inner)).toBytes();
    logMessage('→', 'abcdefghijkl-drive', {
      type: 'keyhive-sync-check', senderId: 'a-drive', targetId: 'b-drive',
      data: cbor.encode({ contactCard: new Uint8Array(), signed }),
    });
    expect(line(records)).toContain('check{senderTotal=12, senderSyncpoint=9');
    expect(line(records)).toContain('+(signer)');
  });

  it('describes a document sync message as what it is: an unencrypted Automerge message', () => {
    // The keyhive bridge signs only its own keyhive-* messages; document sync
    // goes through untouched. The log must not call it encrypted — it used to,
    // for a wire format the app stopped using.
    const records = capture();
    setLogLevel('debug');
    const [, syncMessage] = Automerge.generateSyncMessage(Automerge.from({ title: 'x' }), Automerge.initSyncState());
    logMessage('→', 'abcdefghijkl-drive', { type: 'sync', senderId: 'a-drive', targetId: 'b-drive', data: syncMessage });
    expect(line(records)).toMatch(/data=\[automerge sync, \d+ bytes, not encrypted\]/);
    expect(line(records)).not.toMatch(/\[encrypted/);
  });
});
