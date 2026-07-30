/**
 * The four action-only settings sections: Storage, Backup, Danger Zone, Developer.
 * Grouped because they share one mock preamble and each contributes a couple of
 * assertions.
 *
 * The most valuable case here is Storage's probe-before-ask ordering: adopting an
 * already-reachable synced settings doc must NOT raise the scary "this is permanent"
 * question, because only *creating* one is the irreversible step. That ordering is
 * documented in StorageSettings but nothing pinned it until now.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

let mockReachable: string | null;
let mockEnableSettingsSync: jest.Mock;
let mockDeleteAllData: jest.Mock;
let mockIdentity: { deviceId: string; userGroupId: string | null };
let mockShowToast: jest.Mock;
let mockShowError: jest.Mock;

jest.mock('../../worker-api', () => ({
  getReachableSettingsDoc: () => Promise.resolve(mockReachable),
  enableSettingsSync: (...args: any[]) => mockEnableSettingsSync(...args),
  deleteAllData: (...args: any[]) => mockDeleteAllData(...args),
}));

jest.mock('../../common/keyhive-api', () => ({
  getIdentity: () => Promise.resolve(mockIdentity),
}));

jest.mock('../../../shared/idb-storage', () => ({
  idbGet: () => Promise.resolve(null), // no settings-doc pointer → LOCAL mode
  idbSet: () => Promise.resolve(),
  KEYS: { driveSettings: 'settings:drive-settings', docIds: 'data:doc-ids' },
}));

jest.mock('../../friend-names', () => ({
  getAllFriendNames: () => ({}),
  setFriendName: () => Promise.resolve(),
}));
jest.mock('../../device-names', () => ({
  getAllDeviceNames: () => ({}),
  setDeviceName: () => Promise.resolve(),
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

import { StorageSettings } from './StorageSettings';
import { BackupSettings } from './BackupSettings';
import { DangerZone } from './DangerZone';

beforeEach(() => {
  mockReachable = null;
  mockEnableSettingsSync = jest.fn(() => Promise.resolve());
  mockDeleteAllData = jest.fn(() => Promise.resolve());
  mockIdentity = { deviceId: 'device-1', userGroupId: 'group-1' };
  mockShowToast = jest.fn();
  mockShowError = jest.fn();
  // Not stubbing window.location: neither it nor `reload` is redefinable in this
  // jsdom build. The success paths call reload(), which jsdom reports as
  // "Not implemented: navigation" on the virtual console rather than throwing — so
  // it is noise in the output, not a failure.
});

describe('StorageSettings', () => {
  it('confirms before CREATING a synced settings doc', async () => {
    render(<StorageSettings />);
    fireEvent.click(await screen.findByTestId('storage-enable-sync'));

    expect(await screen.findByTestId('confirm-enable-sync')).toBeDefined();
    expect(mockEnableSettingsSync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(mockEnableSettingsSync).toHaveBeenCalled());
  });

  it('adopts an already-reachable doc with NO confirmation', async () => {
    mockReachable = 'existing-settings-doc';
    render(<StorageSettings />);
    fireEvent.click(await screen.findByTestId('storage-enable-sync'));

    // Adopting is not the irreversible step, so no scary question.
    await waitFor(() => expect(mockEnableSettingsSync).toHaveBeenCalled());
    expect(screen.queryByTestId('confirm-enable-sync')).toBeNull();
  });

  it('does not enable sync when the confirmation is declined', async () => {
    render(<StorageSettings />);
    fireEvent.click(await screen.findByTestId('storage-enable-sync'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));

    await waitFor(() => expect(screen.queryByTestId('confirm-enable-sync')).toBeNull());
    expect(mockEnableSettingsSync).not.toHaveBeenCalled();
  });

  it('disables the row and says why when there is no user group', async () => {
    mockIdentity = { deviceId: 'device-1', userGroupId: null };
    render(<StorageSettings />);

    const row = await screen.findByTestId('storage-enable-sync');
    await waitFor(() => expect(row.getAttribute('disabled')).not.toBeNull());
    expect(row.textContent).toContain('Add a friend or link a device first');
  });
});

describe('DangerZone', () => {
  it('erases only after the destructive confirmation', async () => {
    render(<DangerZone />);
    fireEvent.click(screen.getByTestId('danger-delete-all'));

    expect(await screen.findByTestId('confirm-delete-all')).toBeDefined();
    expect(mockDeleteAllData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(mockDeleteAllData).toHaveBeenCalled());
  });

  it('erases nothing when declined', async () => {
    render(<DangerZone />);
    fireEvent.click(screen.getByTestId('danger-delete-all'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-delete-all')).toBeNull());
    expect(mockDeleteAllData).not.toHaveBeenCalled();
  });

  it('error-tones the row itself, both glyph and label', () => {
    render(<DangerZone />);
    const row = screen.getByTestId('danger-delete-all');
    expect([...row.children].filter(el =>
      (el as HTMLElement).style.color === 'var(--md-sys-color-error)')).toHaveLength(2);
  });
});

describe('BackupSettings', () => {
  it('confirms an export with a snackbar', async () => {
    // The handler builds a detached <a download> and clicks it.
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    (URL as any).createObjectURL = jest.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = jest.fn();

    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-export'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Data exported.'));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('reports an export failure as an error snackbar', async () => {
    (URL as any).createObjectURL = jest.fn(() => { throw new Error('no blobs'); });
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-export'));

    await waitFor(() => expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('no blobs')));
  });
});

// The Open-link form moved into DebuggingSettings, and so did its tests — see
// debugging-settings.test.tsx.
