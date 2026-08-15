/**
 * AddFriendPage's gate and outcome machine.
 *
 * Two things are pinned here. First, **the exchange starts on a tap**: opening the
 * link must not be the decision, because the moment we subscribe the sharer mints a
 * prekey and pushes its bundle, and there is no receiver-side veto after that.
 *
 * Second, the outcome machine. This page used to rely on `alert`/`prompt` *blocking*
 * before it assigned `location.hash`. Sheets don't block, so navigation became a
 * continuation driven by `outcome` — and the trap that creates is RenameSheet's
 * `onSave`, which fires `onRename` and THEN `onClose`. Without the settledRef guard a
 * single Save toasts twice and navigates twice.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockReceive: jest.Mock;
let mockSetFriendName: jest.Mock;
let mockShowToast: jest.Mock;

jest.mock('../common/keyhive-api', () => ({
  rendezvousReceive: (...args: any[]) => mockReceive(...args),
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

/** A valid rendezvous token — the only link form the app builds. */
const TOKEN = 'r.abcdef123456.key123456';

beforeEach(() => {
  mockSetFriendName = jest.fn(() => Promise.resolve());
  mockShowToast = jest.fn();
  // jsdom supports same-document hash navigation, so this is observable.
  window.location.hash = '#/add-friend/start';
});

/** Answer the gate — nothing reaches the worker before this. */
const startFlow = async () => fireEvent.click(await screen.findByTestId('add-friend-confirm'));

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

it('does not touch the worker until the exchange is confirmed', async () => {
  withName();
  render(<AddFriendPage token={TOKEN} />);

  // The gate is the whole page body — no progress, no exchange.
  expect(await screen.findByTestId('add-friend-gate')).toBeDefined();
  expect(mockReceive).not.toHaveBeenCalled();
  expect(screen.queryByTestId('rendezvous-progress')).toBeNull();

  await startFlow();
  await waitFor(() => expect(mockReceive).toHaveBeenCalledTimes(1));
});

it('leaves without starting anything when the gate is cancelled', async () => {
  withName();
  render(<AddFriendPage token={TOKEN} />);

  fireEvent.click(await screen.findByTestId('add-friend-cancel'));

  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  // The sharer never learns the link was opened.
  expect(mockReceive).not.toHaveBeenCalled();
});

it('reports an unusable link instead of offering to start one', async () => {
  withName();
  render(<AddFriendPage token="not-a-rendezvous-token" />);

  await waitFor(() => expect(screen.getByTestId('add-friend-error')).toBeDefined());
  expect(screen.queryByTestId('add-friend-gate')).toBeNull();
  // Retrying a link that can never parse would only fail again.
  expect(screen.queryByTestId('add-friend-retry')).toBeNull();
  expect(mockReceive).not.toHaveBeenCalled();
});

it('toasts and leaves immediately when the friend sent a name', async () => {
  withName();
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  expect(mockShowToast).toHaveBeenCalledWith('Alice was added.', expect.anything());
  // No name to ask for, so no sheet.
  expect(screen.queryByTestId('rename-input')).toBeNull();
});

it('asks for a name and does NOT navigate until answered', async () => {
  withoutName();
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  expect(await screen.findByTestId('rename-input')).toBeDefined();
  // The old code navigated on the same tick, unmounting the sheet mid-open.
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('saves the name, then navigates exactly ONCE', async () => {
  withoutName();
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

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
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  fireEvent.click(await screen.findByTestId('rename-cancel'));

  await waitFor(() => expect(window.location.hash).toBe('#/friends'));
  expect(mockSetFriendName).not.toHaveBeenCalled();
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});

it('keeps the user here when saving the name fails', async () => {
  withoutName();
  mockSetFriendName = jest.fn(() => Promise.reject(new Error('storage gone')));
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  fireEvent.input(await screen.findByTestId('rename-input'), { target: { value: 'Alice' } });
  fireEvent.click(screen.getByTestId('rename-save'));

  // Better than bouncing them to #/friends with nothing shown.
  await waitFor(() => expect(screen.getByTestId('add-friend-error').textContent).toContain('storage gone'));
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('stays put and offers a retry when the exchange itself fails', async () => {
  mockReceive = jest.fn(() => Promise.reject(new Error('relay unreachable')));
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  await waitFor(() => expect(screen.getByTestId('add-friend-error').textContent).toContain('relay unreachable'));
  // A real channel that failed CAN succeed on a second try, unlike a malformed link.
  expect(screen.getByTestId('add-friend-retry')).toBeDefined();
  expect(window.location.hash).toBe('#/add-friend/start');
});

it('offers a way out even mid-handshake', async () => {
  // Never resolves: the handshake is still in flight.
  mockReceive = jest.fn(() => new Promise(() => {}));
  render(<AddFriendPage token={TOKEN} />);
  await startFlow();

  // There used to be no exit at all until the flow finished.
  expect(screen.getByLabelText('Close').getAttribute('href')).toBe('#/friends');
});
