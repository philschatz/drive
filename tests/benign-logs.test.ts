// Guards the exact library log lines the startup console filter suppresses
// (tests/support/setup-console.ts). These teardown-race warnings fire only
// intermittently, so this pins the patterns against their real strings instead
// of relying on catching them live.
import { isBenignLogLine } from './support/benign-logs';

describe('benign library log filter', () => {
  it('matches the automerge-repo shutdown-flush warning (prefix + message split across args)', () => {
    // Shape emitted by automerge-repo's Logger: console.warn(prefix, message, extra)
    expect(isBenignLogLine(['[automerge-repo:repo]', 'flush() during shutdown failed', { err: new Error('x') }])).toBe(true);
  });

  it('matches the SubductionSource storeBuiltBatch warning (single string arg)', () => {
    expect(isBenignLogLine(['[SubductionSource] storeBuiltBatch failed for abc123: boom'])).toBe(true);
  });

  it("matches jsdom's not-implemented navigation error (an Error, with NO string arg)", () => {
    // jsdom's virtual console calls console.error(error) — the text lives on the
    // Error's message, so a string-only join would never see it.
    const err = new Error('Not implemented: navigation (except hash changes)');
    expect(isBenignLogLine([err])).toBe(true);
  });

  it('matches a CROSS-REALM error, where instanceof Error is false', () => {
    // The real shape jsdom emits: constructed in jsdom's realm, so it fails
    // `instanceof Error` in ours and must be duck-typed on `message`. Verified
    // against a live window.location.reload() under jest-environment-jsdom.
    const crossRealm = { message: 'Not implemented: navigation (except hash changes)', type: 'not implemented' };
    expect(crossRealm instanceof Error).toBe(false);
    expect(isBenignLogLine([crossRealm])).toBe(true);
  });

  it('falls back to .stack when there is no .message', () => {
    expect(isBenignLogLine([{ stack: 'Error: Not implemented: navigation (except hash changes)\n  at x' }])).toBe(true);
  });

  it('lets a genuine warning through', () => {
    expect(isBenignLogLine(['something actually went wrong'])).toBe(false);
    expect(isBenignLogLine(['[engine] presence decrypt failed', new Error('nope')])).toBe(false);
  });

  it('lets a genuine Error through', () => {
    expect(isBenignLogLine([new Error('keyhive init failed')])).toBe(false);
  });
});
