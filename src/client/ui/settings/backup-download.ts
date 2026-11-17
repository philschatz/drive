/**
 * Hand a backup payload to the browser as a `.json` download.
 *
 * The anchor is built imperatively and clicked in the same task as the caller's
 * gesture handling — a permanently-mounted hidden element would be a stray
 * focusable node, and browsers ignore a programmatic download that is not tied
 * to a user gesture.
 */
import { serializeBackup, type BackupPayload } from '../../../shared/backup';

export function downloadBackupFile(payload: BackupPayload, label: string): void {
  const blob = new Blob([serializeBackup(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `drive-${label}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
