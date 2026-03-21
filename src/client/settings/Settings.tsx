/**
 * Settings page — device management and identity info.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  getIdentity,
  getContactCard,
  receiveContactCard,
  listDevices,
  type IdentityInfo,
  type DeviceInfo,
} from '../shared/keyhive-api';
import { idbGet, idbSet } from '../idb-storage';
import QRCode from 'qrcode';
import { buildLinkDeviceUrl } from './LinkDevicePage';
import { buildAddFriendUrl } from './AddFriendPage';
export function Settings({ path }: { path?: string }) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [contactCard, setContactCard] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState('');
  const [friendQrSvg, setFriendQrSvg] = useState('');
  const [friendQrUrl, setFriendQrUrl] = useState('');
  const [linkDeviceUrl, setLinkDeviceUrl] = useState('');
  const [linkInput, setLinkInput] = useState('');
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
      const card = await getContactCard();
      setContactCard(card);
      const url = buildLinkDeviceUrl(card);
      setLinkDeviceUrl(url);
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
      setQrSvg(svg);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleShowFriendQr = async () => {
    try {
      const card = await getContactCard();
      const url = buildAddFriendUrl(card);
      setFriendQrUrl(url);
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
      setFriendQrSvg(svg);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleLinkDevice = async () => {
    if (!linkInput.trim()) return;
    setLoading(true);
    try {
      await receiveContactCard(linkInput.trim());
      setMessage('Device linked successfully');
      setLinkInput('');
      await refresh();
    } catch (err: any) {
      setError('Failed to link device: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyContactCard = () => {
    if (contactCard) navigator.clipboard.writeText(contactCard);
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
              <span className="text-muted-foreground">Device ID:</span>
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
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
          Each device has its own cryptographic key. Link devices to access your documents from multiple devices.
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
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Share me with a friend */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Share me with a friend</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Show this QR code to a friend so they can add you as a contact and share documents with you.
        </p>
        <Button size="sm" variant="outline" onClick={handleShowFriendQr}>
          Show QR code
        </Button>
        {friendQrSvg && (
          <div className="mt-2 space-y-2">
            <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: friendQrSvg }} />
            <div className="flex items-center gap-2">
              <input
                className="flex-1 text-xs p-2 rounded border border-border font-mono bg-muted"
                value={friendQrUrl}
                readOnly
                onClick={(e: any) => e.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(friendQrUrl)}>Copy</Button>
            </div>
          </div>
        )}
      </section>

      {/* Navigate to URL */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Open Link</h2>
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

      {/* Link device */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Link a Device</h2>

        {/* Step 1: Show your contact card */}
        <div className="mb-3">
          <p className="text-xs text-muted-foreground mb-1">
            Share your contact card with the other device:
          </p>
          <Button size="sm" variant="outline" onClick={handleShowContactCard}>
            Show contact card
          </Button>
          {contactCard && (
            <div className="mt-2 space-y-2">
              {qrSvg && (
                <div className="space-y-2">
                  <div className="flex justify-center" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                  <div className="flex items-center gap-2">
                    <input
                      className="flex-1 text-xs p-2 rounded border border-border font-mono bg-muted"
                      value={linkDeviceUrl}
                      readOnly
                      onClick={(e: any) => e.currentTarget.select()}
                    />
                    <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(linkDeviceUrl)}>Copy</Button>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <textarea
                  className="flex-1 text-xs bg-muted p-2 rounded border border-border font-mono resize-none"
                  rows={4}
                  value={contactCard}
                  readOnly
                  onClick={(e: any) => e.currentTarget.select()}
                />
                <Button size="sm" variant="outline" onClick={copyContactCard}>Copy</Button>
              </div>
            </div>
          )}
        </div>

        {/* Step 2: Paste the other device's contact card */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            Paste the other device's contact card:
          </p>
          <div className="flex items-start gap-2">
            <textarea
              className="flex-1 text-xs p-2 rounded border border-border font-mono resize-none"
              rows={4}
              value={linkInput}
              onInput={(e: any) => setLinkInput(e.currentTarget.value)}
              placeholder="Paste contact card JSON here..."
            />
            <Button size="sm" onClick={handleLinkDevice} disabled={loading || !linkInput.trim()}>
              Link
            </Button>
          </div>
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
