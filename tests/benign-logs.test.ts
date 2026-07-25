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

  it('lets a genuine warning through', () => {
    expect(isBenignLogLine(['something actually went wrong'])).toBe(false);
    expect(isBenignLogLine(['[engine] presence decrypt failed', new Error('nope')])).toBe(false);
  });
});
