import { render, screen, fireEvent } from '@testing-library/preact';

// Mock automerge module before importing EditorTitleBar
jest.mock('./automerge', () => ({
  useWsStatus: jest.fn(() => true),
  getWorkerPeerId: jest.fn(() => 'self-peer-id'),
  repo: { peerId: 'self-peer-id' },
}));

jest.mock('./presence', () => ({
  peerColor: (id: string) => `#${id.slice(0, 6)}`,
}));

jest.mock('./keyhive-api', () => ({
  initKeyhiveApi: jest.fn(),
  handleKeyhiveResponse: jest.fn(),
  getDocMembers: jest.fn(() => Promise.resolve({ members: [], invites: [] })),
  getMyAccess: jest.fn(() => Promise.resolve(null)),
  changeRole: jest.fn(),
  revokeMember: jest.fn(),
  generateInvite: jest.fn(),
  enableSharing: jest.fn(() => Promise.resolve({ khDocId: 'test', groupId: 'test' })),
  registerSharingGroup: jest.fn(() => Promise.resolve()),
}));

jest.mock('../components/AccessControl', () => ({
  AccessControl: () => null,
}));

jest.mock('./useAccess', () => ({
  useAccess: () => ({ canEdit: true }),
}));

jest.mock('../doc-storage', () => ({
  getDocEntry: () => undefined,
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
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });

  it('shows Connected when connected', () => {
    mockUseConnectionStatus.mockReturnValue(true);
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.getByText('Connected')).toBeDefined();
  });

  it('shows Disconnected when not connected', () => {
    mockUseConnectionStatus.mockReturnValue(false);
    render(<EditorTitleBar icon="grid" title="Test" />);
    expect(screen.getByText('Disconnected')).toBeDefined();
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
    expect(screen.getByTitle('Alice')).toBeDefined();
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
});
