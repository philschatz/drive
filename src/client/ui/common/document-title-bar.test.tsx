import { render, screen, fireEvent, act } from '@testing-library/preact';

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
}));

jest.mock('./PeerDot', () => ({
  PeerDot: ({ identityKey, label }: any) => <span title={label ?? `Peer ${identityKey}`} />,
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

  it('renders title as inert text when not editable, and tapping it does nothing', () => {
    render(<DocumentTitleBar icon="grid" title="Sheet" />);
    const el = screen.getByTestId('doc-title');
    expect(el.tagName).toBe('SPAN');
    fireEvent.click(el);
    expect(screen.queryByTestId('rename-input')).toBeNull();
  });

  // Tapping the title renames, but never in place: it opens the same
  // transactional sheet the kebab does, so a stray tap costs one Cancel.
  it('renders the title as a button when renameable, and tapping it opens the rename sheet', () => {
    render(<DocumentTitleBar icon="grid" title="Sheet" titleEditable />);
    const el = screen.getByTestId('doc-title');
    expect(el.tagName).toBe('BUTTON');
    // Never an input in place.
    expect(screen.queryByTestId('doc-title-input')).toBeNull();
    expect(screen.queryByTestId('rename-input')).toBeNull();

    fireEvent.click(el);
    expect((screen.getByTestId('rename-input') as HTMLInputElement).value).toBe('Sheet');
  });

  it('title tap → rename reports the new name', () => {
    const onRename = jest.fn();
    render(<DocumentTitleBar icon="grid" title="Old" titleEditable onRename={onRename} />);

    fireEvent.click(screen.getByTestId('doc-title'));
    fireEvent.input(screen.getByTestId('rename-input'), { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('rename-save'));

    expect(onRename).toHaveBeenCalledWith('New');
    expect(screen.queryByTestId('rename-input')).toBeNull();
  });

  // The title's own tooltip is the document name (a truncated title needs it).
  // It must NOT be "Rename" — that is how every spec locates the kebab item,
  // and a second exact match would break `getByTitle('Rename')` everywhere.
  it('does not collide with the kebab Rename item', () => {
    render(<DocumentTitleBar icon="grid" title="Sheet" titleEditable />);
    expect(screen.getByTitle('Rename').tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('doc-title').getAttribute('title')).toBe('Sheet');
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

  // The status is icon-only; the state is exposed through the button's accessible
  // name (see ConnectionStatus). The glyph is the cloud pair the Debugging page's
  // relay row uses — the two surfaces report the same fact, so they say it the
  // same way.
  it('shows a connected cloud icon when connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Connected').textContent).toBe('cloud_done');
  });

  it('shows an offline cloud icon when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(false);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect(screen.getByLabelText('Disconnected').textContent).toBe('cloud_off');
  });

  // Offline there are no peers or transports to show, but the button stays
  // enabled: the sheet still reports the relay state ("Relay socket / Closed")
  // and links into the Debugging page. The greyed-out glyph is the offline
  // signal; the control itself must remain tappable.
  it('keeps the status button enabled when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect((screen.getByLabelText('Connected') as HTMLButtonElement).disabled).toBe(false);

    mockUseConnectionStatus.mockReturnValue(false);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    expect((screen.getByLabelText('Disconnected') as HTMLButtonElement).disabled).toBe(false);
  });

  it('still opens the Connection sheet when offline', () => {
    mockUseConnectionStatus.mockReturnValue(false);
    render(<DocumentTitleBar icon="grid" title="Test" />);
    fireEvent.click(screen.getByLabelText('Disconnected'));
    expect(screen.getByTestId('connection-sheet')).toBeTruthy();
    // The relay row reports the closed socket so the sheet has something to say.
    expect(screen.getByTestId('relay-status').getAttribute('data-open')).toBe('false');
  });

  it('deep-links the sheet\'s "Relay socket" row to the Debugging page', () => {
    render(<DocumentTitleBar icon="grid" title="Test" />);
    fireEvent.click(screen.getByLabelText('Connected'));
    fireEvent.click(screen.getByTestId('relay-status'));
    expect(window.location.hash).toBe('#/settings/debugging');
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

  /**
   * Hide-on-scroll belongs to the bar, not to each editor: a new document type
   * gets it by mounting one. `sticky={false}` opts out — that bar sits in a
   * layout (DataGrid's) that hides it, so translating itself too would double up.
   */
  describe('hide-on-scroll', () => {
    const bar = () => screen.getByText('arrow_back').closest('div')!;
    const scrollTo = async (y: number) => {
      (window as any).scrollY = y;
      await act(() => { document.dispatchEvent(new Event('scroll')); return Promise.resolve(); });
    };

    afterEach(() => { (window as any).scrollY = 0; });

    it('hides itself when the page scrolls down, with nothing passed', async () => {
      render(<DocumentTitleBar icon="grid" title="Test" />);
      expect(bar().className).not.toContain('-translate-y-full');

      await scrollTo(400); // well past the hook's 12px threshold
      expect(bar().className).toContain('-translate-y-full');

      await scrollTo(0); // back to the top always reveals
      expect(bar().className).not.toContain('-translate-y-full');
    });

    it('leaves a non-sticky bar alone (its layout owns the hiding)', async () => {
      render(<DocumentTitleBar icon="grid" title="Test" sticky={false} />);
      await scrollTo(400);
      expect(bar().className).not.toContain('-translate-y-full');
    });

    it('lets an explicit `hidden` override win', async () => {
      render(<DocumentTitleBar icon="grid" title="Test" hidden={false} />);
      await scrollTo(400);
      expect(bar().className).not.toContain('-translate-y-full');
    });
  });
});
