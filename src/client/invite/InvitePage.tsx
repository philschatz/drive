/**
 * Invite claiming page.
 *
 * URL format: /#/invite/{docId}/{payloadBase64url}
 *
 * The payload contains an invite seed + inviter's keyhive archive.
 * It's in the URL fragment (after the hash) so it's never sent to the server.
 *
 * Claiming flow:
 * 1. Decode the payload (seed + archive)
 * 2. Send to worker which reconstructs the invite identity
 * 3. Worker ingests archive, delegates access to this device's real identity
 * 4. Add document to local storage and redirect to it
 */

import { useState, useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { addDocId, getDocEntry } from '@/doc-storage';
import { claimInvite } from '../../shared/keyhive-api';

interface InvitePageProps {
  docId?: string;
  docType?: string;
  inviteKey?: string;
  path?: string;
}

function decodePayload(b64url: string): { seed: Uint8Array; archive: Uint8Array } {
  console.log('[InvitePage] decodePayload: b64url.length=', b64url.length);
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const seedLen = view.getUint32(0);
  const seed = bytes.slice(4, 4 + seedLen);
  const archive = bytes.slice(4 + seedLen);
  console.log('[InvitePage] decodePayload: totalBytes=', bytes.length, 'seedLen=', seedLen, 'archiveLen=', archive.length);
  return { seed, archive };
}

function docRoute(docId: string, type?: string): string {
  switch (type) {
    case 'Calendar': return `/calendars/${docId}`;
    case 'TaskList': return `/tasks/${docId}`;
    case 'DataGrid': return `/datagrids/${docId}`;
    default: return `/source/${docId}`;
  }
}

export function InvitePage({ docId, docType, inviteKey }: InvitePageProps) {
  const [status, setStatus] = useState('Preparing...');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!docId || !inviteKey) {
      setError('Invalid invite link — missing document ID or invite key.');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setStatus('Decoding invite...');
        const { seed, archive } = decodePayload(inviteKey);

        setStatus('Claiming access...');
        const result = await claimInvite(Array.from(seed), Array.from(archive), docId);

        if (cancelled) return;

        setStatus('Adding document...');
        const entry = getDocEntry(docId);
        addDocId(docId, {
          ...entry,
          encrypted: true,
          khDocId: result.khDocId,
        });

        setDone(true);
        setStatus('Invite claimed! Redirecting...');

        const type = docType ?? entry?.type;
        setTimeout(() => {
          window.location.hash = docRoute(docId, type);
        }, 800);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to claim invite');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [docId, inviteKey]);

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 24 }}>link</span>
        Accepting Invite
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p className="mb-2">{error}</p>
          <Button variant="outline" onClick={() => { window.location.hash = '/'; }}>
            Go home
          </Button>
        </div>
      ) : (
        <div>
          <p className="text-sm text-muted-foreground mb-4">{status}</p>
          {done && (
            <p className="text-sm text-green-600 font-medium">
              <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 16 }}>check_circle</span>
              Access granted
            </p>
          )}
        </div>
      )}
    </div>
  );
}
