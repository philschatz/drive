import { render, screen, waitFor } from '@testing-library/preact';

let mockGetDocMembers: jest.Mock;
let mockGetMyAccess: jest.Mock;
let mockGetKnownContacts: jest.Mock;
let mockGetIdentity: jest.Mock;
let mockStatuses: Record<string, { online: boolean; transport?: 'direct' | 'relay' }>;
let mockNames: Record<string, string>;

jest.mock('../common/keyhive-api', () => ({
  getDocMembers: (...args: any[]) => mockGetDocMembers(...args),
  getMyAccess: (...args: any[]) => mockGetMyAccess(...args),
  getKnownFriends: (...args: any[]) => mockGetKnownContacts(...args),
  getIdentity: (...args: any[]) => mockGetIdentity(...args),
  onKeyhiveStateChanged: jest.fn(() => jest.fn()),
  changeRole: jest.fn(),
  revokeMember: jest.fn(),
  addMember: jest.fn(),
}));

jest.mock('../friend-names', () => ({
  getFriendName: (id: string) => mockNames[id],
  setFriendName: jest.fn(() => Promise.resolve()),
  // Pass-through: these tests don't exercise the cache merge.
  mergeCachedFriends: (fromKeyhive: any[]) => fromKeyhive,
}));

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/ui/alert', () => ({
  Alert: ({ children }: any) => <div role="alert">{children}</div>,
}));

// use-devices and presence pull in worker-api (import.meta / new Worker), which
// the jsdom jest env can't load. Drive connection state through mockStatuses.
jest.mock('../common/use-devices', () => ({
  useDeviceStatuses: () => mockStatuses,
  mostConnectedStatus: (statuses: any, ids: string[]) => {
    for (const id of ids) {
      const s = statuses[id];
      if (s?.online) return s;
    }
    return { online: false };
  },
}));

jest.mock('../common/presence', () => ({
  StatusDot: ({ online, direct }: any) => (
    <span data-testid="status-dot" data-online={String(!!online)} data-direct={String(!!direct)} />
  ),
}));

// AddFriendSheet transitively imports shared/automerge → worker-api (import.meta /
// new Worker), so stub it — but keep its open state observable.
jest.mock('../settings/AddFriendSheet', () => ({
  AddFriendSheet: ({ open }: any) => open ? <div data-testid="add-friend-sheet" /> : null,
}));

import { SharingPage } from './SharingPage';

const member = (agentId: string, extra: Record<string, any> = {}) => ({
  agentId,
  displayId: agentId,
  role: 'edit',
  type: 'group',
  deviceIds: [`${agentId}-dev`],
  isMe: false,
  ...extra,
});

beforeEach(() => {
  mockGetDocMembers = jest.fn(() => Promise.resolve({ members: [] }));
  mockGetMyAccess = jest.fn(() => Promise.resolve(null));
  mockGetKnownContacts = jest.fn(() => Promise.resolve([]));
  mockGetIdentity = jest.fn(() => Promise.resolve({ deviceId: 'dev-1', agentId: 'me', userGroupId: 'my-group' }));
  mockStatuses = {};
  mockNames = {};
});

describe('SharingPage — access loading', () => {
  it('does not show "no access" message before data loads', async () => {
    // API calls that never resolve — simulates slow network
    mockGetDocMembers.mockReturnValue(new Promise(() => {}));
    mockGetMyAccess.mockReturnValue(new Promise(() => {}));
    mockGetKnownContacts.mockReturnValue(new Promise(() => {}));

    render(<SharingPage docId="doc-1" />);

    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
  });

  it('shows "no access" message after refresh returns null access and empty members', async () => {
    render(<SharingPage docId="doc-1" />);

    await waitFor(() => {
      expect(screen.getByText('You no longer have access to this document')).toBeDefined();
    });
  });

  it('does not show "no access" or the empty placeholder when API calls hang', async () => {
    mockGetDocMembers.mockReturnValue(new Promise(() => {}));
    mockGetMyAccess.mockReturnValue(new Promise(() => {}));
    mockGetKnownContacts.mockReturnValue(new Promise(() => {}));

    render(<SharingPage docId="doc-1" />);

    // Wait a tick — neither the "no access" block nor the empty-members
    // placeholder should appear while loading.
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
    expect(screen.queryByText('Not shared with anyone yet.')).toBeNull();
  });

  it('does not show "no access" message when access is granted', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({
      members: [member('a1', { type: 'individual', role: 'admin', isMe: true, deviceIds: undefined })],
    });

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(mockGetMyAccess).toHaveBeenCalled());
    expect(screen.queryByText('You no longer have access to this document')).toBeNull();
  });
});

