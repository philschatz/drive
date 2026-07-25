/**
 * Link Device (sharer side) — its own page.
 *
 * Lists this user's linked devices and, once the user clicks "Start the process",
 * shows an encrypted-relay rendezvous QR so a new device can be linked to act as
 * this user. The new device opens the link (the receiver `LinkDevicePage`) to finish.
 */

import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DeviceList } from '@/components/DeviceList';
import { useDevices, useDeviceStatuses } from '../shared/use-devices';
import { rendezvousCreateDeviceLink, getIdentity } from '../shared/keyhive-api';
import { getSettingsMode, enableSettingsSync } from '../worker-api';
import { resolveDeviceName } from '../device-names';
import { useWsStatus } from '../shared/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildLinkDeviceRendezvousUrl } from './LinkDevicePage';

export function LinkDeviceSharePage({ path }: { path?: string }) {
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // Bump to (re)mount RendezvousShare; >0 means the share has been started.
  const [started, setStarted] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const connected = useWsStatus();

  // Start linking. If this device still keeps its settings LOCAL, first ask whether to
  // sync them to the new device — "yes" opts into SHARED (one-way) before the rendezvous
  // so the settings-doc pointer gets handed off; an already-SHARED device skips the ask.
  const handleStart = async () => {
    setError('');
    setPreparing(true);
    try {
      const { mode } = await getSettingsMode();
      if (mode === 'local') {
        const sync = window.confirm(
          'Sync your settings (contacts, device names, seen state) to the new device?\n\n' +
          'If you agree, your settings will sync across your devices from now on (this is permanent). ' +
          'Otherwise each device keeps its own settings.',
        );
        if (sync) await enableSettingsSync();
      }
      setStarted(n => n + 1);
    } catch (err: any) {
      setError('Could not start linking: ' + (err.message ?? err));
    } finally {
      setPreparing(false);
    }
  };

  const { devices, removeDevice, changeDeviceRole } = useDevices({ onError: setError, onMessage: setMessage });
  const deviceStatuses = useDeviceStatuses();

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

      <DeviceList devices={devices} onRemove={removeDevice} onChangeRole={changeDeviceRole} statuses={deviceStatuses} />

      <div className="mt-4">
        <h2 className="text-lg font-semibold mb-2">Invite Another Device</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Invite another device to act as you. Open the link on your new device while
          this page stays open — they connect over the relay to finish linking.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={handleStart}
          disabled={!connected || preparing}
          title={connected ? undefined : 'Disconnected from the server — reconnect to start the process'}
        >
          {preparing ? 'Preparing…' : 'Start the process'}
        </Button>
        {started > 0 && (
          <div className="mt-2">
            <RendezvousShare
              key={started}
              create={async () => {
                // Share this device's name so the new device can label us.
                const { agentId } = await getIdentity();
                return rendezvousCreateDeviceLink(resolveDeviceName(agentId));
              }}
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
