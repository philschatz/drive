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

import { useState, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { addDocId, getDocEntry } from '@/doc-storage';
import { claimInvite } from '../../shared/keyhive-api';
import { decodeInvitePayload } from './invite-codec';

interface InvitePageProps {
  docId?: string;
  docType?: string;
  inviteKey?: string;
  path?: string;
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
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const doClaim = useCallback(async () => {
    if (!docId || !inviteKey) {
      setError('Invalid invite link — missing document ID or invite key.');
      return;
    }
    setClaiming(true);
    setError(null);

    try {
      setStatus('Decoding invite...');
      const { seed } = decodeInvitePayload(inviteKey);

      setStatus('Syncing keys from relay...');
      const result = await claimInvite(Array.from(seed), docId);

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
      setError(err.message || 'Failed to claim invite');
    } finally {
      setClaiming(false);
    }
  }, [docId, docType, inviteKey]);

  // Auto-start on first render
  if (!status && !error && !done && !claiming) {
    doClaim();
  }

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: 24 }}>link</span>
        Accepting Invite
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p className="mb-2">{error}</p>
          <div className="flex gap-2 justify-center">
            <Button variant="default" onClick={doClaim} disabled={claiming}>
              Retry
            </Button>
            <Button variant="outline" onClick={() => { window.location.hash = '/'; }}>
              Go home
            </Button>
          </div>
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