describe('SharingPage — member list', () => {
  it('excludes the current user and shows the empty placeholder', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({ members: [member('me', { isMe: true })] });

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => {
      expect(screen.getByText('Not shared with anyone yet.')).toBeDefined();
    });
    expect(screen.queryAllByTestId('member-row')).toHaveLength(0);
  });

  it('sorts P2P before relay before offline, and tags each transport', async () => {
    mockGetMyAccess.mockResolvedValue('Read');
    mockGetDocMembers.mockResolvedValue({
      members: [member('offline'), member('relayed'), member('direct')],
    });
    mockNames = { offline: 'Zoe', relayed: 'Yan', direct: 'Xavi' };
    mockStatuses = {
      'relayed-dev': { online: true, transport: 'relay' },
      'direct-dev': { online: true, transport: 'direct' },
    };

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(screen.queryAllByTestId('member-row')).toHaveLength(3));
    expect(screen.queryAllByTestId('member-transport').map(n => n.textContent))
      .toEqual(['P2P', 'Via relay', 'Offline']);
    // Sorted by connection, not by name — Xavi/Yan/Zoe happens to be alphabetical
    // here, so assert the dots instead: only the first is a filled (direct) dot.
    expect(screen.queryAllByTestId('status-dot').map(n => n.getAttribute('data-direct')))
      .toEqual(['true', 'false', 'false']);
    expect(screen.queryAllByTestId('status-dot').map(n => n.getAttribute('data-online')))
      .toEqual(['true', 'true', 'false']);
  });

  it('shows each member\'s role, defaulting to read', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({
      members: [member('a1', { role: 'admin' }), member('a2', { role: undefined })],
    });

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(screen.queryAllByTestId('member-row')).toHaveLength(2));
    expect(screen.queryAllByTestId('member-role').map(n => n.textContent)).toEqual(['admin', 'read']);
  });

  it('opens the QR invite on arrival when the user has no contacts at all', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({ members: [member('me', { isMe: true })] });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(screen.getByTestId('add-friend-sheet')).toBeDefined());
    expect(screen.queryByTestId('add-people-sheet')).toBeNull();
  });

  it('does not auto-invite when the doc already has members', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({ members: [member('a1')] });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(screen.queryAllByTestId('member-row')).toHaveLength(1));
    expect(screen.queryByTestId('add-friend-sheet')).toBeNull();
  });

  it('does not auto-invite non-admins, who cannot share anyway', async () => {
    mockGetMyAccess.mockResolvedValue('Read');
    mockGetDocMembers.mockResolvedValue({ members: [member('me', { isMe: true })] });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<SharingPage docId="doc-1" />);

    await waitFor(() => expect(screen.getByText('Not shared with anyone yet.')).toBeDefined());
    expect(screen.queryByTestId('add-friend-sheet')).toBeNull();
  });

  it('opens the picker when there are friends to add', async () => {
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetKnownContacts.mockResolvedValue([member('friend')]);

    render(<SharingPage docId="doc-1" />);
    await waitFor(() => expect(screen.getByLabelText('Add people')).toBeDefined());
    screen.getByLabelText('Add people').click();

    await waitFor(() => expect(screen.getByTestId('add-people-sheet')).toBeDefined());
    expect(screen.queryByTestId('add-friend-sheet')).toBeNull();
  });

  it('skips the empty picker and invites straight away when there are no friends left', async () => {
    // A member on the doc suppresses the arrival auto-invite, so the sheet that
    // opens here is the button's doing, not the page's.
    mockGetMyAccess.mockResolvedValue('Admin');
    mockGetDocMembers.mockResolvedValue({ members: [member('a1')] });
    mockGetKnownContacts.mockResolvedValue([]);

    render(<SharingPage docId="doc-1" />);
    await waitFor(() => expect(screen.queryAllByTestId('member-row')).toHaveLength(1));
    expect(screen.queryByTestId('add-friend-sheet')).toBeNull();

    screen.getByLabelText('Add people').click();

    await waitFor(() => expect(screen.getByTestId('add-friend-sheet')).toBeDefined());
    expect(screen.queryByTestId('add-people-sheet')).toBeNull();
  });

  it('offers the add button to admins only', async () => {
    mockGetMyAccess.mockResolvedValue('Read');
    mockGetDocMembers.mockResolvedValue({ members: [member('a1')] });

    const { rerender } = render(<SharingPage docId="doc-1" />);
    await waitFor(() => expect(screen.queryAllByTestId('member-row')).toHaveLength(1));
    expect(screen.queryByLabelText('Add people')).toBeNull();

    mockGetMyAccess.mockResolvedValue('Admin');
    rerender(<SharingPage docId="doc-2" />);
    await waitFor(() => expect(screen.getByLabelText('Add people')).toBeDefined());
  });
});
