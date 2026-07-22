/**
 * Add Friend (sharer side) — its own page.
 *
 * Shows the user's saved name (set in Settings, read-only here) and, once the user
 * clicks "Start the process", an encrypted-relay rendezvous QR so a friend can add
 * them as a contact. The user group is created on demand so the shared bundle
 * carries a real group id (a friend can't be granted doc access without it).
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { getIdentity, ensureUserGroup, rendezvousCreateShare } from '../shared/keyhive-api';
import { getContactName } from '../contact-names';
import { keyhiveReady, useWsStatus } from '../shared/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildAddFriendRendezvousUrl } from './AddFriendPage';

export function ShareWithFriendPage({ path }: { path?: string }) {
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  // Bump to (re)mount RendezvousShare; >0 means the share has been started.
  const [started, setStarted] = useState(0);
  const connected = useWsStatus('');

  const load = useCallback(async () => {
    try {
      await keyhiveReady;
      const id = await getIdentity();
      setSavedName((id.userGroupId && getContactName(id.userGroupId)) || '');
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleStart = async () => {
    try {
      // A friend can't be granted access without a real group id, so ensure one exists.
      await ensureUserGroup({ create: true });
      setStarted(n => n + 1);
    } catch (err: any) {
      setError('Could not prepare your share link: ' + err.message);
    }
  };

  return (
    <div className="max-w-screen-md mx-auto p-4">
      <div className="flex items-center gap-2 mb-4">
        <a
          href="#/"
          className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </a>
        <h1 className="text-2xl font-bold">Add a Friend</h1>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground mb-3">
        Show this QR code to a friend so they can add you as a contact and share documents with you.
      </p>

      {savedName ? (
        <p className="text-sm mb-3">
          Sharing as: <span className="font-medium">{savedName}</span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground mb-3">
          No name set. <a href="#/settings" className="underline hover:text-foreground">Set your name in Settings</a> so
          your friend can recognize you (optional).
        </p>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={handleStart}
        disabled={!connected}
        title={connected ? undefined : 'Disconnected from the server — reconnect to start the process'}
      >
        Start the process
      </Button>

      {started > 0 && (
        <div className="mt-3">
          <RendezvousShare
            key={started}
            create={() => rendezvousCreateShare(savedName || undefined)}
            buildUrl={buildAddFriendRendezvousUrl}
            waitingLabel="Waiting for your friend to open the link…"
            transferLabel="Exchanging contact info…"
            doneLabel="Connected — you're now contacts."
          />
        </div>
      )}
    </div>
  );
}
