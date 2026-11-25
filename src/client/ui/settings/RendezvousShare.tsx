/**
 * Sharer-side QR for an encrypted relay rendezvous.
 *
 * Stages a payload for a rendezvous and renders the tiny {id,key} as a QR + link.
 * When the other peer opens the link, the worker exchanges the (possibly large)
 * payload over the relay automatically and we show a confirmation. The QR stays
 * tiny regardless of account size — the payload never touches the URL.
 *
 * Reused for: friend share (Settings + AddFriendPage success) and device linking
 * ("Invite Another Device"). Callers supply the create/buildUrl pair and the
 * event status(es) that mean "done".
 *
 * Two things here are about the link being a secret anyone could use:
 * - **It expires.** The worker ends an unused link after a few minutes; this
 *   shows that and offers a new one.
 * - **A device link asks before it links.** When another device has opened the
 *   link, the worker reports its name and a code (`confirm`) and waits. The
 *   person checks the code against the one on the device in their hand, and
 *   only "Link this device" adds it — the QR and link are hidden meanwhile,
 *   since they have done their job.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { rendezvousCancel, rendezvousConfirmDeviceLink, onRendezvousEvent } from '../common/keyhive-api';
import { Button } from '@/components/ui/button';
import type { RendezvousStatus } from '../worker-api';
import { formatBytes } from '../../../shared/format-bytes';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { showToast } from '@/components/ui/toast';
import { RendezvousProgress } from './RendezvousProgress';

interface RendezvousShareProps {
  /**
   * Stage the share in the worker and return the rendezvous id+key, plus the
   * approximate size (bytes) of the payload we'll send once the peer joins.
   */
  create: () => Promise<{ rendezvousId: string; key: string; payloadBytes?: number }>;
  /** Build the QR/link URL from the id+key. */
  buildUrl: (rendezvousId: string, key: string) => string;
  waitingLabel: string;
  /** Step label while the payload is being exchanged. */
  transferLabel?: string;
  doneLabel: string;
  /**
   * Friend-share only: fired once the exchange completes with the contact we added
   * back, so the caller can offer a name input when the friend sent no name. Device
   * linking omits this (its terminal event is 'linked', which carries no contact).
   */
  onReceivedContact?: (info: { groupId: string; hasName: boolean }) => void;
}

export function RendezvousShare(props: RendezvousShareProps) {
  // Bumped to throw the current link away and stage a fresh one. Each link is
  // its own mount of the component below, so nothing of the last one carries
  // over — and leaving it cancels its rendezvous.
  const [attempt, setAttempt] = useState(0);
  return <SharedLink key={attempt} {...props} startOver={() => setAttempt((n) => n + 1)} />;
}

