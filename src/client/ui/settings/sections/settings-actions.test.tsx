/**
 * The action-only settings sections: Storage and Backup (which now also hosts the
 * Danger Zone rows). Grouped because they share one mock preamble and each
 * contributes a couple of assertions.
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
let mockExportBackup: jest.Mock;
let mockImportBackup: jest.Mock;
let mockExportLegacyBackup: jest.Mock;
let mockPreResetInfo: { docCount: number; resetAt: string } | null;
let mockIdentity: { deviceId: string; userGroupId: string | null };
let mockShowToast: jest.Mock;
let mockShowError: jest.Mock;
let capturedInputs: HTMLInputElement[];

jest.mock('../../worker-api', () => ({
  getReachableSettingsDoc: () => Promise.resolve(mockReachable),
  enableSettingsSync: (...args: any[]) => mockEnableSettingsSync(...args),
  deleteAllData: (...args: any[]) => mockDeleteAllData(...args),
  exportBackup: (...args: any[]) => mockExportBackup(...args),
  importBackup: (...args: any[]) => mockImportBackup(...args),
  exportLegacyBackup: (...args: any[]) => mockExportLegacyBackup(...args),
  getPreResetInfo: () => Promise.resolve(mockPreResetInfo),
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

beforeEach(() => {
  mockReachable = null;
  mockEnableSettingsSync = jest.fn(() => Promise.resolve());
  mockDeleteAllData = jest.fn(() => Promise.resolve());
  mockExportBackup = jest.fn(() =>
    Promise.resolve({ format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x' }));
  mockImportBackup = jest.fn(() => Promise.resolve({ imported: 0, skipped: [], reload: false }));
  mockExportLegacyBackup = jest.fn(() => Promise.resolve({
    payload: { format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x', docs: [{}, {}] },
    unreadable: [],
  }));
  mockPreResetInfo = null;
  mockIdentity = { deviceId: 'device-1', userGroupId: 'group-1' };
  mockShowToast = jest.fn();
  mockShowError = jest.fn();
  capturedInputs = [];
  // Not stubbing window.location: neither it nor `reload` is redefinable in this
  // jsdom build (`reload` is writable:false/configurable:false and `location`
  // itself is configurable:false, so jest.spyOn throws). The success paths call
  // reload(), which jsdom reports as "Not implemented: navigation" on the virtual
  // console rather than throwing — not a failure. That line is swallowed by the
  // benign-log filter (tests/support/benign-logs.ts); it needs duck-typing rather
  // than `instanceof Error`, because jsdom builds the error in its own realm.
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

describe('BackupSettings danger zone', () => {
  it('erases only after the destructive confirmation', async () => {
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('danger-delete-all'));

    expect(await screen.findByTestId('confirm-delete-all')).toBeDefined();
    expect(mockDeleteAllData).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(mockDeleteAllData).toHaveBeenCalled());
  });

  it('erases nothing when declined', async () => {
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('danger-delete-all'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-delete-all')).toBeNull());
    expect(mockDeleteAllData).not.toHaveBeenCalled();
  });

  it('error-tones the row itself, both glyph and label', () => {
    render(<BackupSettings />);
    const row = screen.getByTestId('danger-delete-all');
    expect([...row.children].filter(el =>
      (el as HTMLElement).style.color === 'var(--md-sys-color-error)')).toHaveLength(2);
  });
});

describe('BackupSettings pre-upgrade export', () => {
  it('is absent on a device that never went through a keyhive reset', async () => {
    render(<BackupSettings />);
    // Let the pre-reset probe settle before asserting absence.
    await waitFor(() => expect(screen.getByTestId('backup-export-snapshot')).toBeDefined());
    await Promise.resolve();
    expect(screen.queryByTestId('backup-export-pre-upgrade')).toBeNull();
  });

  it('offers the documents a reset left on disk, and downloads them', async () => {
    mockPreResetInfo = { docCount: 2, resetAt: '2026-11-16T00:00:00.000Z' };
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    (URL as any).createObjectURL = jest.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = jest.fn();
    render(<BackupSettings />);

    const row = await screen.findByTestId('backup-export-pre-upgrade');
    expect(row.textContent).toMatch(/2 documents from before this device was reset/);
    fireEvent.click(row);

    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(mockExportLegacyBackup).toHaveBeenCalledTimes(1);
    expect(mockExportBackup).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith('Saved 2 documents.');
    click.mockRestore();
  });
});

describe('BackupSettings', () => {
  // BackupSettings builds its file input imperatively and clicks it, so tests
  // capture that input via a click spy, then feed it a fake file through change.
  const captureFileInput = () => {
    jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      capturedInputs.push(this);
    });
  };
  const selectFile = (input: HTMLInputElement, content: string) => {
    const file = { text: jest.fn(() => Promise.resolve(content)) };
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
  };

  it('exports documents & settings and shows a snackbar', async () => {
    // The handler builds a detached <a download> and clicks it.
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    (URL as any).createObjectURL = jest.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = jest.fn();

    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-export-snapshot'));

    await waitFor(() => expect(mockExportBackup).toHaveBeenCalledWith(['docs', 'settings']));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Backup exported.'));
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('warns before restoring a pre-reset snapshot that its friends cannot come back', async () => {
    // The engine drops friends keyed by pre-reset group ids. The restore
    // reloads the page, so the only place to say so is the confirmation.
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], JSON.stringify({
      format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x', docs: [],
      settings: { friends: { ['A'.repeat(43) + '=']: 'Alice' } },   // no `keyhive` tag = pre-reset
    }));
    const sheet = await screen.findByTestId('confirm-backup-snapshot-import');
    expect(sheet.textContent).toMatch(/friends list\s+can't be restored/);
  });

  it('says nothing about friends for a snapshot from this keyhive generation', async () => {
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], JSON.stringify({
      format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x', docs: [], keyhive: 2,
      settings: { friends: { ['A'.repeat(43) + '=']: 'Alice' } },
    }));
    await screen.findByTestId('confirm-backup-snapshot-import');
    expect(screen.queryByTestId('backup-import-stale-friends')).toBeNull();
  });

  it('confirms the full export (it contains keys) before exporting', async () => {
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-export-full'));

    expect(await screen.findByTestId('confirm-backup-full-export')).toBeDefined();
    expect(mockExportBackup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(mockExportBackup).toHaveBeenCalledWith(['full']));
  });

  it('imports a snapshot backup after its confirm', async () => {
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], JSON.stringify({
      format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x', docs: [],
    }));

    expect(await screen.findByTestId('confirm-backup-snapshot-import')).toBeDefined();
    expect(mockImportBackup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() => expect(mockImportBackup).toHaveBeenCalled());
    expect(mockImportBackup.mock.calls[0][0].kind).toBe('snapshot');
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Backup restored.'));
  });

  it('imports a full backup only through the destructive confirm', async () => {
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], JSON.stringify({
      format: 'drive-backup', version: 1, kind: 'full', exportedAt: 'x',
    }));

    expect(await screen.findByTestId('confirm-backup-full-import')).toBeDefined();
    fireEvent.click(screen.getByTestId('confirm-accept'));
    await waitFor(() =>
      expect(mockImportBackup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'full' })));
  });

  it('declines an import and restores nothing', async () => {
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], JSON.stringify({
      format: 'drive-backup', version: 1, kind: 'snapshot', exportedAt: 'x',
    }));

    await screen.findByTestId('confirm-backup-snapshot-import');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-backup-snapshot-import')).toBeNull());
    expect(mockImportBackup).not.toHaveBeenCalled();
  });

  it('rejects a file that is not a backup', async () => {
    captureFileInput();
    render(<BackupSettings />);
    fireEvent.click(screen.getByTestId('backup-import'));
    selectFile(capturedInputs[0], '{ nope');

    await waitFor(() => expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining('Import failed')));
    expect(mockImportBackup).not.toHaveBeenCalled();
  });
});

// The Open-link form moved into DebuggingSettings, and so did its tests — see
// debugging-settings.test.tsx.
