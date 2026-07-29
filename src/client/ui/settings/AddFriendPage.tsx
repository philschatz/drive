/**
 * Add Friend page — the receiving side of a QR friend invite.
 *
 * URL forms:
 *   /#/add-friend/r.<rendezvousId>.<key>   ← preferred: tiny QR; the real (large)
 *       contact bundle is fetched over an encrypted relay rendezvous (the only
 *       form that works for established accounts whose bundle exceeds QR capacity).
 *   /#/add-friend/<base64url-deflated-card> ← legacy: bundle embedded in the URL.
 *
 * Flow: pull the contact card (via rendezvous or the URL), receiveContactCard to
 * add them as a known contact, then settle their name and go to Friends. Only the
 * failure path stays on screen, so it can offer a retry.
 *
 * **Navigation is a continuation, never a fallthrough.** The naming step used to be
 * a `prompt()`, and the code relied on it *blocking* before assigning
 * `location.hash`. A sheet doesn't block, so `doReceive` no longer navigates at all:
 * it ends by setting `outcome`, and the render (or the sheet's callbacks) decide
 * what happens next. Leaving from the toast-only branch is safe because <Toaster/>
 * is mounted in App.tsx *outside* the router, so the snackbar outlives this page's
 * unmount — which is exactly why toast-then-navigate is legal where
 * sheet-then-navigate is not.
 */

import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { receiveContactCard, rendezvousReceive, getIdentity, onRendezvousEvent } from '../common/keyhive-api';
import type { RendezvousStatus } from '../worker-api';
import { keyhiveReady, whenWsConnected } from '../common/automerge';
import { setFriendName, getFriendName } from '../friend-names';
import { RenameSheet } from '../common/RenameSheet';
import { showToast } from '@/components/ui/toast';
import { RendezvousProgress } from './RendezvousProgress';
import { parseRendezvousToken } from '../../../shared/rendezvous-url';
import { decodeFriendData } from './rendezvous-urls';

interface AddFriendPageProps {
  cardData?: string;
  path?: string;
}

/** The friend is added; all that's left is deciding what to call them. */
type Outcome =
  | { kind: 'named'; groupId: string; displayName: string }
  | { kind: 'needs-name'; groupId: string };