function SharedLink({
  create, buildUrl, waitingLabel, transferLabel = 'Exchanging encrypted data…', doneLabel, onReceivedContact, startOver,
}: RendezvousShareProps & { startOver: () => void }) {
  const [url, setUrl] = useState('');
  const [rendezvousId, setRendezvousId] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<RendezvousStatus | null>(null);
  const [transferDetail, setTransferDetail] = useState<string>();
  const [payloadBytes, setPayloadBytes] = useState<number>();
  // A device has asked to be linked and is waiting for the answer.
  const [asking, setAsking] = useState<{ deviceName?: string } | null>(null);
  const [expired, setExpired] = useState(false);
  // Keep the latest callback reachable from the mount-only effect below.
  const onReceivedContactRef = useRef(onReceivedContact);
  onReceivedContactRef.current = onReceivedContact;

  useEffect(() => {
    let rid = '';
    let cancelled = false;
    const offEvent = onRendezvousEvent((e) => {
      if (e.rendezvousId !== rid) return;
      if (e.status === 'error') { setAsking(null); setError(e.message ?? 'Something went wrong.'); }
      else if (e.status === 'expired') { setAsking(null); setExpired(true); }
      else {
        setPhase(e.status);
        setAsking(e.status === 'confirm' ? { deviceName: e.deviceName } : null);
        if (e.status === 'sending' && e.message) setTransferDetail(e.message);
        if (e.status === 'received' && e.friendGroupId) {
          onReceivedContactRef.current?.({ groupId: e.friendGroupId, hasName: !!e.friendHasName });
        }
      }
    });
    create()
      .then(({ rendezvousId, key, payloadBytes }) => {
        if (cancelled) { rendezvousCancel(rendezvousId); return; }
        rid = rendezvousId;
        setRendezvousId(rendezvousId);
        setUrl(buildUrl(rendezvousId, key));
        setPayloadBytes(payloadBytes);
      })
      .catch((err: any) => setError(err?.message ?? 'Could not create a share link.'));
    return () => {
      cancelled = true;
      offEvent();
      if (rid) rendezvousCancel(rid);
    };
    // create/buildUrl are provided fresh each render; intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (expired) {
    return (
      <div className="space-y-3" data-testid="rendezvous-expired">
        <p className="md-body-medium text-on-surface-variant">
          This code has expired. A code only works for a few minutes.
        </p>
        <Button onClick={startOver} data-testid="rendezvous-new-code">Show a new code</Button>
      </div>
    );
  }

  if (asking) {
    const name = asking.deviceName?.trim();
    return (
      <div className="space-y-3" data-testid="link-confirm">
        <p className="md-title-medium">
          {name ? <>Link <span data-testid="link-confirm-name">“{name}”</span> to your account?</> : 'Link this device to your account?'}
        </p>
        <p className="md-body-medium text-on-surface-variant">
          It will be able to open all of your documents. If you did not just open this link on a device of yours, something else did — choose “Not my device”.
        </p>
        <div className="flex gap-2">
          <Button
            data-testid="link-confirm-accept"
            onClick={() => { rendezvousConfirmDeviceLink(rendezvousId); setAsking(null); }}
          >
            Link this device
          </Button>
          <Button
            variant="outline"
            data-testid="link-confirm-decline"
            // The link has been used by something else. Leaving it cancels the
            // rendezvous, which tells the device that asked no; a new one is staged.
            onClick={startOver}
          >
            Not my device
          </Button>
        </div>
      </div>
    );
  }

  // Couldn't even stage the share — nothing to show but the failure.
  if (error && !url) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (!url) {
    return <p className="text-xs text-muted-foreground">Preparing share link…</p>;
  }

  return (
    <div className="space-y-2">
      {/* QRCodeDisplay centers itself on a Material surface card. */}
      <QRCodeDisplay url={url} />
      {/* The link stays visible, not hidden behind a copy button: users paste it into
          a chat app, it is the fallback when there is no camera to scan the QR, and a
          clipboard-only UI would be untestable. */}
      <div className="flex items-center gap-1">
        <input
          data-testid="rendezvous-url"
          className="w-full min-w-0 text-xs p-3 rounded-xl font-mono bg-surface-container-highest text-on-surface-variant border border-outline-variant"
          value={url}
          readOnly
          onClick={(e: any) => e.currentTarget.select()}
        />
        <button
          aria-label="Copy link"
          title="Copy link"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
          onClick={() => navigator.clipboard.writeText(url).then(
            () => showToast('Link copied to clipboard'),
            () => showToast('Failed to copy link'),
          )}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>content_copy</span>
        </button>
      </div>
      {payloadBytes !== undefined && (
        <p className="md-body-medium text-on-surface-variant text-center">
          Sending ~{formatBytes(payloadBytes)} to the other device.
        </p>
      )}
      <RendezvousProgress
        phase={phase}
        rendezvousId={rendezvousId}
        waitingLabel={waitingLabel}
        transferLabel={transferLabel}
        transferDetail={transferDetail}
        doneLabel={doneLabel}
        errorMessage={error || null}
      />
    </div>
  );
}
