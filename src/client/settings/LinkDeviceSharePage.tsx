/**
 * Link Device (sharer side) — its own page.
 *
 * Lists this user's linked devices and, once the user clicks "Start the process",
 * shows an encrypted-relay rendezvous QR so a new device can be linked to act as
 * this user. The new device opens the link (the receiver `LinkDevicePage`) to finish.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  listDevices,
  removeDevice,
  rendezvousCreateDeviceLink,
  onKeyhiveStateChanged,
  onRendezvousEvent,
  type DeviceInfo,
} from '../shared/keyhive-api';
import { RendezvousShare } from './RendezvousShare';
import { buildLinkDeviceRendezvousUrl } from './LinkDevicePage';

export function LinkDeviceSharePage({ path }: { path?: string }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // Bump to (re)mount RendezvousShare; >0 means the share has been started.
  const [started, setStarted] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listDevices());
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh the device list when a link completes or membership syncs over the relay.
  useEffect(() => {
    const offRdv = onRendezvousEvent((e) => { if (e.status === 'linked') refresh(); });
    const offState = onKeyhiveStateChanged(() => refresh());
    return () => { offRdv(); offState(); };
  }, [refresh]);

  const handleRemoveDevice = async (agentId: string) => {
    if (!confirm(`Remove device ${agentId.slice(0, 16)}…?`)) return;
    try {
      await removeDevice(agentId);
      setMessage('Device removed.');
      await refresh();
    } catch (err: any) {
      setError('Failed to remove device: ' + err.message);
    }
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
        <h1 className="text-2xl font-bold">Link Device</h1>
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

      <div className="mt-4">
        <h2 className="text-lg font-semibold mb-2">Invite Another Device</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Invite another device to act as you. Open the link on your new device while
          this page stays open — they connect over the relay to finish linking.
        </p>
        <Button size="sm" variant="outline" onClick={() => setStarted(n => n + 1)}>
          Start the process
        </Button>
        {started > 0 && (
          <div className="mt-2">
            <RendezvousShare
              key={started}
              create={rendezvousCreateDeviceLink}
              buildUrl={buildLinkDeviceRendezvousUrl}
              waitingLabel="Waiting for your new device to open the link…"
              transferLabel="Exchanging keys with your new device…"
              doneLabel="Device linked."
            />
          </div>
        )}
      </div>
    </div>
  );
}
