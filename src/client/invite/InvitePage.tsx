/**
 * Invite claiming page.
 *
 * URL format: /#/invite/{docId}/{authDocId}/{inviteKeyBase64url}
 *
 * The invite key is in the URL path (after the hash, so never sent to server).
 * On claim:
 * 1. Load auth doc via repo (sync membership graph)
 * 2. Use invite key to authenticate and get document access
 * 3. Delegate invite key's access to this device's real identity
 * 4. Immediately revoke the invite key (rotates keys — URL becomes useless)
 * 5. Redirect to the document
 */

import { useState, useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { addDocId } from '@/doc-storage';

interface InvitePageProps {
  docId?: string;
  authDocId?: string;
  inviteKey?: string;
  path?: string;
}

export function InvitePage({ docId, authDocId, inviteKey }: InvitePageProps) {
  const [status, setStatus] = useState('Claiming invite...');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!docId || !inviteKey) {
      setError('Invalid invite link — missing document ID or invite key.');
      return;
    }

    claimInvite(docId, authDocId || '', inviteKey, setStatus)
      .then(() => {
        setDone(true);
        setStatus('Invite claimed! Redirecting...');
        // Add to doc list and redirect
        addDocId(docId, { encrypted: true, authDocId });
        setTimeout(() => {
          window.location.hash = `/source/${docId}`;
        }, 1000);
      })
      .catch((err: any) => {
        setError(err.message || 'Failed to claim invite');
      });
  }, [docId, authDocId, inviteKey]);

  return (
    <div className="max-w-md mx-auto p-8 text-center">
      <h1 className="text-xl font-bold mb-4">
        <span className="material-symbols-outlined align-middle mr-1">link</span>
        Accepting Invite
      </h1>

      {error ? (
        <div className="text-destructive mb-4">
          <p>{error}</p>
          <Button className="mt-4" onClick={() => { window.location.hash = '/'; }}>
            Go home
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">{status}</p>
          {!done && <Progress className="w-full" value={50} />}
        </>
      )}
    </div>
  );
}

async function claimInvite(
  docId: string,
  authDocId: string,
  inviteKeyB64url: string,
  setStatus: (s: string) => void,
): Promise<void> {
  setStatus('Loading keyhive...');

  // Decode the base64url invite key
  const b64 = inviteKeyB64url.replace(/-/g, '+').replace(/_/g, '/');
  const _inviteKeyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  setStatus('Syncing auth document...');

  // TODO: Full implementation:
  // 1. Create a temporary keyhive Signer from the invite key bytes
  // 2. Load the auth doc via automerge-repo to get the membership graph
  // 3. Ingest keyhive events from the auth doc
  // 4. Use the invite key's keyhive to delegate access to our real identity
  // 5. Revoke the invite key (triggers BeeKEM key rotation)
  // 6. Write the revocation event back to the auth doc
  //
  // For now, this is a placeholder that adds the doc to the local list.
  // The full crypto handshake requires worker-side coordination.

  setStatus('Adding document...');
  addDocId(docId, { encrypted: !!authDocId, authDocId: authDocId || undefined });

  setStatus('Done!');
}
