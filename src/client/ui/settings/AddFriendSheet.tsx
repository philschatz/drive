/**
 * Add Friend — bottom sheet.
 *
 * Opened contextually (Sharing page, Settings, Friends) instead of a route.
 * The rendezvous auto-starts on open (no "Start the process" button): once
 * keyhive + the relay socket are ready and a user group exists, it shows the
 * QR/link.
 *
 * When a friend completes the exchange the sheet resolves itself: a snackbar if
 * they sent a name, otherwise the QR block is *replaced in place* by a name field
 * so we can label them. Then `onAdded` fires with their user-group id and the sheet
 * closes. Closing unmounts RendezvousShare, which cancels the rendezvous.
 *
 * The name field is an inline `FieldEditor` rather than a `RenameSheet` on purpose:
 * a RenameSheet would be a sheet over this sheet, and this one is about to close.
 * Its testids match RenameSheet's fixed stems (`rename-input`, `rename-save`), so a
 * spec doesn't need to know which of the two surfaces it is driving.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { getIdentity, ensureUserGroup, rendezvousCreateShare } from '../common/keyhive-api';
import { getFriendName, setFriendName } from '../friend-names';
import { keyhiveReady, whenWsConnected } from '../common/automerge';
import { FieldEditor } from '../common/FieldEditor';
import { MdTextField } from '@/components/ui/md-text-field';
import { showToast } from '@/components/ui/toast';
import { RendezvousShare } from './RendezvousShare';
import { buildAddFriendRendezvousUrl } from './rendezvous-urls';

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
  /** Set to the new friend's group id once they arrive without a name. */
  const [nameFor, setNameFor] = useState<string | null>(null);
  // The completion runs off a worker event, so guard against it resolving twice.
  const handledRef = useRef(false);

  // Prepare the share as soon as the sheet opens (replaces "Start the process"),
  // and reset everything when it closes so the next open stages a fresh rendezvous.
  useEffect(() => {
    if (!open) {
      setReady(false);
      setNameFor(null);
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
   * The exchange completed. If they sent a name we're done; otherwise stay open and
   * swap the QR block for a name field.
   */
  const handleReceived = ({ groupId, hasName }: { groupId: string; hasName: boolean }) => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (hasName) {
      // The worker persisted the name before emitting the event, so the cache
      // has it; fall back in case that push hasn't landed yet.
      showToast(`${getFriendName(groupId) ?? 'Your friend'} was added.`, { testId: 'friend-added-toast' });
      onAdded?.(groupId);
      onOpenChange(false);
    } else {
      setNameFor(groupId);
    }
  };

  /**
   * Finish the naming step. `name` undefined means "don't name them" — the same
   * thing cancelling the old prompt did. Either way the friend is already added;
   * only the label is optional.
   */
  const settle = async (groupId: string, name?: string) => {
    if (name) {
      try {
        await setFriendName(groupId, name);
      } catch (err: any) {
        setError('Could not save the name: ' + (err?.message ?? 'storage error'));
      }
    }
    showToast(name ? `${name} was added.` : 'Friend added.', { testId: 'friend-added-toast' });
    setNameFor(null);
    // onAdded before the close, because callers (SharingPage) read their pending
    // state on close and open a follow-up sheet from it.
    onAdded?.(groupId);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="add-friend-sheet">
          <SheetHeader>
            <SheetTitle className="pr-8">
              {nameFor ? 'Name this friend' : 'Invite a friend'}
            </SheetTitle>
          </SheetHeader>

          {!nameFor && (
            <p className="md-body-medium text-on-surface-variant mt-3 mb-3 max-w-md">
              Show this QR code to a friend so they can add you and share documents with you.
            </p>
          )}

          {savedName && !nameFor && (
            <p className="md-body-medium mb-3">
              Sharing as: <span className="font-medium">{savedName}</span>
            </p>
          )}

          {error && (
            <div
              className="flex items-start gap-3 p-3 mb-3 rounded-xl bg-error-container text-on-error-container"
              data-testid="add-friend-error"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>error</span>
              <p className="md-body-medium min-w-0">{error}</p>
            </div>
          )}

          {nameFor ? (
            // Replaces the QR block rather than opening a second sheet. Unmounting
            // RendezvousShare also cancels the rendezvous, which is right — the
            // exchange has already completed.
            <div className="mt-2 max-w-sm">
              <p className="md-body-medium text-on-surface-variant mb-3">
                They didn’t send a name. Give them one, or skip — you can rename them later.
              </p>
              <FieldEditor
                value=""
                data-testid="rename"
                onSave={v => settle(nameFor, v.trim() || undefined)}
                onCancel={() => settle(nameFor, undefined)}
              >
                {({ value, onInput, save }) => (
                  <MdTextField
                    label="Name"
                    id="rename-input"
                    data-testid="rename-input"
                    value={value}
                    onInput={onInput}
                    onEnter={save}
                  />
                )}
              </FieldEditor>
            </div>
          ) : ready ? (
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
            !error && (
              <p className="md-body-medium text-on-surface-variant">Preparing your share link…</p>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
