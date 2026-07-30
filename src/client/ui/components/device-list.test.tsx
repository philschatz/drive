/**
 * DeviceList: which actions each device row offers, and the per-device transport
 * label.
 *
 * The two rules worth pinning are that your OWN device's role is never editable
 * and your own device is never removable — self-demotion from admin is
 * unrecoverable from this screen, so the actions are not offered at all rather
 * than being guarded by a confirm. Those used to read as "the Select/trash isn't
 * rendered on that row"; now they are "those rows don't exist in the options
 * sheet", which is what these tests assert.
 *
 * Rows are `md-list-item`s, which carry no implicit ARIA role while unregistered
 * under jsdom — address them by testid, never `getByRole('button')`.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

let mockNames: Record<string, string>;
let mockSetDeviceName: jest.Mock;
let mockRemoveDeviceName: jest.Mock;

jest.mock('../device-names', () => ({
  getDeviceName: (id: string) => mockNames[id],
  setDeviceName: (...args: any[]) => mockSetDeviceName(...args),
  removeDeviceName: (...args: any[]) => mockRemoveDeviceName(...args),
}));

// Portal-free sheet stubs so every sheet body is queryable in the same tree.
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: any) => (open ? <div data-testid="sheet">{children}</div> : null),
  SheetContent: ({ children }: any) => <div>{children}</div>,
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
}));

// PeerDot pulls in presence → worker-api (import.meta / new Worker), which the
// jsdom jest env can't load.
jest.mock('@/common/PeerDot', () => ({
  PeerDot: ({ identityKey, online, direct }: any) => (
    <span
      data-testid="peer-dot"
      data-identity={identityKey}
      data-online={String(!!online)}
      data-direct={String(!!direct)}
    />
  ),
}));

jest.mock('@/components/ui/toast', () => ({
  showToast: jest.fn(),
  showError: jest.fn(),
}));

import { DeviceList } from './DeviceList';

const device = (agentId: string, extra: Record<string, any> = {}) =>
  ({ agentId, role: 'admin', isMe: false, ...extra }) as any;

const ME = device('me-agent', { isMe: true });
const OTHER = device('other-agent');

let onRemove: jest.Mock;
let onChangeRole: jest.Mock;

beforeEach(() => {
  mockNames = {};
  mockSetDeviceName = jest.fn(() => Promise.resolve());
  mockRemoveDeviceName = jest.fn(() => Promise.resolve());
  onRemove = jest.fn();
  onChangeRole = jest.fn();
});

function setup(devices: any[], statuses?: Record<string, any>) {
  render(<DeviceList devices={devices} onRemove={onRemove} onChangeRole={onChangeRole} statuses={statuses} />);
}

/** Tap the row whose text contains `text`, opening its options sheet. */
const openRow = (text: string) => {
  const row = screen.getAllByTestId('device-row').find(r => r.textContent?.includes(text));
  if (!row) throw new Error(`no device row matching ${text}`);
  fireEvent.click(row);
};

const sheet = () => screen.getByTestId('device-options-sheet');

