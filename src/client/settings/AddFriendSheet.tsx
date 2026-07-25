/**
 * Add Friend — bottom sheet.
 *
 * Opened contextually (Sharing panel, Settings, Contacts) instead of a route.
 * The rendezvous auto-starts on open (no "Start the process" button): once
 * keyhive + the relay socket are ready and a user group exists, it shows the
 * QR/link. When a friend completes the exchange, `onAdded` fires with their
 * user-group id so the caller can use them immediately (e.g. auto-select them
 * in the share dropdown). Closing the sheet unmounts RendezvousShare, which
 * cancels the rendezvous.
 */

import { useState, useEffect } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { getIdentity, ensureUserGroup, rendezvousCreateShare } from '../shared/keyhive-api';
import { getContactName, setContactName } from '../contact-names';
import { keyhiveReady, whenWsConnected } from '../shared/automerge';
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
  // The friend we added back once the exchange completes; when they sent no name
  // we prompt for one here (the sharer has no other chance to label them).
  const [contact, setContact] = useState<{ groupId: string; hasName: boolean } | null>(null);
  const [contactName, setContactNameInput] = useState('');
  const [contactSaved, setContactSaved] = useState(false);

  // Prepare the share as soon as the sheet opens (replaces "Start the process"),
  // and reset everything when it closes so the next open stages a fresh rendezvous.
  useEffect(() => {
    if (!open) {
      setReady(false);
      setContact(null);
      setContactNameInput('');
      setContactSaved(false);
      setError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await keyhiveReady;
        const id = await getIdentity();
        if (cancelled) return;
        setSavedName((id.userGroupId && getContactName(id.userGroupId)) || '');
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

  const handleSaveContact = async () => {
    if (!contact) return;
    const trimmed = contactName.trim();
    if (trimmed) {
      try {
        await setContactName(contact.groupId, trimmed);
      } catch (err: any) {
        setError('Could not save the name: ' + (err?.message ?? 'storage error'));
        return;
      }
    }
    setContactSaved(true);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Add a friend</SheetTitle>
        </SheetHeader>

        <p className="text-sm text-muted-foreground mt-3 mb-3 max-w-md">
          Show this QR code to a friend so they can add you as a contact and share documents with you.
        </p>

        {savedName ? (
          <p className="text-sm mb-3">Sharing as: <span className="font-medium">{savedName}</span></p>
        ) : (
          <p className="text-sm text-muted-foreground mb-3">
            No name set — <a href="#/settings" className="underline hover:text-foreground">set your name in Settings</a> so
            your friend can recognize you (optional).
          </p>
        )}

        {error && <p className="text-sm text-destructive mb-3">{error}</p>}

        {ready ? (
          <div className="max-w-sm">
            <RendezvousShare
              create={() => rendezvousCreateShare(savedName || undefined)}
              buildUrl={buildAddFriendRendezvousUrl}
              waitingLabel="Waiting for your friend to open the link…"
              transferLabel="Exchanging contact info…"
              doneLabel="Connected — you're now contacts."
              onReceivedContact={(info) => { setContact(info); onAdded?.(info.groupId); }}
            />

            {contact && !contact.hasName && !contactSaved && (
              <div className="mt-4">
                <p className="text-sm text-muted-foreground mb-2">
                  Your friend didn’t share a name. Add one so you can recognize them later.
                </p>
                <div className="flex gap-2">
                  <input
                    className="flex-1 text-sm p-2 rounded border border-border"
                    value={contactName}
                    onInput={(e: any) => setContactNameInput(e.currentTarget.value)}
                    onKeyDown={(e: any) => { if (e.key === 'Enter') handleSaveContact(); }}
                    placeholder="Enter a name for this contact..."
                    autoFocus
                  />
                  <Button size="sm" onClick={handleSaveContact}>Save</Button>
                </div>
              </div>
            )}

            {contactSaved && (
              <p className="text-sm text-green-600 mt-3">
                <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
                Saved.
              </p>
            )}
          </div>
        ) : (
          !error && <p className="text-sm text-muted-foreground">Preparing your share link…</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
