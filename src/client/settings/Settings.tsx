/**
 * Settings page — device management and identity info.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DeviceList } from '@/components/DeviceList';
import { QrScanner } from '@/components/QrScanner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  getIdentity,
  ensureUserGroup,
  type IdentityInfo,
} from '../shared/keyhive-api';
import { useDevices, useDeviceStatuses } from '../shared/use-devices';
import { setDebugEnabled, clearAllCaches, deleteAllData } from '../worker-api';
import { idbGet, idbSet, isDebugEnabled, KEYS } from '../idb-storage';
import { getContactName, setContactName } from '../contact-names';
export function Settings({ path }: { path?: string }) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  // The last persisted name, to skip no-op saves (e.g. a blur with no change, which
  // would otherwise create a user group from an accidental focus).
  const [savedName, setSavedName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [debugEnabled] = useState(isDebugEnabled());

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
      const [docList, contactNames, deviceNames] = await Promise.all([
        idbGet<unknown[]>(KEYS.docIds).then(v => v ?? []),
        idbGet<Record<string, string>>(KEYS.contactNames).then(v => v ?? {}),
        idbGet<Record<string, string>>(KEYS.deviceNames).then(v => v ?? {}),
      ]);
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
        const deviceNames = (payload.deviceNames && typeof payload.deviceNames === 'object' && !Array.isArray(payload.deviceNames))
          ? payload.deviceNames : {};
        await Promise.all([
          idbSet(KEYS.docIds, payload.docList),
          idbSet(KEYS.contactNames, payload.contactNames),
          idbSet(KEYS.deviceNames, deviceNames),
        ]);
        window.location.reload();
      } catch (err: any) {
        setError('Import failed: ' + err.message);
      }
    };
    input.click();
  };

  // Navigate to a link the user pasted or scanned. Accepts a full URL (we take its
  // hash fragment), a hash-only string (`#/...`), or a bare rendezvous code
  // (`r.<id>.<key>`, which we route to the add-friend page). Returns an error
  // message on failure, or null on success.
  const navigateToUrlOrHash = (raw: string): string | null => {
    const value = raw.trim();
    if (!value) return 'Empty link.';
    const hashIdx = value.indexOf('#');
    if (hashIdx !== -1) {
      window.location.hash = value.slice(hashIdx + 1);
      return null;
    }
    // No hash: a bare rendezvous code joins the add-friend flow.
    if (value.startsWith('r.')) {
      window.location.hash = `/add-friend/${value}`;
      return null;
    }
    return 'Not a recognized link.';
  };

  const handleNavigateUrl = () => {
    const err = navigateToUrlOrHash(linkUrl);
    if (err) setError(`Invalid URL — ${err.toLowerCase()}`);
  };

  const handleScanResult = (text: string) => {
    setScanning(false);
    const err = navigateToUrlOrHash(text);
    if (err) setError(`Scanned code is not a recognized link — ${err.toLowerCase()}`);
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
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setScanning(true)}>
          <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>qr_code_scanner</span>
          Scan QR Code
        </Button>
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
          <a href="#/add-friend" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>person_add</span>
            Add Friend
          </a>
        </div>
      </section>

      {/* Devices */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Devices</h2>
        <DeviceList devices={devices} onRemove={removeDevice} onChangeRole={changeDeviceRole} statuses={deviceStatuses} />

        {/* Link another device — full flow on its own page */}
        <div className="mt-4">
          <a href="#/link-device" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>devices</span>
            Link Device
          </a>
        </div>
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
        <Button size="sm" variant="destructive" onClick={handleClearCaches}>Clear Caches</Button>
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

      {scanning && (
        <QrScanner onResult={handleScanResult} onClose={() => setScanning(false)} />
      )}
    </div>
  );
}
