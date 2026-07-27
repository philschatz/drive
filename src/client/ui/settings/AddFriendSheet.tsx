/**
 * Add Friend — bottom sheet.
 *
 * Opened contextually (Sharing page, Settings, Contacts) instead of a route.
 * The rendezvous auto-starts on open (no "Start the process" button): once
 * keyhive + the relay socket are ready and a user group exists, it shows the
 * QR/link. When a friend completes the exchange the sheet resolves itself with a
 * native dialog — an alert if they sent a name, a prompt to supply one if they
 * didn't — fires `onAdded` with their user-group id, and closes. Closing
 * unmounts RendezvousShare, which cancels the rendezvous.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { getIdentity, ensureUserGroup, rendezvousCreateShare } from '../common/keyhive-api';
import { getFriendName, setFriendName } from '../friend-names';
import { keyhiveReady, whenWsConnected } from '../common/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildAddFriendRendezvousUrl } from './AddFriendPage';

interface AddFriendSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the new friend's user-group id once the exchange completes. */
  onAdded?: (groupId: string) => void;
}

export function AddFriendSheet({ open, onOpenChange, onAdded }: AddFriendSheetProps) {
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  // ensureUserGroup + WS connect done → mount RendezvousShare (which stages the QR).
  const [ready, setReady] = useState(false);
  // The completion runs off a worker event, so guard against it resolving twice.
  const handledRef = useRef(false);

  // Prepare the share as soon as the sheet opens (replaces "Start the process"),
  // and reset everything when it closes so the next open stages a fresh rendezvous.
  useEffect(() => {
    if (!open) {
      setReady(false);
      handledRef.current = false;
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await keyhiveReady;
        const id = await getIdentity();
        if (cancelled) return;
        setSavedName((id.userGroupId && getFriendName(id.userGroupId)) || '');
        // Gate on the relay socket: a rendezvous subscribe sent before the WS is open
        // is silently dropped, leaving us waiting forever. (Same guard the pages used.)
        await whenWsConnected();
        // A friend can't be granted access without a real group id, so ensure one exists.
        await ensureUserGroup({ create: true });
        if (cancelled) return;
        setReady(true);
      } catch (err: any) {
        if (!cancelled) setError('Could not prepare your share link: ' + (err?.message ?? err));
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  /**
   * The exchange completed. Settle the contact's name in one native dialog so
   * the sheet can close itself, then hand the id to the caller.
   */
  const handleReceived = async ({ groupId, hasName }: { groupId: string; hasName: boolean }) => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (hasName) {
      // The worker persisted the name before emitting the event, so the cache
      // has it; fall back in case that push hasn't landed yet.
      alert(`${getFriendName(groupId) ?? 'Your friend'} was added.`);
    } else {
      const trimmed = prompt('Name this contact', '')?.trim();
      if (trimmed) {
        try {
          await setFriendName(groupId, trimmed);
        } catch (err: any) {
          setError('Could not save the name: ' + (err?.message ?? 'storage error'));
        }
      }
    }
    onAdded?.(groupId);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Invite a friend</SheetTitle>
        </SheetHeader>

        <p className="text-sm text-muted-foreground mt-3 mb-3 max-w-md">
          Show this QR code to a friend so they can add you and share documents with you.
        </p>

        {savedName && (
          <p className="text-sm mb-3">Sharing as: <span className="font-medium">{savedName}</span></p>
        )}

        {error && <p className="text-sm text-destructive mb-3">{error}</p>}

        {ready ? (
          <div className="max-w-sm">
            <RendezvousShare
              create={() => rendezvousCreateShare(savedName || undefined)}
              buildUrl={buildAddFriendRendezvousUrl}
              waitingLabel="Waiting for your friend to open the link…"
              transferLabel="Exchanging details…"
              doneLabel="Connected — you're now friends."
              onReceivedContact={handleReceived}
            />
          </div>
        ) : (
          !error && <p className="text-sm text-muted-foreground">Preparing your share link…</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
