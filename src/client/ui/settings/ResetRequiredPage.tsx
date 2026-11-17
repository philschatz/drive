/**
 * "Reset needed" — the whole app, on a device whose saved keyhive state was
 * written by an older version this build cannot read.
 *
 * The engine has booted neither keyhive nor the repo (see
 * src/shared/keyhive-format.ts and engine-recovery.ts), so there is no document
 * list, no settings and no sync to show: App renders this in place of the
 * router. Two things work here, and both wait for a tap:
 *
 *   Download backup    documents + settings, read straight from storage. This
 *                      is the copy to import after the reset.
 *   Reset this device  removes the old keys. Documents and the device key stay
 *                      on disk; the app reloads onto Settings → Data Backup.
 *
 * The download is deliberately NOT a hard gate on the reset: a second device
 * that will simply be re-linked has nothing it needs to keep. The confirmation
 * says so plainly when documents exist and none were downloaded this session.
 */
import { useState } from 'preact/hooks';
import { showToast, showError } from '@/components/ui/toast';
import { useConfirm } from '../common/ConfirmSheet';
import { exportLegacyBackup, resetKeyhive } from '../worker-api';
import type { ResetRequiredInfo } from '../../shared/worker-client';
import { SettingsGroup, SettingsProse } from './SettingsGroup';
import { downloadBackupFile } from './backup-download';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function ResetRequiredPage({ info }: { info: ResetRequiredInfo }) {
  const { confirm, confirmSheet } = useConfirm();
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDownload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { payload, unreadable } = await exportLegacyBackup();
      downloadBackupFile(payload, 'backup');
      setDownloaded(true);
      const saved = `Saved ${plural(payload.docs?.length ?? 0, 'document')}.`;
      if (unreadable.length) showError(`${saved} ${unreadable.length} could not be read: ${unreadable.join(', ')}`);
      else showToast(saved);
    } catch (err: any) {
      showError('Backup failed: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    const unsaved = info.docCount > 0 && !downloaded;
    if (!await confirm({
      title: 'Reset this device?',
      body: (
        <>
          <p>
            The document list is emptied and this device is unlinked from your other devices
            and friends. This can't be undone.
          </p>
          {unsaved && <p className="mt-2"><strong>You haven't downloaded a backup.</strong></p>}
        </>
      ),
      confirmLabel: 'Reset device',
      confirmIcon: 'restart_alt',
      destructive: true,
      'data-testid': 'confirm-reset-device',
    })) return;
    setBusy(true);
    try {
      await resetKeyhive(); // reloads every tab on success
    } catch (err: any) {
      showError('Reset failed: ' + err.message);
      setBusy(false);
    }
  };

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8" data-testid="reset-required">
      {/* No back or close control: there is nowhere else in the app to go. */}
      <div className="flex items-center gap-1.5 pl-4 min-h-14">
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Reset needed</h1>
      </div>

      <SettingsProse>
        This update can't read the sharing keys saved by the previous version. Your documents
        are still on this device. Download a backup, reset, then import it in Settings → Data
        Backup. You'll need to link your other devices and add friends again.
      </SettingsProse>
      <SettingsProse>
        Already restored on another device? Skip the backup: reset, then link this device.
      </SettingsProse>

      <SettingsGroup label="This device">
        <md-list-item type="button" data-testid="reset-download-backup" onClick={handleDownload}>
          <md-icon slot="start">download</md-icon>
          <div slot="headline">Download backup</div>
          <div slot="supporting-text">{plural(info.docCount, 'document')} and your settings</div>
        </md-list-item>
        <md-list-item type="button" data-testid="reset-device" onClick={handleReset}>
          <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>restart_alt</md-icon>
          <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Reset this device</div>
          <div slot="supporting-text">Removes the old keys. Documents stay on this device.</div>
        </md-list-item>
      </SettingsGroup>

      {confirmSheet}
    </div>
  );
}
