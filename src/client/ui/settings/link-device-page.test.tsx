/**
 * LinkDevicePage's gate.
 *
 * This is the more consequential of the two invite flows — joining runs
 * `linkDevice`, which converges both devices onto one user group and may adopt the
 * other device's settings doc — and it used to run itself from a mount effect, so
 * merely opening the link committed to it. Nothing may reach the worker before the
 * confirm button is tapped.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/preact';

let mockJoin: jest.Mock;
const mockListeners = new Set<(e: any) => void>();

jest.mock('../common/keyhive-api', () => ({
  rendezvousJoinDeviceLink: (...args: any[]) => mockJoin(...args),
  getIdentity: () => Promise.resolve({ agentId: 'my-agent', userGroupId: 'my-group' }),
  onRendezvousEvent: (fn: (e: any) => void) => { mockListeners.add(fn); return () => { mockListeners.delete(fn); }; },
}));

// The relay socket: open unless a test holds it shut.
let mockWsOpen: Promise<void> = Promise.resolve();
jest.mock('../common/automerge', () => ({
  keyhiveReady: Promise.resolve(),
  whenWsConnected: () => mockWsOpen,
}));

jest.mock('../device-names', () => ({
  resolveDeviceName: () => 'This Device',
}));

jest.mock('./RendezvousProgress', () => ({
  RendezvousProgress: () => <div data-testid="rendezvous-progress" />,
}));

import { LinkDevicePage } from './LinkDevicePage';

const TOKEN = 'r.abcdef123456.key123456';

beforeEach(() => {
  mockWsOpen = Promise.resolve();
  mockJoin = jest.fn(() => Promise.resolve({ ok: true }));
  window.location.hash = '#/link-device/start';
});

const startFlow = async () => fireEvent.click(await screen.findByTestId('link-device-confirm'));

it('does not touch the worker until the link is confirmed', async () => {
  render(<LinkDevicePage token={TOKEN} />);

  expect(await screen.findByTestId('link-device-gate')).toBeDefined();
  expect(mockJoin).not.toHaveBeenCalled();
  expect(screen.queryByTestId('rendezvous-progress')).toBeNull();
});

it('joins with this device\'s name once confirmed, then reports completion', async () => {
  render(<LinkDevicePage token={TOKEN} />);
  await startFlow();

  await waitFor(() => expect(mockJoin).toHaveBeenCalledWith('abcdef123456', 'key123456', 'This Device'));
  await waitFor(() => expect(screen.getByTestId('link-device-done')).toBeDefined());
  // One leg only — the old card-in-the-URL scheme needed a return QR here.
  expect(screen.queryByTestId('link-device-url')).toBeNull();
});

it('leaves for the device list without starting anything when cancelled', async () => {
  render(<LinkDevicePage token={TOKEN} />);

  fireEvent.click(await screen.findByTestId('link-device-cancel'));

  await waitFor(() => expect(window.location.hash).toBe('#/settings/devices'));
  expect(mockJoin).not.toHaveBeenCalled();
});

it('reports an unusable link instead of offering to start one', async () => {
  render(<LinkDevicePage token="not-a-rendezvous-token" />);

  await waitFor(() => expect(screen.getByTestId('link-device-error')).toBeDefined());
  expect(screen.queryByTestId('link-device-gate')).toBeNull();
  expect(screen.queryByTestId('link-device-retry')).toBeNull();
  expect(mockJoin).not.toHaveBeenCalled();
});

it('stays put and offers a retry when the handshake fails', async () => {
  mockJoin = jest.fn(() => Promise.reject(new Error('timed out waiting for your other device')));
  render(<LinkDevicePage token={TOKEN} />);
  await startFlow();

  await waitFor(() => expect(screen.getByTestId('link-device-error').textContent).toContain('timed out'));
  expect(screen.getByTestId('link-device-retry')).toBeDefined();
  expect(window.location.hash).toBe('#/link-device/start');
});

it('offers a way out even mid-handshake', async () => {
  mockJoin = jest.fn(() => new Promise(() => {}));
  render(<LinkDevicePage token={TOKEN} />);
  await startFlow();

  expect(screen.getByLabelText('Close').getAttribute('href')).toBe('#/settings/devices');
});

it('says the other device is asking, while that device decides', async () => {
  // The join stays open until the other device answers.
  let finish!: (v: { ok: true }) => void;
  mockJoin = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  render(<LinkDevicePage token={TOKEN} />);
  await startFlow();
  await waitFor(() => expect(mockJoin).toHaveBeenCalled());
  expect(screen.queryByTestId('link-device-asked')).toBeNull();

  act(() => { for (const fn of mockListeners) fn({ rendezvousId: 'abcdef123456', status: 'confirm' }); });
  expect((await screen.findByTestId('link-device-asked')).textContent).toContain('Confirm on your other device');
  // Nothing here to tap: the answer is given on the device that showed the link.
  expect(screen.queryByTestId('link-device-done')).toBeNull();

  // Another link's events are not this page's.
  act(() => { for (const fn of mockListeners) fn({ rendezvousId: 'someone-else', status: 'linked' }); });
  expect(screen.getByTestId('link-device-asked')).toBeDefined();

  await act(async () => {
    for (const fn of mockListeners) fn({ rendezvousId: 'abcdef123456', status: 'linked' });
    finish({ ok: true });
  });
  await waitFor(() => expect(screen.getByTestId('link-device-done')).toBeDefined());
  expect(screen.queryByTestId('link-device-asked')).toBeNull();
});

it('waits for the relay socket before joining: a tap on a page that is still starting is not lost', async () => {
  // This page is usually the first thing a new device opens, so the tap can land
  // before the socket is up — and a rendezvous subscribe sent then is dropped,
  // leaving both devices waiting for each other.
  let open!: () => void;
  mockWsOpen = new Promise((resolve) => { open = resolve; });
  render(<LinkDevicePage token={TOKEN} />);
  await startFlow();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(mockJoin).not.toHaveBeenCalled();

  await act(async () => { open(); });
  await waitFor(() => expect(mockJoin).toHaveBeenCalledWith('abcdef123456', 'key123456', 'This Device'));
});
