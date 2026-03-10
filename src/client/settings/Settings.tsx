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
} from '../../shared/keyhive-api';

export function Settings({ path }: { path?: string }) {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [contactCard, setContactCard] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
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
          <div className="text-sm">
            <div className="flex items-center gap-2 mb-1">
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
            <div className="mt-2 flex items-start gap-2">
              <textarea
                className="flex-1 text-xs bg-muted p-2 rounded border border-border font-mono resize-none"
                rows={4}
                value={contactCard}
                readOnly
                onClick={(e: any) => e.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={copyContactCard}>Copy</Button>
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
    </div>
  );
}
