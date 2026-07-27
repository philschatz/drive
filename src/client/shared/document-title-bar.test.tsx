import { render, screen, fireEvent } from '@testing-library/preact';

// Mock automerge module before importing DocumentTitleBar
jest.mock('./automerge', () => ({
  useWsStatus: jest.fn(() => true),
  usePeerTransports: jest.fn(() => ({})),
  getWorkerPeerId: jest.fn(() => 'self-peer-id'),
  repo: { peerId: 'self-peer-id' },
}));

jest.mock('./presence', () => ({
  peerColor: (id: string) => `#${id.slice(0, 6)}`,
  peerDisplayName: (id: string) => `Peer ${id.slice(0, 8)}`,
  peerIdentityKey: (id: string, ug?: string | null) => ug || id.split('-')[0],
  // Mirrors the real filter: drop self + own devices, collapse per identity.
  dedupePeers: (peers: any[], myPeerId?: string | null, myGroup?: string | null) => {
    const seen = new Set<string>();
    return peers.filter((peer: any) => {
      if (myPeerId && peer.peerId === myPeerId) return false;
      const ug = peer.value?.userGroupId;
      if (myGroup && ug === myGroup) return false;
      const id = ug || peer.peerId.split('-')[0];
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  },
  PeerDot: ({ peerId, label }: any) => <span title={label ?? `Peer ${peerId}`} />,
}));

jest.mock('../worker-api', () => ({
  getWorkerUserGroupId: jest.fn(() => null),
}));

jest.mock('./keyhive-api', () => ({
  initKeyhiveApi: jest.fn(),
  handleKeyhiveResponse: jest.fn(),
  getDocMembers: jest.fn(() => Promise.resolve({ members: [] })),
  getMyAccess: jest.fn(() => Promise.resolve(null)),
  changeRole: jest.fn(),
  revokeMember: jest.fn(),
}));

let mockAccessReturn = { access: null, canEdit: true, loaded: true };
jest.mock('./useAccess', () => ({
  useAccess: () => mockAccessReturn,
}));

jest.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => children,
  DropdownMenuTrigger: ({ children }: any) => children,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));

import { DocumentTitleBar } from './DocumentTitleBar';
import { useWsStatus } from './automerge';

const mockUseConnectionStatus = useWsStatus as jest.Mock;

