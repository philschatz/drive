/**
 * Data Backup — export/import of the doc list and contact/device names.
 * Extracted 1:1 from the old single-page Settings.
 */
import { Button } from '@/components/ui/button';
import { idbGet, idbSet, KEYS } from '../../../idb-storage';
import { getAllFriendNames, setFriendName } from '../../friend-names';
import { getAllDeviceNames, setDeviceName } from '../../device-names';
import { useSectionAlerts } from '../SettingsSubScreen';

export function BackupSettings() {
  const { alerts, setMessage, setError } = useSectionAlerts();

  const handleExport = async () => {
    try {
      // Contact/device names now live in the synced DriveSettings doc; read them
      // from the worker-hydrated caches. docList stays a device-local hint.
      const docList = await idbGet<unknown[]>(KEYS.docIds).then(v => v ?? []);
      const friendNames = getAllFriendNames();
      const deviceNames = getAllDeviceNames();
      const payload = { version: 2, exportedAt: new Date().toISOString(), docList, friendNames, deviceNames };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `drive-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage('Data exported successfully.');
    } catch (err: any) {
      setError('Export failed: ' + err.message);
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
        const text = await file.text();
        const payload = JSON.parse(text);
        if (!payload || (payload.version !== 1 && payload.version !== 2))
          throw new Error('Invalid backup file (wrong version).');
        if (!Array.isArray(payload.docList)) throw new Error('Invalid backup: docList must be an array.');
        // v1 called this `contactNames`; v2 renamed it to `friendNames`. Accept
        // either so backups taken before the rename still restore.
        const friendNames = payload.friendNames ?? payload.contactNames;
        if (typeof friendNames !== 'object' || Array.isArray(friendNames))
          throw new Error('Invalid backup: friendNames must be an object.');
        // Legacy backups may carry an `invites` field — it's no longer used, so ignore it.
        // `deviceNames` was added later; older backups omit it, so default to {}.
        const deviceNames: Record<string, string> = (payload.deviceNames && typeof payload.deviceNames === 'object' && !Array.isArray(payload.deviceNames))
          ? payload.deviceNames : {};
        await idbSet(KEYS.docIds, payload.docList);
        // Friend/device names live in the synced DriveSettings doc now — restore
        // them through the worker so they land in (and re-sync from) that document.
        await Promise.all([
          ...Object.entries(friendNames as Record<string, string>).map(([id, name]) => setFriendName(id, name)),
          ...Object.entries(deviceNames).map(([id, name]) => setDeviceName(id, name)),
        ]);
        window.location.reload();
      } catch (err: any) {
        setError('Import failed: ' + err.message);
      }
    };
    input.click();
  };

  return (
    <>
      {alerts}
      <section className="mb-6">
        <p className="text-xs text-muted-foreground mb-2">
          Export or import your document list and friends.
          This does not include document contents (those sync via Automerge).
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleExport}>Export</Button>
          <Button size="sm" variant="outline" onClick={handleImport}>Import</Button>
        </div>
      </section>
    </>
  );
}
