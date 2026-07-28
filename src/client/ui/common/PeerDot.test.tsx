// PeerDot pulls in worker-api for PresenceDot's transport lookup; the real
// module spins up a Worker.
jest.mock('../worker-api', () => ({
  usePeerTransports: jest.fn(() => ({ 'AAAAdeviceKeyA=-drive': 'direct' })),
}));

import { render, screen } from '@testing-library/preact';
import { PeerDot, PresenceDot } from './PeerDot';
import { colorForKey, peerIdentityKey } from './presence';
import { applyFriendNamesFromWorker } from '../friend-names';

const GROUP = 'dXNlci1ncm91cC1pZA==';
const PEER_A = 'AAAAdeviceKeyA=-drive';
const PEER_B = 'BBBBdeviceKeyB=-drive';

/** jsdom normalizes inline colors to rgb(); the palette is authored as hex. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

beforeEach(() => applyFriendNamesFromWorker({}));

describe('PeerDot', () => {
  const dot = () => screen.getByTestId('peer-dot');

  it('fills with the identity color for a direct (P2P) peer', () => {
    render(<PeerDot identityKey={GROUP} direct />);
    expect(dot().style.backgroundColor).toBe(rgb(colorForKey(GROUP)));
    // jsdom drops `border: none` from the serialized declaration entirely, so
    // assert what actually matters: a direct dot is filled, with no ring.
    expect(dot().getAttribute('style')).not.toContain('solid');
    expect(dot().title).toContain('direct (P2P)');
  });

  it('rings in the identity color for a relayed peer', () => {
    render(<PeerDot identityKey={GROUP} />);
    expect(dot().style.backgroundColor).toBe('transparent');
    expect(dot().style.border).toBe(`2px solid ${rgb(colorForKey(GROUP))}`);
    expect(dot().title).toContain('via relay');
  });

  it('renders a muted dot with NO inline style when offline', () => {
    render(<PeerDot identityKey={GROUP} online={false} />);
    // An inline background would outrank the class and hide the dot entirely.
    expect(dot().getAttribute('style')).toBeNull();
    expect(dot().className).toContain('bg-muted-foreground/30');
    expect(dot().title).toContain('Offline');
  });

  it('resolves a saved friend name for its tooltip', () => {
    applyFriendNamesFromWorker({ [GROUP]: 'Alice' });
    render(<PeerDot identityKey={GROUP} />);
    expect(dot().title).toContain('Alice');
  });

  /**
   * The reason this component exists. Within a document the same person is shown
   * beside the connection icon, in the connection sheet, on their focused field,
   * and on the sharing panel — from two different sources: presence peers carry a
   * userGroupId, while a sharing row carries member.agentId. Those are the same
   * base64 group id, so every one of those dots must land on the same colour, and
   * a second device of the same user must not get a second colour.
   */
  it('paints one colour per person, from either source and any device', () => {
    const style = (key: string) => {
      const { container } = render(<PeerDot identityKey={key} direct />);
      return container.querySelector('[data-testid="peer-dot"]')!.getAttribute('style');
    };

    const sharingRow = style(GROUP);                              // member.agentId
    expect(style(peerIdentityKey(PEER_A, GROUP))).toBe(sharingRow); // presence peer
    expect(style(peerIdentityKey(PEER_B, GROUP))).toBe(sharingRow); // their 2nd device
  });
});

describe('PresenceDot', () => {
  const info = { color: '#fff', peerId: PEER_A, userGroupId: GROUP };

  it('renders nothing when no peer is on the field', () => {
    const { container } = render(<PresenceDot fieldId="f-title" peerFocusedFields={{}} />);
    expect(container.querySelector('[data-testid="peer-dot"]')).toBeNull();
  });

  it('uses the peer identity colour and says who is editing', () => {
    render(<PresenceDot fieldId="f-title" peerFocusedFields={{ 'f-title': info }} />);
    const dot = screen.getByTestId('peer-dot');
    expect(dot.style.backgroundColor).toBe(rgb(colorForKey(GROUP)));
    expect(dot.title).toContain('is editing');
  });

  it('lights up for any field in a grouped row', () => {
    render(<PresenceDot fieldIds={['f-date', 'f-time']} peerFocusedFields={{ 'f-time': info }} />);
    expect(screen.getByTestId('peer-dot')).toBeDefined();
  });
});
