/**
 * Sharer-side QR for the encrypted relay rendezvous.
 *
 * Stages this device's contact bundle for a rendezvous and renders the tiny
 * {id,key} as a QR + link. When the other peer opens the link, the worker sends
 * the (possibly large) bundle over the relay automatically and we show a
 * confirmation. Used both in Settings ("Share me with a friend") and on the
 * AddFriendPage success screen ("let them add you back").
 *
 * The QR stays tiny regardless of account size — the bundle never touches the URL.
 */

import { useState, useEffect } from 'preact/hooks';
import { rendezvousCreateShare, rendezvousCancel, onRendezvousEvent } from '../shared/keyhive-api';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { buildAddFriendRendezvousUrl } from './AddFriendPage';

export function ReciprocalShare({ displayName }: { displayName?: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let rid = '';
    let cancelled = false;
    const offEvent = onRendezvousEvent((e) => {
      if (e.rendezvousId !== rid) return;
      if (e.status === 'sent') setSent(true);
      else if (e.status === 'error') setError(e.message ?? 'Failed to send your contact info.');
    });
    rendezvousCreateShare(displayName?.trim() || undefined)
      .then(({ rendezvousId, key }) => {
        if (cancelled) { rendezvousCancel(rendezvousId); return; }
        rid = rendezvousId;
        setUrl(buildAddFriendRendezvousUrl(rendezvousId, key));
      })
      .catch((err: any) => setError(err?.message ?? 'Could not create a share link.'));
    return () => {
      cancelled = true;
      offEvent();
      if (rid) rendezvousCancel(rid);
    };
  }, [displayName]);

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
      <p className="text-xs text-muted-foreground">
        {sent
          ? '✓ Sent — they have your contact info.'
          : 'Keep this open until your friend opens the link.'}
      </p>
    </div>
  );
}
