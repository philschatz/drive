import { render, screen, waitFor } from '@testing-library/preact';

let mockGetDocMembers: jest.Mock;
let mockGetMyAccess: jest.Mock;
let mockGetKnownContacts: jest.Mock;
let mockGetIdentity: jest.Mock;

jest.mock('../shared/keyhive-api', () => ({
  getDocMembers: (...args: any[]) => mockGetDocMembers(...args),
  getMyAccess: (...args: any[]) => mockGetMyAccess(...args),
  getKnownContacts: (...args: any[]) => mockGetKnownContacts(...args),
  getIdentity: (...args: any[]) => mockGetIdentity(...args),
  onKeyhiveStateChanged: jest.fn(() => jest.fn()),
  changeRole: jest.fn(),
  revokeMember: jest.fn(),
  addMember: jest.fn(),
}));

jest.mock('../contact-names', () => ({
  getContactName: () => undefined,
  // Pass-through: these tests don't exercise the cache merge.
  mergeCachedContacts: (fromKeyhive: any[]) => fromKeyhive,
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectSeparator: () => null,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => null,
}));

jest.mock('./EditableUserName', () => ({
  EditableUserName: ({ value }: any) => <span>{value}</span>,
}));

// use-devices pulls in worker-api (import.meta / new Worker), which the jsdom
// jest env can't load. These tests don't exercise presence, so stub it out.
jest.mock('../shared/use-devices', () => ({
  useDeviceStatuses: () => ({}),
  mostConnectedStatus: () => ({ online: false }),
}));

// AddFriendSheet transitively imports shared/automerge → worker-api (import.meta /
// new Worker), which the jsdom jest env can't load. These tests don't open the
// sheet, so stub it out.
jest.mock('../settings/AddFriendSheet', () => ({
  AddFriendSheet: () => null,
}));

import { AccessControl } from './AccessControl';

beforeEach(() => {
  mockGetDocMembers = jest.fn(() => Promise.resolve({ members: [] }));
  mockGetMyAccess = jest.fn(() => Promise.resolve(null));
  mockGetKnownContacts = jest.fn(() => Promise.resolve([]));
  mockGetIdentity = jest.fn(() => Promise.resolve({ deviceId: 'dev-1', agentId: 'me', userGroupId: 'my-group' }));
});

describe('AccessControl', () => {
  it('does not show "no access" message before data loads', async () => {
    // API calls that never resolve — simulates slow network
    mockGetDocMembers.mockReturnValue(new Promise(() => {}));
    mockGetMyAccess.mockReturnValue(new Promise(() => {}));
    mockGetKnownContacts.mockReturnValue(new Promise(() => {}));

    render(<AccessControl docId="doc-1" access="admin" />);
    // Open the sheet
    screen.getByTitle('Admin access · Share & permissions').click();

    // The "no access" message should NOT be visible while loading
    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
  });

  it('shows "no access" message after refresh returns null access and empty members', async () => {
    mockGetMyAccess.mockResolvedValue(null);
    mockGetDocMembers.mockResolvedValue({ members: [] });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<AccessControl docId="doc-1" access={null} />);
    screen.getByTitle('No access · Share & permissions').click();

    await waitFor(() => {
      expect(screen.getByText('You no longer have access to this document')).toBeDefined();
    });
  });

  it('does not show "no access" when API calls hang (never resolve)', async () => {
    mockGetDocMembers.mockReturnValue(new Promise(() => {}));
    mockGetMyAccess.mockReturnValue(new Promise(() => {}));
    mockGetKnownContacts.mockReturnValue(new Promise(() => {}));

    render(<AccessControl docId="doc-1" access={null} />);
    screen.getByTitle('No access · Share & permissions').click();

    // Wait a tick — message should still not appear
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
    // Members should show placeholder, not the "no access" block
    expect(screen.getByText('No members found.')).toBeDefined();
  });

  it('does not show "no access" message when access is granted', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({
      members: [{ agentId: 'a1', displayId: 'a1', role: 'admin', type: 'individual', isMe: true }],
    });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<AccessControl docId="doc-1" access="admin" />);
    screen.getByTitle('Admin access · Share & permissions').click();

    await waitFor(() => {
      expect(mockGetMyAccess).toHaveBeenCalled();
    });

    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
  });
});
