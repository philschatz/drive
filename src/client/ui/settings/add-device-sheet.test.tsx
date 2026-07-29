/**
 * AddDeviceSheet: the settings-sync question, and the ordering it guards.
 *
 * This used to be a blocking `window.confirm` whose return value the await-chain
 * depended on. Turning it into a state machine is exactly the change that could
 * silently let the rendezvous stage *before* `enableSettingsSync()` resolves — which
 * would hand the new device a settings-doc pointer that doesn't exist yet. Nothing
 * else in the suite covers it (device-link.spec drives the worker API directly and
 * never opens this sheet), so the ordering is asserted here.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockMode: 'local' | 'shared';
let mockEnableSettingsSync: jest.Mock;
/** Records the call order of enableSettingsSync vs the rendezvous staging. */
let calls: string[];

jest.mock('../worker-api', () => ({
  getSettingsMode: () => Promise.resolve({ mode: mockMode }),
  enableSettingsSync: (...args: any[]) => mockEnableSettingsSync(...args),
}));

jest.mock('../common/keyhive-api', () => ({
  rendezvousCreateDeviceLink: jest.fn(),
  getIdentity: () => Promise.resolve({ agentId: 'me-agent' }),
}));

jest.mock('../common/automerge', () => ({
  keyhiveReady: Promise.resolve(),
  whenWsConnected: () => Promise.resolve(),
}));

jest.mock('../device-names', () => ({ resolveDeviceName: () => 'This laptop' }));

// The real one talks to the worker; a stub keeps its mount observable, which is
// what "the rendezvous was staged" means here.
jest.mock('./RendezvousShare', () => ({
  RendezvousShare: () => {
    calls.push('stage-rendezvous');
    return <div data-testid="rendezvous-share" />;
  },
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

import { AddDeviceSheet } from './AddDeviceSheet';

beforeEach(() => {
  mockMode = 'local';
  calls = [];
  mockEnableSettingsSync = jest.fn(() => {
    calls.push('enable-sync');
    return Promise.resolve();
  });
});

const open = () => render(<AddDeviceSheet open onOpenChange={() => {}} />);

it('asks before staging when settings are still device-local', async () => {
  open();
  expect(await screen.findByTestId('link-sync-choice')).toBeDefined();
  // Nothing has been staged while the question is unanswered.
  expect(screen.queryByTestId('rendezvous-share')).toBeNull();
  expect(mockEnableSettingsSync).not.toHaveBeenCalled();
});

it('enables sync BEFORE staging the rendezvous', async () => {
  open();
  fireEvent.click(await screen.findByTestId('link-sync-yes'));

  await screen.findByTestId('rendezvous-share');
  expect(mockEnableSettingsSync).toHaveBeenCalled();
  // The load-bearing assertion: the pointer exists before the peer can join.
  expect(calls).toEqual(['enable-sync', 'stage-rendezvous']);
});

it('stages without enabling sync when the user declines', async () => {
  open();
  fireEvent.click(await screen.findByTestId('link-sync-no'));

  await screen.findByTestId('rendezvous-share');
  expect(mockEnableSettingsSync).not.toHaveBeenCalled();
  expect(calls).toEqual(['stage-rendezvous']);
});

it('skips the question entirely when settings are already shared', async () => {
  mockMode = 'shared';
  open();

  await screen.findByTestId('rendezvous-share');
  expect(screen.queryByTestId('link-sync-choice')).toBeNull();
  expect(mockEnableSettingsSync).not.toHaveBeenCalled();
});

it('returns to the question and never stages when enabling sync fails', async () => {
  mockEnableSettingsSync = jest.fn(() => Promise.reject(new Error('worker down')));
  open();
  fireEvent.click(await screen.findByTestId('link-sync-yes'));

  await waitFor(() => expect(screen.getByTestId('add-device-error').textContent).toContain('worker down'));
  // Re-askable, and nothing was staged on a half-done sync.
  expect(screen.getByTestId('link-sync-choice')).toBeDefined();
  expect(screen.queryByTestId('rendezvous-share')).toBeNull();
  expect(calls).toEqual([]);
});
