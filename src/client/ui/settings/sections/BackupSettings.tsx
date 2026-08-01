/**
 * Data Backup — tiered export/import of documents, settings, and (full tier)
 * identity keys.
 *
 * Layout: two exports + one import.
 *   - "Export documents & settings" → `exportBackup(['docs','settings'])` — a
 *     snapshot of every document's current state + the DriveSettings surface.
 *   - "Export full device backup" → `exportBackup(['full'])` — every kv pair and
 *     automerge/keyhive chunk, i.e. a device-migration backup that includes the
 *     identity keys. Confirmed first because it contains keys.
 *   - "Import backup" → a file input that auto-detects the tier (snapshot / full),
 *     confirms the matching restore, and reloads.
 *
 * All handlers build their file element imperatively and `.click()` it rather
 * than rendering one: the click has to happen in the same task as the user's
 * gesture, and a permanently-mounted hidden `<input type="file">` would be a
 * stray focusable node sitting in a list.
 */
import { showToast, showError } from '@/components/ui/toast';
import { useConfirm } from '../../common/ConfirmSheet';
import { exportBackup, importBackup } from '../../worker-api';
import { parseBackup, serializeBackup, type BackupTier } from '../../../../shared/backup';
import { SettingsGroup, SettingsProse } from '../SettingsGroup';

export function BackupSettings() {
  const { confirm, confirmSheet } = useConfirm();

  const doExport = async (tiers: BackupTier[], label: string): Promise<void> => {
    const payload = await exportBackup(tiers);
    const text = serializeBackup(payload);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drive-${label}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported.');
  };

  const handleExportSnapshot = async () => {
    try {
      await doExport(['docs', 'settings'], 'backup');
    } catch (err: any) {
      showError('Export failed: ' + err.message);
    }
  };

  const handleExportFull = async () => {
    if (!await confirm({
      title: 'Export full device backup?',
      body: (
        <p>
          The file contains your identity keys and every document. Anyone who gets it can
          read your data, so store it somewhere safe.
        </p>
      ),
      confirmLabel: 'Export backup',
      confirmIcon: 'download',
      'data-testid': 'confirm-backup-full-export',
    })) return;
    try {
      await doExport(['full'], 'full-backup');
    } catch (err: any) {
      showError('Export failed: ' + err.message);
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = parseBackup(await file.text());
        if (parsed.kind === 'invalid') throw new Error(parsed.error);

        const ok = parsed.kind === 'full'
          ? await confirm({
              title: 'Restore full device backup?',
              body: <p>Replaces ALL local data — your keys, documents, and settings — with the backup's contents, then reloads.</p>,
              confirmLabel: 'Restore backup',
              confirmIcon: 'restore',
              destructive: true,
              'data-testid': 'confirm-backup-full-import',
            })
          : await confirm({
              title: 'Restore documents & settings?',
              body: <p>Recreates your documents and merges your settings. This device's identity is kept; on a fresh device a new user group is created.</p>,
              confirmLabel: 'Restore',
              confirmIcon: 'restore',
              'data-testid': 'confirm-backup-snapshot-import',
            });
        if (!ok) return;

        const result = await importBackup(parsed.payload);
        showToast('Backup restored.');
        if (result.reload) window.location.reload();
      } catch (err: any) {
        showError('Import failed: ' + err.message);
      }
    };
    input.click();
  };

  return (
    <>
      <SettingsProse>
        Export a snapshot of your documents and settings, or a full device backup that also
        includes your identity keys (for moving to a new device). Imports restore the matching
        tier — the file kind is detected automatically.
      </SettingsProse>

      <SettingsGroup label="Export">
        <md-list-item type="button" data-testid="backup-export-snapshot" onClick={handleExportSnapshot}>
          <md-icon slot="start">download</md-icon>
          <div slot="headline">Export documents &amp; settings</div>
          <div slot="supporting-text">Current versions of your documents plus friends and devices</div>
        </md-list-item>
        <md-list-item type="button" data-testid="backup-export-full" onClick={handleExportFull}>
          <md-icon slot="start">key</md-icon>
          <div slot="headline">Export full device backup</div>
          <div slot="supporting-text">Everything, including your identity keys — for moving devices</div>
        </md-list-item>
      </SettingsGroup>

      <SettingsGroup label="Import">
        <md-list-item type="button" data-testid="backup-import" onClick={handleImport}>
          <md-icon slot="start">upload</md-icon>
          <div slot="headline">Import backup</div>
          <div slot="supporting-text">Restores a documents/settings or full device backup, then reloads</div>
        </md-list-item>
      </SettingsGroup>

      {confirmSheet}
    </>
  );
}
