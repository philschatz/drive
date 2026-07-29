/**
 * Link Device — bottom sheet.
 *
 * Opened from Settings instead of a route. Auto-starts on open (no "Start the
 * process" button): if settings are still device-local it first offers to sync them
 * to the new device, then shows the rendezvous QR/link. The new device opens the
 * link (the receiver `LinkDevicePage`) to finish. Settings' own DeviceList
 * refreshes itself once the link completes, so no callback is needed.
 *
 * The sync question is asked as two rows in this sheet's own body rather than as a
 * dialog (it used to be a `window.confirm` fired from inside the opening effect —
 * a modal over a modal, whose two sentences an OS dialog buries). That means the
 * answer arrives as *state* rather than as a return value, so the flow is an
 * explicit machine:
 *
 *   preparing → ask-sync → enabling → staging → ready
 *                 └──────────────────────┘ (already SHARED skips straight to staging)
 *
 * The ordering that matters — settings sync enabled BEFORE the rendezvous is
 * staged, so the settings-doc pointer gets handed off — survives as a reachability
 * property: RendezvousShare mounts only at `ready`, `ready` is reachable only via
 * `staging`, and `staging` is reachable only after `enableSettingsSync()` resolves.
 */

import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { rendezvousCreateDeviceLink, getIdentity } from '../common/keyhive-api';
import { getSettingsMode, enableSettingsSync } from '../worker-api';
import { resolveDeviceName } from '../device-names';
import { keyhiveReady, whenWsConnected } from '../common/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildLinkDeviceRendezvousUrl } from './rendezvous-urls';

interface AddDeviceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Phase = 'preparing' | 'ask-sync' | 'enabling' | 'staging' | 'ready';

export function AddDeviceSheet({ open, onOpenChange }: AddDeviceSheetProps) {
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<Phase>('preparing');

  // Decide whether the sync question needs asking. Reset on close so the next open
  // stages a fresh rendezvous.
  useEffect(() => {
    if (!open) {
      setPhase('preparing');
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await keyhiveReady;
        // If this device still keeps its settings LOCAL, ask whether to sync them to
        // the new device first — "yes" opts into SHARED *before* the rendezvous so
        // the settings-doc pointer gets handed off; an already-SHARED device skips it.
        const { mode } = await getSettingsMode();
        if (cancelled) return;
        setPhase(mode === 'local' ? 'ask-sync' : 'staging');
      } catch (err: any) {
        if (!cancelled) setError('Could not start linking: ' + (err?.message ?? err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Gate on the relay socket before staging the rendezvous.
  useEffect(() => {
    if (phase !== 'staging') return;
    let cancelled = false;
    (async () => {
      try {
        await whenWsConnected();
        if (!cancelled) setPhase('ready');
      } catch (err: any) {
        if (!cancelled) setError('Could not start linking: ' + (err?.message ?? err));
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  /** Answer the sync question. `enabling` blocks a second tap and shows progress. */
  const chooseSync = async (sync: boolean) => {
    setError('');
    setPhase('enabling');
    try {
      if (sync) await enableSettingsSync();
      setPhase('staging');
    } catch (err: any) {
      setError('Could not enable settings sync: ' + (err?.message ?? err));
      setPhase('ask-sync');
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="add-device-sheet">
          <SheetHeader>
            <SheetTitle className="pr-8">Link a device</SheetTitle>
          </SheetHeader>

          <p className="md-body-medium text-on-surface-variant mt-3 mb-3 max-w-md">
            Invite another device to act as you. Open the link on your new device while this sheet
            stays open — they connect over the relay to finish linking.
          </p>

          {/* Inline, not a snackbar: it explains why there is no QR below it. */}
          {error && (
            <div
              className="flex items-start gap-3 p-3 mb-3 rounded-xl bg-error-container text-on-error-container"
              data-testid="add-device-error"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>error</span>
              <p className="md-body-medium min-w-0">{error}</p>
            </div>
          )}

          {phase === 'ask-sync' && (
            <div data-testid="link-sync-choice">
              <md-list style={{ background: 'transparent' }}>
                <md-list-item type="button" data-testid="link-sync-yes" onClick={() => chooseSync(true)}>
                  <md-icon slot="start">sync</md-icon>
                  <div slot="headline">Sync settings to the new device</div>
                  <div slot="supporting-text">
                    Permanent — your devices will share one settings document
                  </div>
                </md-list-item>
                <md-list-item type="button" data-testid="link-sync-no" onClick={() => chooseSync(false)}>
                  <md-icon slot="start">phonelink_lock</md-icon>
                  <div slot="headline">Keep settings on each device</div>
                  <div slot="supporting-text">
                    Each device keeps its own friends and device names
                  </div>
                </md-list-item>
              </md-list>
            </div>
          )}

          {phase === 'ready' && (
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
          )}

          {(phase === 'preparing' || phase === 'enabling' || phase === 'staging') && !error && (
            <p className="md-body-medium text-on-surface-variant">
              {phase === 'enabling' ? 'Enabling settings sync…' : 'Preparing the link…'}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
