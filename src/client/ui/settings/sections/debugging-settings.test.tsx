/**
 * DebuggingSettings: the connection status rows, the peer list, and the debug switch.
 *
 * The switch is the interesting one. `md-switch` flips its own `selected` on
 * activation, so if the surrounding state can't change (as it couldn't — the old
 * `useState` had no setter) a FAILED toggle leaves the thumb in the new position
 * while the setting is unchanged, with the error snackbar contradicting the visible
 * control. The optimistic-then-roll-back behaviour is asserted here because it is
 * the one thing on this page no amount of looking at it would catch.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockWsConnected: boolean;
let mockPeers: string[];
let mockTransports: Record<string, 'direct' | 'relay'>;
let mockWorkerError: string | null;
let mockSetDebugEnabled: jest.Mock;
let mockClearAllCaches: jest.Mock;
let mockDebugEnabled: boolean;
let mockNames: Record<string, string>;
let mockShowError: jest.Mock;

jest.mock('../../worker-api', () => ({
  useWsStatus: () => mockWsConnected,
  useConnectionStatus: () => mockPeers.length > 0,
  usePeerList: () => mockPeers,
  usePeerTransports: () => mockTransports,
  getWorkerPeerId: () => 'myagent-drive',
  getWorkerUserGroupId: () => 'my-user-group',
  getWorkerError: () => mockWorkerError,
  onWorkerError: () => () => {},
  onDeviceNamesUpdated: () => () => {},
  setDebugEnabled: (...args: any[]) => mockSetDebugEnabled(...args),
  clearAllCaches: (...args: any[]) => mockClearAllCaches(...args),
}));

jest.mock('../../common/presence', () => ({ peerIdentityKey: (peerId: string) => peerId }));

jest.mock('../../common/PeerDot', () => ({
  PeerDot: ({ identityKey }: any) => <span data-testid="peer-dot" data-identity={identityKey} />,
}));

jest.mock('../../device-names', () => ({
  getDeviceName: (id: string) => mockNames[id],
  setDeviceName: jest.fn(() => Promise.resolve()),
  // The real one falls back to generateDefaultDeviceName() — i.e. THIS browser.
  resolveDeviceName: (id: string) => mockNames[id] ?? 'This browser',
}));

jest.mock('../../../shared/idb-storage', () => ({ isDebugEnabled: () => mockDebugEnabled }));

jest.mock('@/components/ui/toast', () => ({
  showToast: jest.fn(),
  showError: (...args: any[]) => mockShowError(...args),
}));

jest.mock('@/components/ui/alert', () => ({
  Alert: ({ children }: any) => <div role="alert">{children}</div>,
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

import { DebuggingSettings } from './DebuggingSettings';

beforeEach(() => {
  mockWsConnected = true;
  mockPeers = [];
  mockTransports = {};
  mockWorkerError = null;
  mockDebugEnabled = false;
  mockNames = {};
  mockSetDebugEnabled = jest.fn(() => Promise.resolve());
  mockClearAllCaches = jest.fn(() => Promise.resolve());
  mockShowError = jest.fn();
});

describe('connection status', () => {
  it('reports an open relay socket without error tone', () => {
    render(<DebuggingSettings />);
    const row = screen.getByTestId('relay-status');
    expect(row.getAttribute('data-open')).toBe('true');
    expect(row.textContent).toContain('Open');
    expect([...row.children].some(el => (el as HTMLElement).style.color)).toBe(false);
  });

  it('error-tones a closed relay socket', () => {
    mockWsConnected = false;
    render(<DebuggingSettings />);
    const row = screen.getByTestId('relay-status');
    expect(row.getAttribute('data-open')).toBe('false');
    expect(row.textContent).toContain('Closed');
    expect([...row.children].filter(el =>
      (el as HTMLElement).style.color === 'var(--md-sys-color-error)')).toHaveLength(2);
  });

  it('keeps a worker crash inline as a banner, never a snackbar', () => {
    mockWorkerError = 'wasm trap in beekem';
    render(<DebuggingSettings />);
    expect(screen.getByRole('alert').textContent).toContain('wasm trap in beekem');
    expect(mockShowError).not.toHaveBeenCalled();
  });
});

describe('peer list', () => {
  it('names each peer and its transport', () => {
    mockPeers = ['peerA-drive', 'peerB-drive'];
    mockTransports = { 'peerA-drive': 'direct' };
    mockNames = { peerA: 'Phone B' };
    render(<DebuggingSettings />);

    const rows = screen.getAllByTestId('peer-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Phone B');
    expect(rows[0].textContent).toContain('direct (P2P)');
    expect(rows[1].textContent).toContain('via relay');
  });

  it('does not label an unnamed peer with THIS browser\'s generated name', () => {
    mockPeers = ['peerB-drive'];
    render(<DebuggingSettings />);
    // resolveDeviceName would have said "This browser" — that would be a lie.
    expect(screen.getByTestId('peer-row').textContent).not.toContain('This browser');
    expect(screen.getByTestId('peer-row').textContent).toContain('peerB…');
  });

  it('says so when there are no peers', () => {
    render(<DebuggingSettings />);
    expect(screen.getByTestId('no-peers').textContent).toContain('No peers');
  });
});

describe('debug switch', () => {
  const selected = () => screen.getByTestId('debug-toggle').getAttribute('data-selected');

  it('flips optimistically and persists', async () => {
    render(<DebuggingSettings />);
    expect(selected()).toBe('false');

    fireEvent.click(screen.getByTestId('debug-toggle'));
    // Optimistic: the row shows the new position without waiting for the worker.
    expect(selected()).toBe('true');
    await waitFor(() => expect(mockSetDebugEnabled).toHaveBeenCalledWith(true));
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it('rolls the thumb back when persisting fails', async () => {
    mockSetDebugEnabled = jest.fn(() => Promise.reject(new Error('worker gone')));
    render(<DebuggingSettings />);

    fireEvent.click(screen.getByTestId('debug-toggle'));
    expect(selected()).toBe('true');

    // Otherwise the thumb would sit "on" while debugging is still off.
    await waitFor(() => expect(selected()).toBe('false'));
    expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('worker gone'));
  });

  it('ignores a second tap while the first is in flight', async () => {
    let resolve!: () => void;
    mockSetDebugEnabled = jest.fn(() => new Promise<void>(r => { resolve = () => r(); }));
    render(<DebuggingSettings />);

    fireEvent.click(screen.getByTestId('debug-toggle'));
    fireEvent.click(screen.getByTestId('debug-toggle'));
    expect(mockSetDebugEnabled).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(selected()).toBe('true'));
  });

  it('seeds from the persisted value', () => {
    mockDebugEnabled = true;
    render(<DebuggingSettings />);
    expect(selected()).toBe('true');
  });
});

it('clears caches with no confirmation — nothing is lost', async () => {
  render(<DebuggingSettings />);
  fireEvent.click(screen.getByTestId('clear-caches'));
  await waitFor(() => expect(mockClearAllCaches).toHaveBeenCalled());
  expect(screen.queryByTestId('confirm-accept')).toBeNull();
});
