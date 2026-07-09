/**
 * Add Friend page — handles QR-code-based contact sharing.
 *
 * URL forms:
 *   /#/add-friend/r.<rendezvousId>.<key>   ← preferred: tiny QR; the real (large)
 *       contact bundle is fetched over an encrypted relay rendezvous (the only
 *       form that works for established accounts whose bundle exceeds QR capacity).
 *   /#/add-friend/<base64url-deflated-card> ← legacy: bundle embedded in the URL.
 *
 * Flow: pull the contact card (via rendezvous or the URL), receiveContactCard to
 * add them as a known contact, then let the user assign a human-readable name.
 */

import { useState, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { receiveContactCard, rendezvousReceive, getIdentity, onRendezvousEvent } from '../shared/keyhive-api';
import type { RendezvousStatus } from '../worker-api';
import { setContactName, getContactName } from '../contact-names';
import { RendezvousProgress } from './RendezvousProgress';
import { deflate, inflate } from 'pako';

/** Parse the rendezvous URL form `r.<id>.<key>` (base64url parts; '.' separates). */
function parseRendezvous(cardData: string): { rendezvousId: string; key: string } | null {
  if (!cardData.startsWith('r.')) return null;
  const parts = cardData.split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { rendezvousId: parts[1], key: parts[2] };
}

export function buildAddFriendRendezvousUrl(rendezvousId: string, key: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/add-friend/r.${rendezvousId}.${key}`;
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCardFromUrl(b64url: string): string {
  return new TextDecoder().decode(inflate(b64urlToBytes(b64url)));
}

export function encodeCardForUrl(cardJson: string): string {
  const compressed = deflate(new TextEncoder().encode(cardJson));
  return bytesToB64url(compressed);
}

export function buildAddFriendUrl(cardJson: string, displayName?: string, userGroupId?: string | null): string {
  const payload = (displayName || userGroupId)
    ? JSON.stringify({ card: cardJson, displayName, userGroupId: userGroupId ?? undefined })
    : cardJson;
  const base = window.location.origin + window.location.pathname;
  return `${base}#/add-friend/${encodeCardForUrl(payload)}`;
}

function decodeFriendData(b64url: string): { cardJson: string; displayName?: string; userGroupId?: string } {
  const raw = decodeCardFromUrl(b64url);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
      return { cardJson: parsed.card, displayName: parsed.displayName, userGroupId: parsed.userGroupId };
    }
  } catch {
    // Not the wrapper format — old-style raw card
  }
  return { cardJson: raw };
}

export function AddFriendPage() {
  const { cardData } = useParams();
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A contact is identified by its user-group id (its share target), never by a
  // bare individual device id.
  const [contactGroupId, setContactGroupId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [phase, setPhase] = useState<RendezvousStatus | null>(null);
  const [transferDetail, setTransferDetail] = useState<string>();

  // Rendezvous receive path (preferred): the tiny QR carries only {id, key}.
  const rdv = cardData ? parseRendezvous(cardData) : null;

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
      setError('Invalid link — missing contact card data.');
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
        // Our own name is stored as a User Group contact (keyed by user-group id).
        const me = await getIdentity();
        const myName = (me.userGroupId && getContactName(me.userGroupId)) || undefined;
        const result = await rendezvousReceive(rdv.rendezvousId, rdv.key, myName);
        cardResult = result;
        displayName = result.displayName;
      } else {
        // Legacy path: the bundle is embedded in the URL.
        setStatus('Decoding contact card...');
        const decoded = decodeFriendData(cardData);
        if (!decoded.userGroupId) {
          throw new Error('This contact is not a group \u2014 ask them to open Settings and show a fresh friend QR/link.');
        }
        setStatus('Adding contact...');
        const result = await receiveContactCard(decoded.cardJson, { userGroupId: decoded.userGroupId });
        cardResult = { isOwnCard: result.isOwnCard, userGroupId: result.userGroupId ?? decoded.userGroupId, alreadyKnown: result.alreadyKnown };
        displayName = decoded.displayName;
      }

      if (cardResult.isOwnCard) {
        setError("This is your own contact card. Share this link with a friend \u2014 don't open it yourself.");
        return;
      }
      if (!cardResult.userGroupId) {
        throw new Error('This contact is not a group \u2014 ask them to open Settings and show a fresh friend QR/link.');
      }
      // Identify the contact by its user-group id, never the individual device id.
      setContactGroupId(cardResult.userGroupId);
      if (displayName) setName(displayName);
      setStatus('You added each other. Give them a name so you can recognize them later.');
    } catch (err: any) {
      setError(err.message || 'Failed to add contact');
    } finally {
      setProcessing(false);
    }
    // `rdv` is derived from cardData; depending on it would rebuild this each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardData]);

  const handleSave = async () => {
    if (!contactGroupId) return;
    if (name.trim()) {
      try {
        await setContactName(contactGroupId, name.trim());
      } catch (err: any) {
        setError(`Failed to save contact: ${err?.message ?? 'storage error'}`);
        return;
      }
    }
    setSaved(true);
  };

  // Auto-start once when the page mounts with card data.
  useEffect(() => { doReceive(); }, [doReceive]);

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 24 }}>person_add</span>
        Add Friend
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p className="mb-2">{error}</p>
          {rdv && (
            <p className="text-[10px] text-muted-foreground mb-2">
              Channel: <code className="font-mono">{rdv.rendezvousId.slice(0, 8)}…</code>
            </p>
          )}
          <div className="flex gap-2 justify-center">
            <Button variant="default" onClick={doReceive} disabled={processing}>
              Retry
            </Button>
            <Button variant="outline" onClick={() => { window.location.hash = '/'; }}>
              Home
            </Button>
          </div>
        </div>
      ) : saved ? (
        <div>
          <p className="text-sm text-green-600 font-medium mb-4">
            <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
            {name.trim() ? `You and ${name.trim()} are now contacts.` : "You're now contacts."}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            You added each other in one step — you can both share documents from any
            document's sharing panel.
          </p>
          <Button variant="outline" onClick={() => { window.location.hash = '/'; }}>
            Home
          </Button>
        </div>
      ) : contactGroupId ? (
        <div>
          <p className="text-sm text-green-600 font-medium mb-4">
            <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
            Contact received
          </p>
          <p className="text-sm text-muted-foreground mb-3">{status}</p>
          <div className="mb-4">
            <input
              className="w-full text-sm p-2 rounded border border-border"
              value={name}
              onInput={(e: any) => setName(e.currentTarget.value)}
              onKeyDown={(e: any) => { if (e.key === 'Enter') handleSave(); }}
              placeholder="Enter a name for this contact..."
              autoFocus
            />
          </div>
          <div className="flex gap-2 justify-center">
            <Button variant="default" onClick={handleSave}>
              {name.trim() ? 'Save' : 'Skip'}
            </Button>
          </div>
        </div>
      ) : rdv ? (
        <RendezvousProgress
          phase={phase}
          rendezvousId={rdv.rendezvousId}
          waitingLabel="Connecting to your friend — keep this open…"
          transferLabel="Exchanging contact info…"
          transferDetail={transferDetail}
          doneLabel="You're now contacts."
        />
      ) : (
        <p className="text-sm text-muted-foreground">{status || 'Processing...'}</p>
      )}
    </div>
  );
}
