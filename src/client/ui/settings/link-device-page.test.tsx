/**
 * LinkDevicePage's gate.
 *
 * This is the more consequential of the two invite flows — joining runs
 * `linkDevice`, which converges both devices onto one user group and may adopt the
 * other device's settings doc — and it used to run itself from a mount effect, so
 * merely opening the link committed to it. Nothing may reach the worker before the
 * confirm button is tapped.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockJoin: jest.Mock;

jest.mock('../common/keyhive-api', () => ({
  rendezvousJoinDeviceLink: (...args: any[]) => mockJoin(...args),
  getIdentity: () => Promise.resolve({ agentId: 'my-agent', userGroupId: 'my-group' }),
  onRendezvousEvent: () => () => {},
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
