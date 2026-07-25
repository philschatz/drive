/**
 * Settings page — device management and identity info.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DeviceList } from '@/components/DeviceList';
import { ScanQrButton } from '@/components/ScanQrButton';
import { AddFriendSheet } from './AddFriendSheet';
import { AddDeviceSheet } from './AddDeviceSheet';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  getIdentity,
  ensureUserGroup,
  type IdentityInfo,
} from '../shared/keyhive-api';
import { useDevices, useDeviceStatuses } from '../shared/use-devices';
import { setDebugEnabled, clearAllCaches, deleteAllData, enableSettingsSync, getReachableSettingsDoc } from '../worker-api';
import { idbGet, idbSet, isDebugEnabled, KEYS } from '../idb-storage';
import { getContactName, setContactName, getAllContactNames } from '../contact-names';
import { getAllDeviceNames, setDeviceName } from '../device-names';
import { sourceUrl } from '../shared/doc-urls';
import { navigateToUrlOrHash } from '../shared/navigate-url';
export function Settings({ path }: { path?: string }) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  // The last persisted name, to skip no-op saves (e.g. a blur with no change, which
  // would otherwise create a user group from an accidental focus).
  const [savedName, setSavedName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [debugEnabled] = useState(isDebugEnabled());
  // Automerge docId of the synced DriveSettings doc when in SHARED mode; null in LOCAL
  // mode (where KEYS.driveSettings holds the settings blob object, not a docId string).
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);

  // The device list, its live refresh, and removal are owned by the shared hook.
  const { devices, removeDevice, changeDeviceRole } = useDevices({ onError: setError, onMessage: setMessage });
  const deviceStatuses = useDeviceStatuses();

  const refresh = useCallback(async () => {
    try {
      const id = await getIdentity();
      setIdentity(id);
      // Your name is stored as a User Group contact (keyed by user-group id), not by device.
      const name = (id.userGroupId && getContactName(id.userGroupId)) || '';
      setDisplayName(name);
      setSavedName(name);
      // KEYS.driveSettings holds a docId string (SHARED) or a blob object (LOCAL);
      // only a string is a real settings-doc pointer.
      const settingsVal = await idbGet<unknown>(KEYS.driveSettings);
      setSettingsDocId(typeof settingsVal === 'string' ? settingsVal : null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Save your name as a User Group contact, creating the user group if it doesn't
  // exist yet (so the name has a stable, share-able identity to attach to).
  const handleSaveName = async () => {
    // No-op if unchanged — avoids creating a user group from an accidental blur.
    if (displayName.trim() === savedName) return;
    setSavingName(true);
    try {
      const { userGroupId } = await ensureUserGroup({ create: true });
      if (!userGroupId) throw new Error('Could not create your user group.');
      await setContactName(userGroupId, displayName.trim());
      setMessage('Name saved.');
      await refresh();
    } catch (err: any) {
      setError('Failed to save name: ' + err.message);
    } finally {
      setSavingName(false);
    }
  };

  const handleToggleDebug = async (v: boolean) => {
    try {
      await setDebugEnabled(v); // persists, tells worker, then reloads the page
    } catch (err: any) {
      setError('Failed to update debug setting: ' + err.message);
    }
  };

  const handleEnableSync = async () => {
    setError('');
    // Probe FIRST (before any prompt): if a synced settings doc already exists and
    // is reachable, just adopt it — no scary "this is permanent" confirmation. Only
    // CREATING a brand-new synced doc is the irreversible step worth confirming.
    let existing: string | null = null;
    try {
      existing = await getReachableSettingsDoc();
    } catch { /* fall through to the confirm+create path */ }
    if (!existing && !window.confirm(
      'Sync your settings (contacts, device names, seen state) across your devices?\n\n' +
      "This is permanent — synced settings can't be made device-only again.",
    )) return;
    setSyncing(true);
    try {
      await enableSettingsSync(); // adopts the existing reachable doc, else creates + migrates
      window.location.reload();
    } catch (err: any) {
      setError('Could not enable settings sync: ' + (err.message ?? err));
      setSyncing(false);
    }
  };

  const handleClearCaches = async () => {
    try {
      await clearAllCaches(); // clears caches, then reloads the page
    } catch (err: any) {
      setError('Failed to clear caches: ' + err.message);
    }
  };

  const handleDeleteAllData = async () => {
    if (!confirm('Permanently erase ALL local data — every document, your identity/keys, contacts, and settings? Documents not shared with another device are lost forever. This cannot be undone.')) return;
    try {
      await deleteAllData(); // terminates the worker, deletes all IndexedDB + localStorage, reloads
    } catch (err: any) {
      setError('Failed to delete data: ' + err.message);
    }
  };

  const handleExport = async () => {
    try {
      // Contact/device names now live in the synced DriveSettings doc; read them
      // from the worker-hydrated caches. docList stays a device-local hint.
      const docList = await idbGet<unknown[]>(KEYS.docIds).then(v => v ?? []);
      const contactNames = getAllContactNames();
      const deviceNames = getAllDeviceNames();
      const payload = { version: 1, exportedAt: new Date().toISOString(), docList, contactNames, deviceNames };
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
        if (!payload || payload.version !== 1) throw new Error('Invalid backup file (wrong version).');
        if (!Array.isArray(payload.docList)) throw new Error('Invalid backup: docList must be an array.');
        if (typeof payload.contactNames !== 'object' || Array.isArray(payload.contactNames))
          throw new Error('Invalid backup: contactNames must be an object.');
        // Legacy backups may carry an `invites` field — it's no longer used, so ignore it.
        // `deviceNames` was added later; older backups omit it, so default to {}.
        const deviceNames: Record<string, string> = (payload.deviceNames && typeof payload.deviceNames === 'object' && !Array.isArray(payload.deviceNames))
          ? payload.deviceNames : {};
        await idbSet(KEYS.docIds, payload.docList);
        // Contact/device names live in the synced DriveSettings doc now — restore
        // them through the worker so they land in (and re-sync from) that document.
        await Promise.all([
          ...Object.entries(payload.contactNames as Record<string, string>).map(([id, name]) => setContactName(id, name)),
          ...Object.entries(deviceNames).map(([id, name]) => setDeviceName(id, name)),
        ]);
        window.location.reload();
      } catch (err: any) {
        setError('Import failed: ' + err.message);
      }
    };
    input.click();
  };

  const handleNavigateUrl = () => {
    const err = navigateToUrlOrHash(linkUrl);
    if (err) setError(`Invalid URL — ${err.toLowerCase()}`);
  };

  return (
    <div className="max-w-screen-md mx-auto p-4">
      <div className="flex items-center gap-2 mb-4">
        <a
          href="#/"
          className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </a>
        <h1 className="text-2xl font-bold">Settings</h1>
        <ScanQrButton className="ml-auto" onError={setError} />
      </div>

      {message && (
        <Alert variant="success" className="mb-2 flex items-center justify-between">
          <span>{message}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setMessage('')}>&times;</button>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}

      {/* Identity */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Identity</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : identity ? (
          <div className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">User Group ID:</span>
              {identity.userGroupId ? (
                <code
                  className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer"
                  title={`${identity.userGroupId} (click to copy)`}
                  onClick={() => navigator.clipboard.writeText(identity.userGroupId!)}
                >
                  {identity.userGroupId.slice(0, 16)}...
                </code>
              ) : (
                <span className="text-xs text-muted-foreground italic">
                  Not created yet — add a friend or add a device
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Device ID:</span>
              <code
                className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer"
                title={`${identity.deviceId} (click to copy)`}
                onClick={() => navigator.clipboard.writeText(identity.deviceId)}
              >
                {identity.deviceId.slice(0, 16)}...
              </code>
            </div>
            {settingsDocId && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Shared Settings:</span>
                <a
                  href={sourceUrl(settingsDocId)}
                  className="text-xs font-mono text-primary underline underline-offset-2"
                  title="View / edit your shared settings (contacts, device names, seen state)"
                >
                  {settingsDocId.slice(0, 16)}…
                </a>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Keyhive not available.</p>
        )}
      </section>

      {/* Your name */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Your Name</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Set the name friends see when you share with them. Saving creates your user group
          if you don't have one yet.
        </p>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-sm p-2 rounded border border-border"
            value={displayName}
            onInput={(e: any) => setDisplayName(e.currentTarget.value)}
            onBlur={handleSaveName}
            onKeyDown={(e: any) => { if (e.key === 'Enter') handleSaveName(); }}
            placeholder="Your name (optional)"
          />
          <Button size="sm" onClick={handleSaveName} disabled={savingName}>
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddFriendOpen(true)}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>person_add</span>
            Add Friend
          </Button>
        </div>
      </section>

      {/* Devices */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Devices</h2>
        <DeviceList devices={devices} onRemove={removeDevice} onChangeRole={changeDeviceRole} statuses={deviceStatuses} />

        {/* Link another device — opens the linking sheet */}
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => setAddDeviceOpen(true)}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>devices</span>
            Link Device
          </Button>
        </div>
      </section>

      {/* Settings storage — Local (default) vs Shared (one-way opt-in) */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Settings Storage</h2>
        {settingsDocId ? (
          <p className="text-xs text-muted-foreground">
            Your settings (contacts, device names, seen state) are{' '}
            <strong>synced across your devices</strong>. See the “Shared Settings” link in the
            Identity section above to inspect them.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              Your settings are stored <strong>only on this device</strong>. You can sync them across
              your devices — this is <strong>permanent</strong> and can’t be undone.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleEnableSync}
              disabled={syncing || !identity?.userGroupId}
              title={identity?.userGroupId ? undefined : 'Add a contact or link a device first to enable synced settings'}
            >
              {syncing ? 'Enabling…' : 'Sync settings across devices'}
            </Button>
            {!identity?.userGroupId && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Add a contact or link a device first to enable synced settings.
              </p>
            )}
          </>
        )}
      </section>

      {/* Navigate to URL */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Developer: Open Link</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Paste a link to navigate to it (e.g. document or add-friend links).
        </p>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-sm p-2 rounded border border-border font-mono"
            value={linkUrl}
            onInput={(e: any) => setLinkUrl(e.currentTarget.value)}
            placeholder="Paste URL here..."
          />
          <Button size="sm" onClick={handleNavigateUrl} disabled={!linkUrl.trim()}>
            Go
          </Button>
        </div>
      </section>

      {/* Data Backup */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Data Backup</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Export or import your document list and contacts.
          This does not include document contents (those sync via Automerge).
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleExport}>Export</Button>
          <Button size="sm" variant="outline" onClick={handleImport}>Import</Button>
        </div>
      </section>

      {/* Debugging */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Debugging</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Enabling debug mode bypasses all caches (always reading live data) and logs every
          keyhive/WASM call to the console — and names the last calls on the crash banner if the
          document engine traps. The page reloads when you change this.
        </p>
        <div className="flex items-center gap-2 mb-3">
          <Switch
            id="debug-mode"
            checked={debugEnabled}
            onCheckedChange={handleToggleDebug}
          />
          <Label htmlFor="debug-mode" className="cursor-pointer">Enable debugging (and disable cache)</Label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="destructive" onClick={handleClearCaches}>Clear Caches</Button>
          {/* The status chip in the app bars opens a peers sheet now; the full
              connection-debug page lives here. */}
          <a href="#/connection">
            <Button size="sm" variant="outline">
              <span className="material-symbols-outlined">network_check</span> Connection details
            </Button>
          </a>
        </div>
      </section>

      {/* Danger zone */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Danger Zone</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Permanently erase all local data — every document, your identity/keys, contacts, and
          settings — then reload as a fresh install. Documents not shared with another device are
          lost forever. Use this to recover from a corrupted local state.
        </p>
        <Button size="sm" variant="destructive" onClick={handleDeleteAllData}>
          Delete All Data
        </Button>
      </section>

      <AddFriendSheet open={addFriendOpen} onOpenChange={setAddFriendOpen} />
      <AddDeviceSheet open={addDeviceOpen} onOpenChange={setAddDeviceOpen} />
    </div>
  );
}
