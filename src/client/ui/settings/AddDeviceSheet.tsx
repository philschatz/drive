/**
 * Link Device — bottom sheet.
 *
 * Opened from Settings instead of a route. Auto-starts on open (no "Start the
 * process" button): if settings are still device-local it first offers to sync
 * them to the new device, then shows the rendezvous QR/link. The new device
 * opens the link (the receiver `LinkDevicePage`) to finish. Settings' own
 * DeviceList refreshes itself once the link completes, so no callback is needed.
 */

import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { rendezvousCreateDeviceLink, getIdentity } from '../common/keyhive-api';
import { getSettingsMode, enableSettingsSync } from '../worker-api';
import { resolveDeviceName } from '../device-names';
import { keyhiveReady, whenWsConnected } from '../common/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildLinkDeviceRendezvousUrl } from './LinkDevicePage';

interface AddDeviceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddDeviceSheet({ open, onOpenChange }: AddDeviceSheetProps) {
  const [error, setError] = useState('');
  // Settings-sync prompt + WS connect done → mount RendezvousShare.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setReady(false);
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await keyhiveReady;
        // If this device still keeps its settings LOCAL, first ask whether to sync
        // them to the new device — "yes" opts into SHARED before the rendezvous so
        // the settings-doc pointer gets handed off; an already-SHARED device skips it.
        const { mode } = await getSettingsMode();
        if (cancelled) return;
        if (mode === 'local') {
          const sync = window.confirm(
            'Sync your settings (friends, device names, seen state) to the new device?\n\n' +
            'If you agree, your settings will sync across your devices from now on (this is permanent). ' +
            'Otherwise each device keeps its own settings.',
          );
          if (sync) await enableSettingsSync();
        }
        // Gate on the relay socket before staging the rendezvous.
        await whenWsConnected();
        if (cancelled) return;
        setReady(true);
      } catch (err: any) {
        if (!cancelled) setError('Could not start linking: ' + (err?.message ?? err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Link a device</SheetTitle>
        </SheetHeader>
        <p className="text-sm text-muted-foreground mt-3 mb-3 max-w-md">
          Invite another device to act as you. Open the link on your new device while this sheet
          stays open — they connect over the relay to finish linking.
        </p>
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        {ready ? (
          <div className="max-w-sm">
            <RendezvousShare
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
        ) : (
          !error && <p className="text-sm text-muted-foreground">Preparing the link…</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
