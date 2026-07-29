/**
 * Link Device page — handles QR-code-based device linking.
 *
 * URL format: /#/link-device/{base64url-encoded-contact-card}
 *
 * Device linking is a two-way handshake. This page handles both legs:
 * 1. Decode the contact card from the URL and receiveContactCard / linkDevice.
 * 2. If we are the original (admin) device, linkDevice adds the peer and the
 *    handshake is complete — show "Linking complete".
 * 3. Otherwise (the new device), show this device's own contact card as a return
 *    QR code for the original device to open and finish the handshake.
 */

import { useState, useCallback, useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { receiveContactCard, linkDevice, getLinkPayload, rendezvousJoinDeviceLink, onRendezvousEvent, getIdentity } from '../common/keyhive-api';
import { resolveDeviceName } from '../device-names';
import type { RendezvousStatus } from '../worker-api';
import { showToast } from '@/components/ui/toast';
import { RendezvousProgress } from './RendezvousProgress';
import { parseRendezvousToken } from '../../../shared/rendezvous-url';
import { buildLinkDeviceUrl, decodeLinkData } from './rendezvous-urls';

interface LinkDevicePageProps {
  cardData?: string;
  path?: string;
}

/**
 * Every exit lands on the device *list*, not the settings index. That is the screen
 * this flow is about, and it shows the result: useDevices refreshes on the `linked`
 * rendezvous event, so the newly linked device is already there with a live
 * transport label.
 */
const DEVICES_HASH = '#/settings/devices';
const goToDevices = () => { window.location.hash = '/settings/devices'; };

export function LinkDevicePage({ cardData }: LinkDevicePageProps) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [myCardUrl, setMyCardUrl] = useState('');
  const [phase, setPhase] = useState<RendezvousStatus | null>(null);
  const [transferDetail, setTransferDetail] = useState<string>();

  // Rendezvous join path (preferred): the tiny QR carries only {id, key}.
  const rdv = cardData ? parseRendezvousToken(cardData) : null;

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
    if (!cardData) {
      setError('Invalid link — missing friend data.');
      return;
    }
    setProcessing(true);
    setError(null);

    try {
      if (rdv) {
        // Preferred path: bidirectional handshake over the encrypted relay
        // rendezvous (the original device's card is too large for a QR).
        setStatus('Linking with your other device… (keep both open)');
        // Share this device's name so the original device can label us.
        const { agentId } = await getIdentity();
        await rendezvousJoinDeviceLink(rdv.rendezvousId, rdv.key, resolveDeviceName(agentId));
        setStatus('');
        setDone(true);
        return;
      }

      setStatus('Decoding friend details...');
      const { cardJson, userGroupId: peerGroupId } = decodeLinkData(cardData);

      setStatus('Linking this device...');
      const result = await receiveContactCard(cardJson, { isDevice: true });
      if (result.isOwnCard) {
        setError("This is your own device's link. Open this link on a different device to link it.");
        return;
      }

      // Join the same user-group (adopting the peer's group id if we don't have one yet).
      setStatus('Joining your account...');
      const { linked } = await linkDevice(result.agentId, peerGroupId);

      if (linked) {
        // Both devices are now members — the handshake is complete (this is the
        // second leg, back on the original device). No return QR needed.
        setStatus('');
        setDone(true);
      } else {
        // First leg, on the new device — produce a return link for the original
        // device to open and finish the handshake.
        setStatus('Generating your link...');
        const { card: myCard, userGroupId: myGroupId } = await getLinkPayload();
        setMyCardUrl(buildLinkDeviceUrl(myCard, myGroupId));
        setStatus('');
        setDone(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to link device');
    } finally {
      setProcessing(false);
    }
    // `rdv` is derived from cardData; depending on it would rebuild this each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardData]);

  // Auto-start once when the page mounts with card data.
  useEffect(() => { doLink(); }, [doLink]);

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
              <Button onClick={doLink} disabled={processing} data-testid="link-device-retry">
                Retry
              </Button>
              <Button variant="outline" onClick={goToDevices}>Devices</Button>
            </div>
          </>
        ) : (
          <>
            {rdv && !done ? (
              <RendezvousProgress
                phase={phase}
                rendezvousId={rdv.rendezvousId}
                waitingLabel="Connecting to your other device — keep both open…"
                transferLabel="Exchanging keys…"
                transferDetail={transferDetail}
                doneLabel="Linked."
              />
            ) : (
              <p className="md-body-medium text-on-surface-variant">{status}</p>
            )}

            {done && (
              <div className="mt-4">
                {myCardUrl ? (
                  <>
                    <p className="md-title-medium mb-1">Almost done — finish on your original device</p>
                    <p className="md-body-medium text-on-surface-variant mb-3">
                      Open this link (or scan this QR code) on your original device to complete the
                      handshake:
                    </p>
                    <div className="flex justify-center">
                      <QRCodeDisplay url={myCardUrl} />
                    </div>
                    {/* The link stays visible: it is the fallback when the payload
                        overflows QR capacity, and users paste it between devices. */}
                    <div className="flex items-center gap-1 mt-2">
                      <input
                        data-testid="link-device-url"
                        className="w-full min-w-0 text-xs p-3 rounded-xl font-mono bg-surface-container-highest text-on-surface-variant border border-outline-variant"
                        value={myCardUrl}
                        readOnly
                        onClick={(e: any) => e.currentTarget.select()}
                      />
                      <button
                        aria-label="Copy link"
                        title="Copy link"
                        className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
                        onClick={() => navigator.clipboard.writeText(myCardUrl).then(
                          () => showToast('Link copied to clipboard'),
                          () => showToast('Failed to copy link'),
                        )}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>content_copy</span>
                      </button>
                    </div>
                  </>
                ) : (
                  // MD3 has no "success" role; a completed step is `primary`.
                  <p className="md-title-medium" style={{ color: 'var(--md-sys-color-primary)' }}>
                    <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 18 }}>
                      check_circle
                    </span>
                    Linking complete
                  </p>
                )}
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" onClick={goToDevices} data-testid="link-device-done">
                    Done
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
