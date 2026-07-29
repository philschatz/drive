/**
 * ProfileSettings: the name row and the identity copy rows.
 *
 * The regression worth pinning is that merely *rendering* this page never calls
 * `ensureUserGroup`. Saving a name creates one, and the old always-live input saved
 * on blur — so an accidental focus-and-blur could mint a user group from nothing.
 * A transactional RenameSheet has no blur path at all, which is what makes that
 * safe; this test is what keeps it safe.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockGetIdentity: jest.Mock;
let mockEnsureUserGroup: jest.Mock;
let mockSetFriendName: jest.Mock;
let mockNames: Record<string, string>;
let mockShowToast: jest.Mock;
let mockShowError: jest.Mock;
let mockWriteText: jest.Mock;

jest.mock('../../common/keyhive-api', () => ({
  getIdentity: (...args: any[]) => mockGetIdentity(...args),
  ensureUserGroup: (...args: any[]) => mockEnsureUserGroup(...args),
}));

jest.mock('../../friend-names', () => ({
  getFriendName: (id: string) => mockNames[id],
  setFriendName: (...args: any[]) => mockSetFriendName(...args),
}));

// idbGet reaches for IndexedDB, which jsdom doesn't have; null = settings are LOCAL.
jest.mock('../../../shared/idb-storage', () => ({
  idbGet: () => Promise.resolve(null),
  KEYS: { driveSettings: 'settings:drive-settings' },
}));

jest.mock('@/components/ui/toast', () => ({
  showToast: (...args: any[]) => mockShowToast(...args),
  showError: (...args: any[]) => mockShowError(...args),
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

// AddFriendSheet transitively imports common/automerge → worker-api (import.meta /
// new Worker), which the jsdom env can't load.
jest.mock('../AddFriendSheet', () => ({
  AddFriendSheet: ({ open }: any) => (open ? <div data-testid="add-friend-sheet" /> : null),
}));

import { ProfileSettings } from './ProfileSettings';

const IDENTITY = { deviceId: 'device-abcdefghijklmnop', userGroupId: 'group-abcdefghijklmnop' };

beforeEach(() => {
  mockNames = {};
  mockGetIdentity = jest.fn(() => Promise.resolve(IDENTITY));
  mockEnsureUserGroup = jest.fn(() => Promise.resolve({ userGroupId: IDENTITY.userGroupId }));
  mockSetFriendName = jest.fn(() => Promise.resolve());
  mockShowToast = jest.fn();
  mockShowError = jest.fn();
  mockWriteText = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mockWriteText },
    configurable: true,
  });
});

it('never creates a user group just from rendering', async () => {
  render(<ProfileSettings />);
  await screen.findByTestId('profile-user-group');
  expect(mockEnsureUserGroup).not.toHaveBeenCalled();
  expect(mockSetFriendName).not.toHaveBeenCalled();
});

it('saves the name through the rename sheet', async () => {
  render(<ProfileSettings />);
  fireEvent.click(await screen.findByTestId('profile-name'));

  fireEvent.input(screen.getByTestId('rename-input'), { target: { value: 'Phil' } });
  fireEvent.click(screen.getByTestId('rename-save'));

  await waitFor(() => expect(mockSetFriendName).toHaveBeenCalledWith(IDENTITY.userGroupId, 'Phil'));
  expect(mockEnsureUserGroup).toHaveBeenCalledWith({ create: true });
  expect(mockShowToast).toHaveBeenCalledWith('Name saved.');
});

it('reports a save failure as a snackbar', async () => {
  mockSetFriendName = jest.fn(() => Promise.reject(new Error('storage gone')));
  render(<ProfileSettings />);
  fireEvent.click(await screen.findByTestId('profile-name'));
  fireEvent.input(screen.getByTestId('rename-input'), { target: { value: 'Phil' } });
  fireEvent.click(screen.getByTestId('rename-save'));

  await waitFor(() => expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('storage gone')));
});

it('skips a save that would not change the stored name', async () => {
  mockNames = { [IDENTITY.userGroupId]: 'Phil' };
  render(<ProfileSettings />);
  fireEvent.click(await screen.findByTestId('profile-name'));
  fireEvent.click(screen.getByTestId('rename-save')); // untouched draft

  await waitFor(() => expect(screen.queryByTestId('rename-input')).toBeNull());
  expect(mockEnsureUserGroup).not.toHaveBeenCalled();
});

it('copies the FULL id, not the truncation it displays', async () => {
  render(<ProfileSettings />);
  fireEvent.click(await screen.findByTestId('profile-user-group'));

  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(IDENTITY.userGroupId));
  expect(mockShowToast).toHaveBeenCalledWith('User group ID copied');
});

it('renders an inert row when there is no user group yet', async () => {
  mockGetIdentity = jest.fn(() => Promise.resolve({ deviceId: 'device-1', userGroupId: null }));
  render(<ProfileSettings />);

  const row = await screen.findByTestId('profile-user-group');
  expect(row.textContent).toContain('Not created yet');
  fireEvent.click(row);
  expect(mockWriteText).not.toHaveBeenCalled();
});

it('reports a load failure inline, not as a snackbar that would leave a blank page', async () => {
  mockGetIdentity = jest.fn(() => Promise.reject(new Error('keyhive unavailable')));
  render(<ProfileSettings />);

  await waitFor(() => expect(screen.getByText('keyhive unavailable')).toBeDefined());
  expect(mockShowError).not.toHaveBeenCalled();
});
