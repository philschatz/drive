/**
 * Add Friend page — handles QR-code-based contact sharing.
 *
 * URL format: /#/add-friend/{base64url-encoded-contact-card}
 *
 * Flow:
 * 1. Decode the contact card from the URL
 * 2. Call receiveContactCard to add them as a known contact
 * 3. Let the user assign a human-readable name
 */

import { useState, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { receiveContactCard } from '../shared/keyhive-api';
import { setContactName } from '../contact-names';
import { deflate, inflate } from 'pako';

interface AddFriendPageProps {
  cardData?: string;
  path?: string;
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

export function AddFriendPage({ cardData }: AddFriendPageProps) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A contact is identified by its user-group id (its share target), never by a
  // bare individual device id.
  const [contactGroupId, setContactGroupId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [processing, setProcessing] = useState(false);

  const doReceive = useCallback(async () => {
    if (!cardData) {
      setError('Invalid link — missing contact card data.');
      return;
    }
    setProcessing(true);
    setError(null);

    try {
      setStatus('Decoding contact card...');
      const { cardJson, displayName, userGroupId } = decodeFriendData(cardData);
      if (!userGroupId) {
        throw new Error('This contact is not a group \u2014 ask them to open Settings and show a fresh friend QR/link.');
      }

      setStatus('Adding contact...');
      const result = await receiveContactCard(cardJson, { userGroupId });
      if (result.isOwnCard) {
        setError("This is your own contact card. Share this link with a friend \u2014 don't open it yourself.");
        return;
      }
      // Identify the contact by its user-group id, never the individual device id.
      setContactGroupId(result.userGroupId ?? userGroupId);
      if (displayName) setName(displayName);

      setStatus('Contact added. Give them a name so you can recognize them later.');
    } catch (err: any) {
      setError(err.message || 'Failed to add contact');
    } finally {
      setProcessing(false);
    }
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

  // Auto-start on first render
  if (!status && !error && !contactGroupId && !processing) {
    doReceive();
  }

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 24 }}>person_add</span>
        Add Friend
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p className="mb-2">{error}</p>
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
            {name.trim() ? `${name.trim()} has been added as a contact.` : 'Contact added.'}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            You can now share documents with them from any document's sharing panel.
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
      ) : (
        <p className="text-sm text-muted-foreground">{status || 'Processing...'}</p>
      )}
    </div>
  );
}
