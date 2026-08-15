// The relay's logging had no test, and it used to carry its own env var
// (RELAY_QUIET) that both jest.config.js and playwright.config.ts set. That flag
// is gone: LOG_LEVEL=error now does the same job. These tests pin the properties
// the flag used to guarantee, so its removal can't quietly regress.
import { logMessage, shortId } from '../src/relay/describe-message';
import { resetLogging, setLogLevel, setLogSink, type EmitLevel } from '../src/shared/logger';

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
