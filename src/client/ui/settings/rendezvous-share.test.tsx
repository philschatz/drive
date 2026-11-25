/**
 * RendezvousShare, the side that shows a link: a device link asks before it
 * links, and a link that was not used in time says so and offers another.
 *
 * The link is a secret anyone might end up holding, so the worker does not add
 * a device when one opens it — it reports who is asking and under which code
 * ('confirm'), and waits for `rendezvousConfirmDeviceLink`.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/preact';

const mockConfirm = jest.fn();
const mockCancel = jest.fn();
const mockListeners = new Set<(e: any) => void>();

jest.mock('../common/keyhive-api', () => ({
  rendezvousConfirmDeviceLink: (...args: any[]) => mockConfirm(...args),
  rendezvousCancel: (...args: any[]) => mockCancel(...args),
  onRendezvousEvent: (fn: (e: any) => void) => { mockListeners.add(fn); return () => { mockListeners.delete(fn); }; },
}));
jest.mock('./RendezvousProgress', () => ({
  RendezvousProgress: ({ phase }: { phase: string | null }) => <div data-testid="rendezvous-progress">{phase}</div>,
}));
jest.mock('@/components/ui/qr-code', () => ({
  QRCodeDisplay: ({ url }: { url: string }) => <div data-testid="qr">{url}</div>,
}));
jest.mock('@/components/ui/toast', () => ({ showToast: () => {} }));

import { RendezvousShare } from './RendezvousShare';

let staged = 0;
const create = jest.fn(async () => ({ rendezvousId: `rid-${++staged}`, key: 'key' }));
const emit = (event: Record<string, unknown>) => act(() => { for (const fn of [...mockListeners]) fn(event); });

function show() {
  return render(
    <RendezvousShare
      create={create}
      buildUrl={(rid, key) => `https://example.test/#/link-device/r.${rid}.${key}`}
      waitingLabel="Waiting…"
      doneLabel="Device linked."
    />,
  );
}

beforeEach(() => {
  staged = 0;
  create.mockClear();
  mockConfirm.mockClear();
  mockCancel.mockClear();
  mockListeners.clear();
});

it('shows the link, and nothing to confirm until a device asks', async () => {
  show();
  expect((await screen.findByTestId('rendezvous-url') as HTMLInputElement).value).toContain('r.rid-1.key');
  expect(screen.queryByTestId('link-confirm')).toBeNull();
});

it('asks about the device that opened the link, by name, and links it only on the tap', async () => {
  show();
  await screen.findByTestId('rendezvous-url');
  emit({ rendezvousId: 'rid-1', status: 'confirm', deviceName: 'Pixel' });

  expect((await screen.findByTestId('link-confirm-name')).textContent).toContain('Pixel');
  // The link has done its job: it is no longer on screen to be scanned again.
  expect(screen.queryByTestId('rendezvous-url')).toBeNull();
  expect(mockConfirm).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('link-confirm-accept'));
  expect(mockConfirm).toHaveBeenCalledWith('rid-1');
  expect(mockCancel).not.toHaveBeenCalled();
  expect(screen.queryByTestId('link-confirm')).toBeNull();
  emit({ rendezvousId: 'rid-1', status: 'linked' });
  expect(screen.getByTestId('rendezvous-progress').textContent).toBe('linked');
  expect(create).toHaveBeenCalledTimes(1);
});

it('"Not my device" turns it away and stages a fresh link', async () => {
  show();
  await screen.findByTestId('rendezvous-url');
  emit({ rendezvousId: 'rid-1', status: 'confirm' });
  expect((await screen.findByTestId('link-confirm')).textContent).toContain('Link this device to your account?');
  fireEvent.click(await screen.findByTestId('link-confirm-decline'));

  // Leaving the link is the no: cancelling the rendezvous tells the device that asked.
  expect(mockConfirm).not.toHaveBeenCalled();
  await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('rid-1'));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect((await screen.findByTestId('rendezvous-url') as HTMLInputElement).value).toContain('r.rid-2.key');
  // The old link's events no longer concern this view.
  emit({ rendezvousId: 'rid-1', status: 'confirm', deviceName: 'Late' });
  expect(screen.queryByTestId('link-confirm')).toBeNull();
});

it('a device that asked and then failed is not left on screen as a question', async () => {
  show();
  await screen.findByTestId('rendezvous-url');
  emit({ rendezvousId: 'rid-1', status: 'confirm' });
  await screen.findByTestId('link-confirm');
  emit({ rendezvousId: 'rid-1', status: 'error', message: 'It went away.' });
  expect(screen.queryByTestId('link-confirm')).toBeNull();
});

it('says when the link has expired, and offers a new one', async () => {
  show();
  await screen.findByTestId('rendezvous-url');
  emit({ rendezvousId: 'rid-1', status: 'expired' });

  expect(await screen.findByTestId('rendezvous-expired')).toBeDefined();
  expect(screen.queryByTestId('rendezvous-url')).toBeNull();
  fireEvent.click(screen.getByTestId('rendezvous-new-code'));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect((await screen.findByTestId('rendezvous-url') as HTMLInputElement).value).toContain('r.rid-2.key');
});
