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
import { getContactName, setContactName } from '../contact-names';
import { keyhiveReady, useWsStatus } from '../shared/automerge';
import { RendezvousShare } from './RendezvousShare';
import { buildAddFriendRendezvousUrl } from './AddFriendPage';

export function ShareWithFriendPage({ path }: { path?: string }) {
  const [savedName, setSavedName] = useState('');
  const [error, setError] = useState('');
  // Bump to (re)mount RendezvousShare; >0 means the share has been started.
  const [started, setStarted] = useState(0);
  const connected = useWsStatus();
  // The friend we added back once the exchange completes; when they sent no name
  // we prompt for one here (the sharer has no other chance to label them).
  const [contact, setContact] = useState<{ groupId: string; hasName: boolean } | null>(null);
  const [contactName, setContactNameInput] = useState('');
  const [contactSaved, setContactSaved] = useState(false);

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
      setContact(null);
      setContactNameInput('');
      setContactSaved(false);
      setStarted(n => n + 1);
    } catch (err: any) {
      setError('Could not prepare your share link: ' + err.message);
    }
  };

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
            onReceivedContact={setContact}
          />

          {contact && !contact.hasName && !contactSaved && (
            <div className="mt-4 max-w-sm">
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
      )}
    </div>
  );
}
