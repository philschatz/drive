import { render, screen, fireEvent } from '@testing-library/preact';

// Mock automerge module before importing EditorTitleBar
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

jest.mock('../components/AccessControl', () => ({
  AccessControl: () => null,
  AccessControlSheet: () => null,
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

import { EditorTitleBar } from './EditorTitleBar';
import { useWsStatus } from './automerge';

const mockUseConnectionStatus = useWsStatus as jest.Mock;

describe('EditorTitleBar', () => {
  beforeEach(() => {
    mockUseConnectionStatus.mockReturnValue(true);
    mockAccessReturn = { access: null, canEdit: true, loaded: true };
  });

  it('renders icon and title', () => {
    render(<EditorTitleBar icon="calendar_month" title="My Calendar" />);
    expect(screen.getByText('calendar_month')).toBeDefined();
    expect(screen.getByText('My Calendar')).toBeDefined();
  });

  it('renders title as plain text when not editable', () => {
    render(<EditorTitleBar icon="grid" title="Sheet" />);
    const el = screen.getByText('Sheet');
    expect(el.tagName).toBe('SPAN');
  });

  it('renders title as input when editable', () => {
    render(<EditorTitleBar icon="grid" title="Sheet" titleEditable />);
    const input = screen.getByDisplayValue('Sheet') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
  });

  it('calls onTitleChange on input', () => {
    const onChange = jest.fn();
    render(<EditorTitleBar icon="grid" title="Old" titleEditable onTitleChange={onChange} />);
    const input = screen.getByDisplayValue('Old') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'New' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('calls onTitleBlur on blur', () => {
    const onBlur = jest.fn();
    render(<EditorTitleBar icon="grid" title="Test" titleEditable onTitleBlur={onBlur} />);
    const input = screen.getByDisplayValue('Test') as HTMLInputElement;
    // preact/compat (loaded via the Sheet's createPortal import) aliases onBlur
    // to a focusout listener; dispatch the native event jsdom-side.
    fireEvent(input, new FocusEvent('focusout', { bubbles: true }));
    expect(onBlur).toHaveBeenCalled();
  });

  // The status is icon-only; the state is exposed through the button's
  // accessible name (see ConnectionStatus).
  it('shows a connected wifi icon when connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Connected').textContent).toBe('wifi_password');
  });

  it('shows an offline wifi icon when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(false);
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Disconnected').textContent).toBe('wifi_off');
  });

  it('renders peer dots for other peers', () => {
    const peers = [
      { peerId: 'self-peer-id' },
      { peerId: 'aabbcc' },
      { peerId: '112233' },
    ];
    render(<EditorTitleBar icon="grid" title="Test" peers={peers} />);
    // Self should be filtered out, so 2 dots
    const dots = document.querySelectorAll('[title^="Peer "]');
    expect(dots.length).toBe(2);
  });

  it('uses peerTitle for dot tooltips', () => {
    const peers = [{ peerId: 'abc123', name: 'Alice' }];
    render(
      <EditorTitleBar
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
    render(<EditorTitleBar icon="grid" title="Test" docId="doc-123" />);
    const link = screen.getByTitle('Edit Source') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/source/doc-123');
  });

  it('hides source link when showSourceLink is false', () => {
    render(<EditorTitleBar icon="grid" title="Test" docId="doc-123" showSourceLink={false} />);
    expect(screen.queryByTitle('Edit Source')).toBeNull();
  });

  it('hides source link when no docId', () => {
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.queryByTitle('Edit Source')).toBeNull();
  });

  it('renders history button when onToggleHistory is provided', () => {
    const onToggle = jest.fn();
    render(<EditorTitleBar icon="grid" title="Test" onToggleHistory={onToggle} />);
    const btn = screen.getByTitle('Browse history');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not render history button when onToggleHistory is not provided', () => {
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.queryByTitle('Browse history')).toBeNull();
    expect(screen.queryByTitle('Close history')).toBeNull();
  });

  it('shows "Close history" title when historyActive', () => {
    render(<EditorTitleBar icon="grid" title="Test" onToggleHistory={() => {}} historyActive />);
    expect(screen.getByTitle('Close history')).toBeDefined();
  });

  it('renders children in the middle', () => {
    render(
      <EditorTitleBar icon="grid" title="Test">
        <span data-testid="child">Extra</span>
      </EditorTitleBar>
    );
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('has back link to home', () => {
    render(<EditorTitleBar icon="grid" title="Test" />);
    const backLink = screen.getByText('arrow_back').closest('a') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('#/');
  });

  it('shows the inline share button for admins (no overflow Share item)', () => {
    mockAccessReturn = { access: 'admin', canEdit: true, loaded: true };
    render(<EditorTitleBar icon="grid" title="Test" docId="doc-123" />);
    const btn = screen.getByLabelText('Share');
    expect(btn.tagName).toBe('BUTTON');
    // Exactly one Share surface — the inline button, not a duplicate menu item.
    expect(screen.getAllByTitle('Share & permissions').length).toBe(1);
  });

  it('keeps Share in the overflow menu for non-admins', () => {
    mockAccessReturn = { access: 'read', canEdit: false, loaded: true };
    render(<EditorTitleBar icon="grid" title="Test" docId="doc-123" />);
    expect(screen.queryByLabelText('Share')).toBeNull();
    expect(screen.getByTitle('Share & permissions').tagName.toLowerCase()).toBe('md-menu-item');
  });

  it('shows no access badge text for any access level', () => {
    mockAccessReturn = { access: 'read', canEdit: false, loaded: true };
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.queryByText('Read-only')).toBeNull();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.queryByText('Editing')).toBeNull();
  });
});
