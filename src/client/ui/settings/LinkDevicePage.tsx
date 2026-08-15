/**
 * Link Device page — the receiving side of a QR device-link invite, opened on the
 * *new* device.
 *
 * URL form: `/#/link-device/r.<rendezvousId>.<key>`. Anything else is an unusable
 * link. The exchange is a single bidirectional leg over the encrypted relay
 * rendezvous — both devices' cards cross in one handshake, so unlike the old
 * card-in-the-URL scheme there is no return QR to carry back.
 *
 * **The link starts on a tap, never on navigation.** This is the more consequential
 * of the two invite flows: joining runs `linkDevice`, which converges both devices
 * onto one user group, and may adopt the other device's DriveSettings doc. Until
 * `begin()` runs nothing has left this device.
 */

import { useState, useCallback, useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { rendezvousJoinDeviceLink, onRendezvousEvent, getIdentity } from '../common/keyhive-api';
import { resolveDeviceName } from '../device-names';
import type { RendezvousStatus } from '../worker-api';
import { RendezvousProgress } from './RendezvousProgress';
import { StartGate } from './StartGate';
import { parseRendezvousToken } from '../../../shared/rendezvous-url';

interface LinkDevicePageProps {
  token?: string;
  path?: string;
}

const INVALID_LINK = "This isn't a valid device link — open Settings on your other device and show a fresh QR code or link.";

/**
 * Every exit lands on the device *list*, not the settings index. That is the screen
 * this flow is about, and it shows the result: useDevices refreshes on the `linked`
 * rendezvous event, so the newly linked device is already there with a live
 * transport label.
 */
const DEVICES_HASH = '#/settings/devices';
const goToDevices = () => { window.location.hash = '/settings/devices'; };

export function LinkDevicePage({ token }: LinkDevicePageProps) {
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<RendezvousStatus | null>(null);
  const [transferDetail, setTransferDetail] = useState<string>();

  const rdv = token ? parseRendezvousToken(token) : null;
  const linkOk = !!rdv;

  // An unusable link has no process to gate and nothing a retry could fix.
  useEffect(() => { if (!linkOk) setError(INVALID_LINK); }, [linkOk]);

  // Mirror the sharer's step-by-step progress (and channel id) on this device.
  useEffect(() => {
    if (!rdv) return;
    const off = onRendezvousEvent((e) => {
      if (e.rendezvousId !== rdv.rendezvousId || e.status === 'error') return;
      setPhase(e.status);
      if (e.status === 'sending' && e.message) setTransferDetail(e.message);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rdv?.rendezvousId]);

  const doLink = useCallback(async () => {
    if (!rdv) {
      setError(INVALID_LINK);
      return;
    }
    setProcessing(true);
    setError(null);

    try {
      // Share this device's name so the original device can label us.
      const { agentId } = await getIdentity();
      await rendezvousJoinDeviceLink(rdv.rendezvousId, rdv.key, resolveDeviceName(agentId));
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Failed to link device');
    } finally {
      setProcessing(false);
    }
    // `rdv` is derived from the token; depending on it would rebuild this each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  /** The one place the link starts. */
  const begin = () => { setStarted(true); doLink(); };

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      {/* Top app bar. `close`, not `arrow_back`: this page is reached by opening a
          link, so the route IS the first history entry. Rendered always, including
          mid-handshake — there used to be no exit at all until the flow finished, so
          a stalled exchange left editing the URL as the only way out. */}
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href={DEVICES_HASH}
          aria-label="Close"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>close</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Link device</h1>
      </div>

      <div className="px-4 max-w-md">
        {error ? (
          <>
            {/* Inline, not a snackbar: a failure with a Retry has to stay put. */}
            <div
              className="flex items-start gap-3 p-3 rounded-xl bg-error-container text-on-error-container"
              data-testid="link-device-error"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>error</span>
              <div className="min-w-0">
                <p className="md-body-medium">{error}</p>
                {rdv && (
                  <p className="text-[10px] opacity-70 mt-1">
                    Channel: <code className="font-mono">{rdv.rendezvousId.slice(0, 8)}…</code>
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              {/* No Retry for an unusable link — re-running it can only fail again. */}
              {rdv && (
                <Button onClick={doLink} disabled={processing} data-testid="link-device-retry">
                  Retry
                </Button>
              )}
              <Button variant="outline" onClick={goToDevices}>Devices</Button>
            </div>
          </>
        ) : !started ? (
          <StartGate
            question="Link this device to your account?"
            confirmLabel="Link device"
            onConfirm={begin}
            onCancel={goToDevices}
            channelId={rdv?.rendezvousId}
            testId="link-device"
          >
            This device and the other one will act as the same account: both will be able to open
            all of your documents. This device may also start using the other one's shared
            settings — its friends and device names. Only continue if you opened this link
            yourself.
          </StartGate>
        ) : done ? (
          <>
            {/* MD3 has no "success" role; a completed step is `primary`. */}
            <p className="md-title-medium" style={{ color: 'var(--md-sys-color-primary)' }}>
              <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 18 }}>
                check_circle
              </span>
              Linking complete
            </p>
            <div className="flex gap-2 mt-4">
              <Button variant="outline" onClick={goToDevices} data-testid="link-device-done">
                Done
              </Button>
            </div>
          </>
        ) : (
          <RendezvousProgress
            phase={phase}
            rendezvousId={rdv?.rendezvousId}
            waitingLabel="Connecting to your other device — keep both open…"
            transferLabel="Exchanging keys…"
            transferDetail={transferDetail}
            doneLabel="Linked."
          />
        )}
      </div>
    </div>
  );
}
