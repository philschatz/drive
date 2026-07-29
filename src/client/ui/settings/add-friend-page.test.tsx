/**
 * AddFriendPage's outcome machine.
 *
 * This page used to rely on `alert`/`prompt` *blocking* before it assigned
 * `location.hash`. Sheets don't block, so navigation became a continuation driven by
 * `outcome` — and the trap that creates is RenameSheet's `onSave`, which fires
 * `onRename` and THEN `onClose`. Without the settledRef guard a single Save toasts
 * twice and navigates twice. That is the case this file exists for.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockReceive: jest.Mock;
let mockSetFriendName: jest.Mock;
let mockShowToast: jest.Mock;

jest.mock('../common/keyhive-api', () => ({
  rendezvousReceive: (...args: any[]) => mockReceive(...args),
  receiveContactCard: jest.fn(),
  getIdentity: () => Promise.resolve({ deviceId: 'd', userGroupId: 'my-group' }),
  onRendezvousEvent: () => () => {},
}));

jest.mock('../common/automerge', () => ({
  keyhiveReady: Promise.resolve(),
  whenWsConnected: () => Promise.resolve(),
}));

jest.mock('../friend-names', () => ({
  getFriendName: () => undefined,
  setFriendName: (...args: any[]) => mockSetFriendName(...args),
}));

jest.mock('@/components/ui/toast', () => ({
  showToast: (...args: any[]) => mockShowToast(...args),
  showError: jest.fn(),
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('./RendezvousProgress', () => ({
  RendezvousProgress: () => <div data-testid="rendezvous-progress" />,
}));

import { AddFriendPage } from './AddFriendPage';

/** A valid rendezvous token, so the page takes the preferred receive path. */
const CARD = 'r.abcdef123456.key123456';

beforeEach(() => {
  mockSetFriendName = jest.fn(() => Promise.resolve());
  mockShowToast = jest.fn();
  // jsdom supports same-document hash navigation, so this is observable.
  window.location.hash = '#/add-friend/start';
});

/** The friend sent a name — nothing to ask. */
const withName = () => {
  mockReceive = jest.fn(() => Promise.resolve({
    isOwnCard: false, userGroupId: 'their-group', alreadyKnown: false, displayName: 'Alice',
  }));
};

/** The friend sent no name — we have to offer one. */
const withoutName = () => {
  mockReceive = jest.fn(() => Promise.resolve({
    isOwnCard: false, userGroupId: 'their-group', alreadyKnown: false, displayName: undefined,
  }));
};

it('toasts and leaves immediately when the friend sent a name', async () => {
  withName();
  render(<AddFriendPage cardData={CARD} />);

  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  expect(mockShowToast).toHaveBeenCalledWith('Alice was added.', expect.anything());
  // No name to ask for, so no sheet.
  expect(screen.queryByTestId('rename-input')).toBeNull();
});

it('asks for a name and does NOT navigate until answered', async () => {
  withoutName();
  render(<AddFriendPage cardData={CARD} />);

  expect(await screen.findByTestId('rename-input')).toBeDefined();
  // The old code navigated on the same tick, unmounting the sheet mid-open.
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('saves the name, then navigates exactly ONCE', async () => {
  withoutName();
  render(<AddFriendPage cardData={CARD} />);

  fireEvent.input(await screen.findByTestId('rename-input'), { target: { value: 'Alice' } });
  fireEvent.click(screen.getByTestId('rename-save'));

  await waitFor(() => expect(mockSetFriendName).toHaveBeenCalledWith('their-group', 'Alice'));
  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  // RenameSheet's onSave fires onRename AND THEN onClose — the guard is what keeps
  // that from being two toasts and two navigations.
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});

it('treats dismissing the name sheet as "do not name them"', async () => {
  withoutName();
  render(<AddFriendPage cardData={CARD} />);

  fireEvent.click(await screen.findByTestId('rename-cancel'));

  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  expect(mockSetFriendName).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});

it('keeps the user here when saving the name fails', async () => {
  withoutName();
  mockSetFriendName = jest.fn(() => Promise.reject(new Error('storage gone')));
  render(<AddFriendPage cardData={CARD} />);

  fireEvent.input(await screen.findByTestId('rename-input'), { target: { value: 'Alice' } });
  fireEvent.click(screen.getByTestId('rename-save'));

  // Better than bouncing them to #/friends with nothing shown.
  await waitFor(() => expect(screen.getByTestId('add-friend-error').textContent).toContain('storage gone'));
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('stays put and offers a retry when the exchange itself fails', async () => {
  mockReceive = jest.fn(() => Promise.reject(new Error('relay unreachable')));
  render(<AddFriendPage cardData={CARD} />);

  await waitFor(() => expect(screen.getByTestId('add-friend-error').textContent).toContain('relay unreachable'));
  expect(screen.getByTestId('add-friend-retry')).toBeDefined();
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('offers a way out even mid-handshake', async () => {
  // Never resolves: the handshake is still in flight.
  mockReceive = jest.fn(() => new Promise(() => {}));
  render(<AddFriendPage cardData={CARD} />);

  // There used to be no exit at all until the flow finished.
  expect(screen.getByLabelText('Close').getAttribute('href')).toBe('#/friends');
});
