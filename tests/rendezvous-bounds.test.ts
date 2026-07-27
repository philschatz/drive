/**
 * Inbound rendezvous payload bounds.
 *
 * The rendezvous channel is reachable by anyone who learns (or brute-forces
 * traffic onto) a topic id — the relay forwards `data` opaquely. An RDV_MSG
 * larger than RDV_MAX_DATA_BYTES must be dropped BEFORE any decrypt work, so a
 * hostile relay/topic peer can't force large AES-GCM + JSON parsing allocations.
 * Legitimate payloads (contact bundles ~25 KB) stay far under the cap.
 */

jest.mock('../src/shared/rendezvous-crypto', () => ({
  generateRendezvous: jest.fn(() => ({ rendezvousId: 'rid', key: 'k' })),
  encryptString: jest.fn(async () => new Uint8Array(0)),
  decryptString: jest.fn(async () => 'plaintext'),
}));

import { DriveEngine, RDV_MAX_DATA_BYTES } from '../src/shared/drive-engine';
import { decryptString } from '../src/shared/rendezvous-crypto';
import { RDV_MSG } from '../src/shared/rendezvous-protocol';

/** Engine with one live rendezvous session (no init() — handleRendezvousFrame
 *  only touches the session map and the crypto helpers, which are mocked). */
function makeEngine(onData: (pt: string) => void): DriveEngine {
  const engine = new DriveEngine({ emit: () => {} } as any);
  (engine as any).rdvSessions.set('rid', { key: 'k', onData });
  return engine;
}

describe('handleRendezvousFrame payload bounds', () => {
  beforeEach(() => (decryptString as jest.Mock).mockClear());

  it('drops an oversized RDV_MSG before decrypting', () => {
    const onData = jest.fn();
    const engine = makeEngine(onData);
    engine.handleRendezvousFrame({
      type: RDV_MSG,
      rendezvousId: 'rid',
      data: new Uint8Array(RDV_MAX_DATA_BYTES + 1),
    });
    expect(decryptString).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
  });

  it('still decrypts and delivers a payload under the cap', async () => {
    const onData = jest.fn();
    const engine = makeEngine(onData);
    engine.handleRendezvousFrame({
      type: RDV_MSG,
      rendezvousId: 'rid',
      data: new Uint8Array(1024),
    });
    await new Promise((r) => setTimeout(r, 0)); // let the decrypt promise chain settle
    expect(decryptString).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('plaintext');
  });
});
