/**
 * Settings page — device management and identity info.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  getIdentity,
  getLinkPayload,
  listDevices,
  removeDevice,
  type IdentityInfo,
  type DeviceInfo,
} from '../shared/keyhive-api';
import { idbGet, idbSet } from '../idb-storage';
import { getContactName, setContactName } from '../contact-names';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { ReciprocalShare } from './ReciprocalShare';
import { buildLinkDeviceUrl } from './LinkDevicePage';
export function Settings({ path }: { path?: string }) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [contactCard, setContactCard] = useState<string | null>(null);
  // Friend share via encrypted rendezvous: capture the name at click time and
  // bump the nonce so re-clicking regenerates a fresh rendezvous.
  const [friendShareName, setFriendShareName] = useState<string | null>(null);
  const [friendShareNonce, setFriendShareNonce] = useState(0);
  const [displayName, setDisplayName] = useState('');
  const [linkDeviceUrl, setLinkDeviceUrl] = useState('');
  const [inviteUrl, setInviteUrl] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [id, devs] = await Promise.all([
        getIdentity(),
        listDevices(),
      ]);
      setIdentity(id);
      setDisplayName(getContactName(id.agentId) || '');
      setDevices(devs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleShowContactCard = async () => {
    try {
      const { card, userGroupId } = await getLinkPayload();
      setContactCard(card);
      setLinkDeviceUrl(buildLinkDeviceUrl(card, userGroupId));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDisplayNameChange = (value: string) => {
    setDisplayName(value);
    if (identity?.agentId) setContactName(identity.agentId, value).catch(err =>
      console.error('[Settings] Failed to save display name:', err)
    );
    // Hide a stale share if the name changed; the user re-clicks to regenerate.
    setFriendShareName(null);
  };

  const handleShowFriendQr = () => {
    setFriendShareName(displayName.trim());
    setFriendShareNonce(n => n + 1);
  };

  const handleRemoveDevice = async (agentId: string) => {
    try {
      await removeDevice(agentId);
      setMessage('Device removed.');
      await refresh();
    } catch (err: any) {
      setError('Failed to remove device: ' + err.message);
    }
  };


  const handleExport = async () => {
    try {
      const [docList, contactNames, invites] = await Promise.all([
        idbGet<unknown[]>('automerge-doc-ids').then(v => v ?? []),
        idbGet<Record<string, string>>('contact-names').then(v => v ?? {}),
        idbGet<unknown[]>('automerge-invites').then(v => v ?? []),
      ]);
      const payload = { version: 1, exportedAt: new Date().toISOString(), docList, contactNames, invites };
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
        if (!Array.isArray(payload.invites)) throw new Error('Invalid backup: invites must be an array.');
        await Promise.all([
          idbSet('automerge-doc-ids', payload.docList),
          idbSet('contact-names', payload.contactNames),
          idbSet('automerge-invites', payload.invites),
        ]);
        localStorage.setItem('automerge-doc-ids', JSON.stringify(payload.docList));
        window.location.reload();
      } catch (err: any) {
        setError('Import failed: ' + err.message);
      }
    };
    input.click();
  };

  const handleNavigateUrl = () => {
    const url = inviteUrl.trim();
    if (!url) return;
    const hashIdx = url.indexOf('#');
    if (hashIdx === -1) {
      setError('Invalid URL — no hash fragment found.');
      return;
    }
    window.location.hash = url.slice(hashIdx + 1);
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

      {/* Devices */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Devices</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Each device has its own cryptographic key. Add devices so you can reach your documents from your phone, laptop, or tablet.
        </p>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked devices.</p>
        ) : (
          <div className="space-y-1">
            {devices.map((dev, i) => (
              <div key={i} className="flex items-center gap-2 py-1 border-b border-border">
                <span className="material-symbols-outlined text-muted-foreground" style={{ fontSize: 16 }}>
                  {dev.isMe ? 'smartphone' : 'devices'}
                </span>
                <span className="text-sm flex-1 truncate font-mono" title={dev.agentId}>
                  {dev.agentId.slice(0, 16)}...
                </span>
                <span className="text-xs text-muted-foreground capitalize">{dev.role}</span>
                {dev.isMe && <span className="text-xs bg-primary/10 text-primary px-1 rounded">This device</span>}
                {!dev.isMe && (
                  <button
                    className="text-muted-foreground hover:text-destructive p-0.5 rounded"
                    title="Remove device"
                    onClick={() => handleRemoveDevice(dev.agentId)}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Invite another device */}
        <div className="mt-4">
          <h3 className="text-sm font-semibold mb-2">Invite Another Device</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Invite another device to act as you. Linking is a handshake — both devices open a link to complete it.
          </p>

          {/* Show your contact card for the new device to scan */}
          <div className="mb-3">
            <p className="text-xs text-muted-foreground mb-1">
              On your new device, scan this QR code or open this link:
            </p>
            <Button size="sm" variant="outline" onClick={handleShowContactCard}>
              Show QR Code
            </Button>
            {contactCard && (
              <div className="mt-2 space-y-2">
                {linkDeviceUrl && (
                  <div className="space-y-2">
                    <div className="flex justify-center">
                      <QRCodeDisplay url={linkDeviceUrl} />
                    </div>
                    <input
                      className="flex-1 text-xs p-2 rounded border border-border font-mono bg-muted w-full"
                      value={linkDeviceUrl}
                      readOnly
                      onClick={(e: any) => e.currentTarget.select()}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Share me with a friend */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Share me with a friend</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Show this QR code to a friend so they can add you as a contact and share documents with you.
        </p>
        <div className="mb-2">
          <input
            className="w-full text-sm p-2 rounded border border-border"
            value={displayName}
            onInput={(e: any) => handleDisplayNameChange(e.currentTarget.value)}
            placeholder="Display name (optional)"
          />
        </div>
        <Button size="sm" variant="outline" onClick={handleShowFriendQr}>
          Show QR code
        </Button>
        {friendShareName !== null && (
          <div className="mt-2">
            <ReciprocalShare key={`${friendShareNonce}:${friendShareName}`} displayName={friendShareName} />
          </div>
        )}
      </section>

      {/* Navigate to URL */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Developer: Open Link</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Paste a link to navigate to it (e.g. invite or document links).
        </p>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-sm p-2 rounded border border-border font-mono"
            value={inviteUrl}
            onInput={(e: any) => setInviteUrl(e.currentTarget.value)}
            placeholder="Paste URL here..."
          />
          <Button size="sm" onClick={handleNavigateUrl} disabled={!inviteUrl.trim()}>
            Go
          </Button>
        </div>
      </section>

      {/* Data Backup */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Data Backup</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Export or import your document list, contacts, and invite data.
          This does not include document contents (those sync via Automerge).
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleExport}>Export</Button>
          <Button size="sm" variant="outline" onClick={handleImport}>Import</Button>
        </div>
      </section>
    </div>
  );
}