describe('DocumentTitleBar', () => {
  beforeEach(() => {
    mockUseConnectionStatus.mockReturnValue(true);
    mockAccessReturn = { access: null, canEdit: true, loaded: true };
  });

  it('renders icon and title', () => {
    render(<DocumentTitleBar icon="calendar_month" title="My Calendar" />);
    expect(screen.getByText('calendar_month')).toBeDefined();
    expect(screen.getByText('My Calendar')).toBeDefined();
  });

  it('renders title as plain text when not editable', () => {
    render(<DocumentTitleBar icon="grid" title="Sheet" />);
    const el = screen.getByText('Sheet');
    expect(el.tagName).toBe('SPAN');
  });

  // Renaming is deliberate — kebab → Rename → a sheet. The title itself is
  // never an input, so tapping it can't start an accidental rename.
  it('renders title as plain text even when renameable', () => {
    render(<DocumentTitleBar icon="grid" title="Sheet" titleEditable />);
    expect(screen.getByTestId('doc-title').tagName).toBe('SPAN');
    expect(screen.queryByTestId('doc-title-input')).toBeNull();
  });

  it('offers Rename in the kebab only when renameable', () => {
    const { unmount } = render(<DocumentTitleBar icon="grid" title="Sheet" />);
    expect(screen.queryByTitle('Rename')).toBeNull();
    unmount();

    render(<DocumentTitleBar icon="grid" title="Sheet" titleEditable />);
    expect(screen.getByTitle('Rename')).toBeTruthy();
  });

  it('kebab → Rename opens the rename sheet, which reports the new name', () => {
    const onRename = jest.fn();
    render(<DocumentTitleBar icon="grid" title="Old" titleEditable onRename={onRename} />);

    // md-menu is unregistered under jsdom, so its items are always in the DOM.
    fireEvent.click(screen.getByTitle('Rename'));
    const input = screen.getByTestId('rename-input') as HTMLInputElement;
    expect(input.value).toBe('Old');

    fireEvent.input(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('rename-save'));
    expect(onRename).toHaveBeenCalledWith('New');
    // Committing dismisses the sheet.
    expect(screen.queryByTestId('rename-input')).toBeNull();
  });

  it('rename ignores a blank name', () => {
    const onRename = jest.fn();
    render(<DocumentTitleBar icon="grid" title="Old" titleEditable onRename={onRename} />);
    fireEvent.click(screen.getByTitle('Rename'));
    fireEvent.input(screen.getByTestId('rename-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('rename-save'));
    expect(onRename).not.toHaveBeenCalled();
  });

  // The status is icon-only; the state is exposed through the button's
  // accessible name (see ConnectionStatus).
  it('shows a connected wifi icon when connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Connected').textContent).toBe('wifi_password');
  });

  it('shows an offline wifi icon when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(false);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Disconnected').textContent).toBe('wifi_off');
  });

  // Offline there are no peers or transports to show, so the status button is
  // disabled — its greyed-out state is the offline signal, and no browser
  // dispatches a click from it, so the peer sheet can't be opened. (jsdom's
  // fireEvent does dispatch on disabled buttons, so asserting "no sheet opens"
  // here would test jsdom, not the app — the `disabled` flag is the contract.)
  it('disables the status button when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect((screen.getByLabelText('Connected') as HTMLButtonElement).disabled).toBe(false);

    mockUseConnectionStatus.mockReturnValue(false);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect((screen.getByLabelText('Disconnected') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders peer dots for other peers', () => {
    const peers = [
      { peerId: 'self-peer-id' },
      { peerId: 'aabbcc' },
      { peerId: '112233' },
    ];
    render(<DocumentTitleBar icon="grid" title="Test" peers={peers} />);
    // Self should be filtered out, so 2 dots
    const dots = document.querySelectorAll('[title^="Peer "]');
    expect(dots.length).toBe(2);
  });

  it('uses peerTitle for dot tooltips', () => {
    const peers = [{ peerId: 'abc123', name: 'Alice' }];
    render(
      <DocumentTitleBar
        icon="grid"
        title="Test"
        peers={peers}
        peerTitle={(p) => p.name}
      />
    );
    // The dot tooltip appends the transport (relay by default in this mock).
    expect(screen.getByTitle(/^Alice/)).toBeDefined();
  });

  it('shows source link when docId is provided', () => {
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" />);
    const link = screen.getByTitle('Edit Source') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/source/doc-123');
  });

  it('hides source link when showSourceLink is false', () => {
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" showSourceLink={false} />);
    expect(screen.queryByTitle('Edit Source')).toBeNull();
  });

  it('hides source link when no docId', () => {
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.queryByTitle('Edit Source')).toBeNull();
  });

  it('offers History in the kebab by default', () => {
    const onToggle = jest.fn();
    render(<DocumentTitleBar icon="grid" title="Test" onToggleHistory={onToggle} />);
    const item = screen.getByTitle('History');
    expect(item.tagName.toLowerCase()).toBe('md-menu-item');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('puts History on the bar with historyPlacement="bar"', () => {
    const onToggle = jest.fn();
    render(<DocumentTitleBar icon="grid" title="Test" onToggleHistory={onToggle} historyPlacement="bar" />);
    const btn = screen.getByLabelText('History');
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not render history button when onToggleHistory is not provided', () => {
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.queryByTitle('Browse history')).toBeNull();
    expect(screen.queryByTitle('History')).toBeNull();
  });

  it('renders the document action on the bar', () => {
    const onSelect = jest.fn();
    render(
      <DocumentTitleBar
        icon="grid"
        title="Test"
        action={{ icon: 'bar_chart', label: 'Chart', onSelect }}
      />
    );
    const btn = screen.getByLabelText('Chart');
    expect(btn.tagName).toBe('BUTTON');
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('links validation errors to the source editor', () => {
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" hasValidationErrors />);
    const link = screen.getByLabelText('Validation errors');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toContain('doc-123');
  });

  it('omits the validation warning when there are no errors', () => {
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" />);
    expect(screen.queryByLabelText('Validation errors')).toBeNull();
  });

  it('renders children in the middle', () => {
    render(
      <DocumentTitleBar icon="grid" title="Test">
        <span data-testid="child">Extra</span>
      </DocumentTitleBar>
    );
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('has back link to home', () => {
    render(<DocumentTitleBar icon="grid" title="Test" />);
    const backLink = screen.getByText('arrow_back').closest('a') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('#/');
  });

  it('links admins straight to the sharing page (no overflow Share item)', () => {
    mockAccessReturn = { access: 'admin', canEdit: true, loaded: true };
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" />);
    const link = screen.getByLabelText('Share');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('#/d/doc-123/share');
    // Exactly one Share surface — the inline link, not a duplicate menu item.
    expect(screen.getAllByTitle('Share & permissions').length).toBe(1);
  });

  it('keeps Share in the overflow menu for non-admins', () => {
    mockAccessReturn = { access: 'read', canEdit: false, loaded: true };
    render(<DocumentTitleBar icon="grid" title="Test" docId="doc-123" />);
    expect(screen.queryByLabelText('Share')).toBeNull();
    expect(screen.getByTitle('Share & permissions').tagName.toLowerCase()).toBe('md-menu-item');
  });

  it('shows no access badge text for any access level', () => {
    mockAccessReturn = { access: 'read', canEdit: false, loaded: true };
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.queryByText('Read-only')).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.queryByText('Editing')).toBeNull();
  });
});
