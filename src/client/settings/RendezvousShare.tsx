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
 */

import { useState, useEffect } from 'preact/hooks';
import { rendezvousCancel, onRendezvousEvent } from '../shared/keyhive-api';
import { QRCodeDisplay } from '@/components/ui/qr-code';

interface RendezvousShareProps {
  /** Stage the share in the worker and return the rendezvous id+key. */
  create: () => Promise<{ rendezvousId: string; key: string }>;
  /** Build the QR/link URL from the id+key. */
  buildUrl: (rendezvousId: string, key: string) => string;
  /** Event status(es) that mean the handshake completed (e.g. 'sent', 'linked'). */
  doneStatuses: string[];
  waitingLabel: string;
  doneLabel: string;
}

export function RendezvousShare({ create, buildUrl, doneStatuses, waitingLabel, doneLabel }: RendezvousShareProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let rid = '';
    let cancelled = false;
    const offEvent = onRendezvousEvent((e) => {
      if (e.rendezvousId !== rid) return;
      if (e.status === 'error') setError(e.message ?? 'Something went wrong.');
      else if (doneStatuses.includes(e.status)) setDone(true);
    });
    create()
      .then(({ rendezvousId, key }) => {
        if (cancelled) { rendezvousCancel(rendezvousId); return; }
        rid = rendezvousId;
        setUrl(buildUrl(rendezvousId, key));
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

  if (error) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (!url) {
    return <p className="text-xs text-muted-foreground">Preparing share link…</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-center">
        <QRCodeDisplay url={url} />
      </div>
      <input
        className="w-full text-xs p-2 rounded border border-border font-mono bg-muted"
        value={url}
        readOnly
        onClick={(e: any) => e.currentTarget.select()}
      />
      <p className="text-xs text-muted-foreground">{done ? doneLabel : waitingLabel}</p>
    </div>
  );
}