describe('DeviceList row actions', () => {
  it('does not let an admin change or remove its OWN device', () => {
    setup([ME, OTHER]);
    expect(screen.getAllByTestId('device-row')).toHaveLength(2);

    // "This device" is the me row's own supporting text.
    openRow('This device');
    expect(within(sheet()).queryByTestId('device-change-role')).toBeNull();
    expect(within(sheet()).queryByTestId('device-remove')).toBeNull();
    // Renaming your own device is still offered.
    expect(within(sheet()).getByTestId('device-rename')).toBeDefined();
  });

  it('offers access + removal on another device to an admin', () => {
    setup([ME, OTHER]);
    openRow('other-agent');
    expect(within(sheet()).getByTestId('device-change-role')).toBeDefined();
    expect(within(sheet()).getByTestId('device-remove')).toBeDefined();
  });

  it('offers no access control at all to a non-admin device', () => {
    setup([device('me-agent', { isMe: true, role: 'read' }), OTHER]);
    openRow('other-agent');
    expect(within(sheet()).queryByTestId('device-change-role')).toBeNull();
    expect(within(sheet()).queryByTestId('device-remove')).toBeNull();
  });

  it("states every device's role on its row, including your own", () => {
    setup([ME, OTHER]);
    expect(screen.getAllByTestId('device-role').map(n => n.textContent)).toEqual(['Admin', 'Admin']);
  });

  it('reports no access rather than a role it does not have', () => {
    // The regression this guards: listGroupDevices used to hard-code the current
    // device as admin, so a revoked or demoted device saw itself as an admin and
    // was offered actions keyhive then refused.
    setup([device('me-agent', { isMe: true, role: null }), OTHER]);
    expect(screen.getAllByTestId('device-role').map(n => n.textContent)).toEqual(['No access', 'Admin']);

    openRow('other-agent');
    expect(within(sheet()).queryByTestId('device-change-role')).toBeNull();
    expect(within(sheet()).queryByTestId('device-remove')).toBeNull();
  });

  it('will not offer to demote or remove the founding device, and says why', () => {
    // The founder's delegation is the group's root delegation — no proof exists to
    // revoke it with, so keyhive throws NoProof.
    setup([ME, device('founder-agent', { isFounder: true })]);
    openRow('founder-agent');
    expect(within(sheet()).queryByTestId('device-change-role')).toBeNull();
    expect(within(sheet()).queryByTestId('device-remove')).toBeNull();
    expect(within(sheet()).getByTestId('device-founder-note').textContent).toContain('created the group');
  });

  it('will not offer to manage a sibling this device did not link, and says why', () => {
    // You can only revoke a delegation you issued (or one descended from it), so a
    // linked admin device cannot manage the devices some *other* device linked.
    setup([
      device('me-agent', { isMe: true, issuerAgentId: 'founder-agent' }),
      device('sibling-agent', { issuerAgentId: 'founder-agent' }),
    ]);
    openRow('sibling-agent');
    expect(within(sheet()).queryByTestId('device-change-role')).toBeNull();
    expect(within(sheet()).getByTestId('device-not-mine-note').textContent).toContain('linked this one');
  });

  it('lets the founder manage a device it did not directly link', () => {
    setup([
      device('me-agent', { isMe: true, isFounder: true }),
      device('other-agent', { issuerAgentId: 'some-other-device' }),
    ]);
    openRow('other-agent');
    // The founder issued every ancestor delegation, so it can revoke any of them.
    expect(within(sheet()).getByTestId('device-change-role')).toBeDefined();
    expect(within(sheet()).getByTestId('device-remove')).toBeDefined();
  });

  it('still offers management when the worker reports no issuer (stale bundle)', () => {
    // isFounder/issuerAgentId are optional: an old worker bundle omits them, and
    // that must degrade to "offer the action and let it fail" rather than hiding
    // management on every row.
    setup([ME, OTHER]);
    openRow('other-agent');
    expect(within(sheet()).getByTestId('device-change-role')).toBeDefined();
  });

  it('offers Reset name only once a name has been stored', () => {
    mockNames = { 'other-agent': 'Bob-phone' };
    setup([ME, device('other-agent', { name: 'Bob-phone' })]);

    openRow('Bob-phone');
    fireEvent.click(within(sheet()).getByTestId('device-reset-name'));
    expect(mockRemoveDeviceName).toHaveBeenCalledWith('other-agent');

    openRow('This device');
    expect(within(sheet()).queryByTestId('device-reset-name')).toBeNull();
  });
});

describe('DeviceList shared sheets', () => {
  it('routes a role change through the shared role picker', () => {
    setup([ME, OTHER]);
    openRow('other-agent');
    fireEvent.click(screen.getByTestId('device-change-role'));

    expect(screen.getByTestId('role-picker-sheet')).toBeDefined();
    fireEvent.click(screen.getByTestId('role-edit'));
    expect(onChangeRole).toHaveBeenCalledWith('other-agent', 'edit');
  });

  it('renames through the shared rename sheet', () => {
    setup([ME, OTHER]);
    openRow('other-agent');
    fireEvent.click(screen.getByTestId('device-rename'));

    fireEvent.input(screen.getByTestId('rename-input'), { target: { value: "Bob's phone" } });
    fireEvent.click(screen.getByTestId('rename-save'));
    expect(mockSetDeviceName).toHaveBeenCalledWith('other-agent', "Bob's phone");
  });

  it('confirms before removing a device', async () => {
    setup([ME, OTHER]);
    openRow('other-agent');
    fireEvent.click(screen.getByTestId('device-remove'));

    // The confirm is up and nothing has happened yet.
    expect(await screen.findByTestId('remove-device-confirm')).toBeDefined();
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    // The confirm resolves a promise, so the removal lands a microtask later.
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('other-agent'));
  });

  it('does not remove when the confirm is declined', async () => {
    setup([ME, OTHER]);
    openRow('other-agent');
    fireEvent.click(screen.getByTestId('device-remove'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe('DeviceList transport label', () => {
  const labels = () => screen.queryAllByTestId('device-transport').map(n => n.textContent);

  it('names the transport, not just reachability', () => {
    setup([ME, device('direct-agent'), device('relayed-agent'), device('gone-agent')], {
      'direct-agent': { online: true, transport: 'direct' },
      'relayed-agent': { online: true, transport: 'relay' },
    });
    // Own row shows no status; the rest report how they are reachable.
    expect(labels()).toEqual(['P2P', 'Via relay', 'Offline']);
  });

  it('shows nothing when connectivity is not supplied', () => {
    setup([ME, OTHER]);
    expect(labels()).toEqual([]);
  });
});