export function AddFriendPage({ cardData }: AddFriendPageProps) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<RendezvousStatus | null>(null);
  const [transferDetail, setTransferDetail] = useState<string>();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // RenameSheet's onSave fires onRename and THEN onClose, so without this a single
  // Save would toast twice and navigate twice.
  const settledRef = useRef(false);

  const leave = () => { window.location.hash = '/friends'; };

  // Rendezvous receive path (preferred): the tiny QR carries only {id, key}.
  const rdv = cardData ? parseRendezvousToken(cardData) : null;

  // Subscribe to progress for this channel so the receiver shows the same
  // step-by-step indicator (and channel id) the sharer does.
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

  const doReceive = useCallback(async () => {
    if (!cardData) {
      setError('Invalid link — missing friend data.');
      return;
    }
    setProcessing(true);
    setError(null);

    try {
      let cardResult: { isOwnCard: boolean; userGroupId: string | null; alreadyKnown: boolean };
      let displayName: string | undefined;

      if (rdv) {
        // Preferred path: fetch the bundle over the encrypted relay rendezvous.
        // Pass our own name so the friend (who we add back automatically) can
        // label us without a second exchange.
        setStatus('Connecting to your friend\u2026 (keep this open until it completes)');
        // Cold-open guard: this page auto-runs on mount, so wait for keyhive AND the
        // relay socket before subscribing \u2014 an overlay frame (the rendezvous subscribe)
        // sent before the WS is open is silently dropped, leaving us waiting forever
        // for a peer that never arrives. The sharer gates its Start button the same way.
        await keyhiveReady;
        await whenWsConnected();
        // Our own name is stored as a User Group contact (keyed by user-group id).
        const me = await getIdentity();
        const myName = (me.userGroupId && getFriendName(me.userGroupId)) || undefined;
        const result = await rendezvousReceive(rdv.rendezvousId, rdv.key, myName);
        cardResult = result;
        displayName = result.displayName;
      } else {
        // Legacy path: the bundle is embedded in the URL.
        setStatus('Decoding friend details...');
        const decoded = decodeFriendData(cardData);
        if (!decoded.userGroupId) {
          throw new Error('This friend is not a group \u2014 ask them to open Settings and show a fresh friend QR/link.');
        }
        setStatus('Adding friend...');
        const result = await receiveContactCard(decoded.cardJson, { userGroupId: decoded.userGroupId });
        cardResult = { isOwnCard: result.isOwnCard, userGroupId: result.userGroupId ?? decoded.userGroupId, alreadyKnown: result.alreadyKnown };
        displayName = decoded.displayName;
      }

      if (cardResult.isOwnCard) {
        setError("This is your own invite. Share this link with a friend \u2014 don't open it yourself.");
        return;
      }
      if (!cardResult.userGroupId) {
        throw new Error('This friend is not a group \u2014 ask them to open Settings and show a fresh friend QR/link.');
      }
      // Identify the contact by its user-group id, never the individual device id.
      // No navigation here — see the header: the outcome decides, not this function.
      setOutcome(displayName
        ? { kind: 'named', groupId: cardResult.userGroupId, displayName }
        : { kind: 'needs-name', groupId: cardResult.userGroupId });
    } catch (err: any) {
      setError(err.message || 'Failed to add friend');
    } finally {
      setProcessing(false);
    }
    // `rdv` is derived from cardData; depending on it would rebuild this each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardData]);

  // Auto-start once when the page mounts with card data.
  useEffect(() => { doReceive(); }, [doReceive]);

  // They sent a name, so there is nothing to ask: confirm and go.
  useEffect(() => {
    if (outcome?.kind !== 'named' || settledRef.current) return;
    settledRef.current = true;
    showToast(`${outcome.displayName} was added.`, { testId: 'friend-added-toast' });
    leave();
  }, [outcome]);

  /**
   * Finish the naming step. `name` undefined means "don't name them" — what
   * cancelling the old prompt did. A storage failure keeps the user here with the
   * error visible rather than bouncing them to Friends with nothing shown.
   */
  const finishNaming = async (name?: string) => {
    if (settledRef.current || outcome?.kind !== 'needs-name') return;
    settledRef.current = true;
    if (name) {
      try {
        await setFriendName(outcome.groupId, name);
      } catch (err: any) {
        settledRef.current = false;
        setError('Could not save the name: ' + (err?.message ?? 'storage error'));
        setOutcome(null);
        return;
      }
    }
    showToast(name ? `${name} was added.` : 'Friend added.', { testId: 'friend-added-toast' });
    leave();
  };

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      {/* Top app bar. `close`, not `arrow_back`: this page is reached by opening a
          link, so the route IS the first history entry and a back arrow would be a
          lie. Rendered always, including mid-handshake — there used to be no exit
          at all until the flow finished, so a stalled exchange trapped the user. */}
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href="#/friends"
          aria-label="Close"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>close</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Add friend</h1>
      </div>

      <div className="px-4 max-w-md">
        {error ? (
          <>
            {/* Inline, not a snackbar: a failure with a Retry has to stay put. */}
            <div
              className="flex items-start gap-3 p-3 rounded-xl bg-error-container text-on-error-container"
              data-testid="add-friend-error"
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
              <Button onClick={doReceive} disabled={processing} data-testid="add-friend-retry">
                Retry
              </Button>
              <Button variant="outline" onClick={() => { window.location.hash = '/friends'; }}>
                Friends
              </Button>
            </div>
          </>
        ) : rdv ? (
          <RendezvousProgress
            phase={phase}
            rendezvousId={rdv.rendezvousId}
            waitingLabel="Connecting to your friend — keep this open…"
            transferLabel="Exchanging details…"
            transferDetail={transferDetail}
            doneLabel="You're now friends."
          />
        ) : (
          <p className="md-body-medium text-on-surface-variant">{status || 'Processing…'}</p>
        )}
      </div>

      {/* A page, not a sheet, so RenameSheet works directly here. Both callbacks
          route through finishNaming, which owns the single navigation. */}
      <RenameSheet
        open={outcome?.kind === 'needs-name'}
        title="Name this friend"
        label="Name"
        value=""
        allowEmpty
        onRename={name => finishNaming(name || undefined)}
        onClose={() => finishNaming(undefined)}
        data-testid="name-friend-sheet"
      />
    </div>
  );
}
