/**
 * Profile — identity info (User Group / Device IDs, shared-settings link) and
 * the user's display name. Extracted 1:1 from the old single-page Settings.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { getIdentity, ensureUserGroup, type IdentityInfo } from '../../common/keyhive-api';
import { idbGet, KEYS } from '../../../shared/idb-storage';
import { getFriendName, setFriendName } from '../../friend-names';
import { sourceUrl } from '../../common/doc-urls';
import { AddFriendSheet } from '../AddFriendSheet';
import { useSectionAlerts } from '../SettingsSubScreen';

export function ProfileSettings() {
  const { alerts, setMessage, setError } = useSectionAlerts();
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  // The last persisted name, to skip no-op saves (e.g. a blur with no change, which
  // would otherwise create a user group from an accidental focus).
  const [savedName, setSavedName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [loading, setLoading] = useState(true);
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [addFriendOpen, setAddFriendOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const id = await getIdentity();
      setIdentity(id);
      // Your name is stored as a User Group contact (keyed by user-group id), not by device.
      const name = (id.userGroupId && getFriendName(id.userGroupId)) || '';
      setDisplayName(name);
      setSavedName(name);
      // KEYS.driveSettings holds a docId string (SHARED) or a blob object (LOCAL);
      // only a string is a real settings-doc pointer.
      const settingsVal = await idbGet<unknown>(KEYS.driveSettings);
      setSettingsDocId(typeof settingsVal === 'string' ? settingsVal : null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { refresh(); }, [refresh]);

  // Save your name as a User Group contact, creating the user group if it doesn't
  // exist yet (so the name has a stable, share-able identity to attach to).
  const handleSaveName = async () => {
    // No-op if unchanged — avoids creating a user group from an accidental blur.
    if (displayName.trim() === savedName) return;
    setSavingName(true);
    try {
      const { userGroupId } = await ensureUserGroup({ create: true });
      if (!userGroupId) throw new Error('Could not create your user group.');
      await setFriendName(userGroupId, displayName.trim());
      setMessage('Name saved.');
      await refresh();
    } catch (err: any) {
      setError('Failed to save name: ' + err.message);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <>
      {alerts}

      {/* Your name */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Your Name</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Set the name friends see when you share with them. Saving creates your user group
          if you don't have one yet.
        </p>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-sm p-2 rounded border border-border"
            value={displayName}
            onInput={(e: any) => setDisplayName(e.currentTarget.value)}
            onBlur={handleSaveName}
            onKeyDown={(e: any) => { if (e.key === 'Enter') handleSaveName(); }}
            placeholder="Your name (optional)"
          />
          <Button size="sm" onClick={handleSaveName} disabled={savingName}>
            {savingName ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddFriendOpen(true)}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>person_add</span>
            Invite a friend
          </Button>
        </div>
      </section>

      {/* Identity */}
      <section className="mb-6">
        <h2 className="text-lg font-semibold mb-2">Identity</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : identity ? (
          <div className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">User Group ID:</span>
              {identity.userGroupId ? (
                <code
                  className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer"
                  title={`${identity.userGroupId} (click to copy)`}
                  onClick={() => navigator.clipboard.writeText(identity.userGroupId!)}
                >
                  {identity.userGroupId.slice(0, 16)}...
                </code>
              ) : (
                <span className="text-xs text-muted-foreground italic">
                  Not created yet — invite a friend or add a device
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Device ID:</span>
              <code
                className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer"
                title={`${identity.deviceId} (click to copy)`}
                onClick={() => navigator.clipboard.writeText(identity.deviceId)}
              >
                {identity.deviceId.slice(0, 16)}...
              </code>
            </div>
            {settingsDocId && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Shared Settings:</span>
                <a
                  href={sourceUrl(settingsDocId)}
                  className="text-xs font-mono text-primary underline underline-offset-2"
                  title="View / edit your shared settings (friends, device names, seen state)"
                >
                  {settingsDocId.slice(0, 16)}…
                </a>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Keyhive not available.</p>
        )}
      </section>

      <AddFriendSheet open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </>
  );
}
