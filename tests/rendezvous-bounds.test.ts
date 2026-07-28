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
import { decryptString, encryptString } from '../src/shared/rendezvous-crypto';
import { RDV_MSG } from '../src/shared/rendezvous-protocol';

/** Engine with one live rendezvous session (no init() — handleRendezvousFrame
 *  only touches the session map and the crypto helpers, which are mocked). */
function makeEngine(onData: (pt: string) => void, emit: (m: any) => void = () => {}): DriveEngine {
  const engine = new DriveEngine({ emit } as any);
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

  it('reports the oversize instead of leaving the receiver to time out', () => {
    const events: any[] = [];
    const engine = makeEngine(jest.fn(), (m) => events.push(m));
    engine.handleRendezvousFrame({
      type: RDV_MSG,
      rendezvousId: 'rid',
      data: new Uint8Array(RDV_MAX_DATA_BYTES + 1),
    });
    // Without this the user waits out RDV_RECEIVE_TIMEOUT_MS and is told to check
    // the other device's QR — a diagnosis retrying can never fix.
    expect(events).toEqual([
      expect.objectContaining({ type: 'kh-rdv-event', status: 'error', message: expect.stringMatching(/limit/i) }),
    ]);
  });

  it('keeps the session alive after an oversized frame', () => {
    // Anyone who learns a topic id can push bytes at it, so a hostile oversize
    // frame must not become a way to cancel a legitimate exchange.
    const onData = jest.fn();
    const engine = makeEngine(onData);
    engine.handleRendezvousFrame({ type: RDV_MSG, rendezvousId: 'rid', data: new Uint8Array(RDV_MAX_DATA_BYTES + 1) });
    expect((engine as any).rdvSessions.has('rid')).toBe(true);
  });
});

describe('rdvSendPayload outbound bounds', () => {
  beforeEach(() => (encryptString as jest.Mock).mockClear());

  it('refuses to send a payload the peer would be forced to drop', async () => {
    const engine = makeEngine(jest.fn());
    (encryptString as jest.Mock).mockResolvedValueOnce(new Uint8Array(RDV_MAX_DATA_BYTES + 1));
    await expect((engine as any).rdvSendPayload('rid', 'k', 'x'))
      .rejects.toThrow(/too large to exchange/i);
  });

  it('sends a payload under the cap', async () => {
    const sent: any[] = [];
    const engine = makeEngine(jest.fn());
    (engine as any).host.network = { sendOverlayFrame: (f: any) => sent.push(f) };
    (encryptString as jest.Mock).mockResolvedValueOnce(new Uint8Array(1024));
    await (engine as any).rdvSendPayload('rid', 'k', 'x');
    expect(sent).toEqual([expect.objectContaining({ type: RDV_MSG, rendezvousId: 'rid' })]);
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
