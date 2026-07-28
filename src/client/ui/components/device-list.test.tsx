/**
 * DeviceList: the role controls and the per-device transport label.
 *
 * The rule worth pinning is that your OWN device's role is never editable —
 * self-demotion from admin is unrecoverable from this screen, so the control is
 * not offered at all rather than being guarded by a confirm.
 */
import { render, screen, within } from '@testing-library/preact';
import { DeviceList } from './DeviceList';

jest.mock('../worker-api', () => ({
  usePeerTransports: () => ({}),
  onDeviceNamesUpdated: () => () => {},
}));

const device = (agentId: string, extra: Record<string, any> = {}) =>
  ({ agentId, role: 'admin', isMe: false, ...extra }) as any;

const ME = device('me-agent', { isMe: true });
const OTHER = device('other-agent');

const noop = () => {};
const roleSelect = (row: HTMLElement) => within(row).queryByRole('combobox');

function setup(devices: any[], statuses?: Record<string, any>) {
  render(<DeviceList devices={devices} onRemove={noop} onChangeRole={noop} statuses={statuses} />);
}

describe('DeviceList roles', () => {
  it('does not let an admin change its OWN role', () => {
    setup([ME, OTHER]);
    const rows = document.querySelectorAll('div.border-b');
    // Two rows, but only one role Select — and it is not on the "This device" row.
    expect(rows).toHaveLength(2);
    expect(screen.queryAllByRole('combobox')).toHaveLength(1);

    const myRow = [...rows].find(r => r.textContent?.includes('This device')) as HTMLElement;
    expect(roleSelect(myRow)).toBeNull();
    expect(within(myRow).getByText('admin')).toBeDefined(); // static label instead
  });

  it('offers no role control at all to a non-admin device', () => {
    setup([device('me-agent', { isMe: true, role: 'read' }), OTHER]);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('never offers to remove your own device', () => {
    setup([ME, OTHER]);
    expect(screen.queryAllByTitle('Remove device')).toHaveLength(1);
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
