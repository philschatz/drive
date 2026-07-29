/**
 * Profile — your display name plus the identity ids (user group, device, the
 * shared-settings doc).
 *
 * The name is edited through a RenameSheet rather than a live field, which is
 * what makes `handleSaveName` safe: saving calls `ensureUserGroup({ create: true })`,
 * so the old always-live input could mint a user group from nothing but an
 * accidental focus-and-blur. A transactional sheet has no blur path at all — the
 * only way to commit is Save. (The unchanged-value guard stays anyway; it is free,
 * and Save can still be tapped on an untouched draft.)
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { showToast, showError } from '@/components/ui/toast';
import { getIdentity, ensureUserGroup, type IdentityInfo } from '../../common/keyhive-api';
import { RenameSheet } from '../../common/RenameSheet';
import { idbGet, KEYS } from '../../../shared/idb-storage';
import { getFriendName, setFriendName } from '../../friend-names';
import { sourceUrl } from '../../common/doc-urls';
import { AddFriendSheet } from '../AddFriendSheet';
import { SettingsGroup, SettingsProse } from '../SettingsGroup';
import { CopyRow } from '../CopyRow';

export function ProfileSettings() {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  // The last persisted name, to skip no-op saves.
  const [savedName, setSavedName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [loading, setLoading] = useState(true);
  // A load failure stays inline: a toast would auto-dismiss and leave a blank page.
  const [loadError, setLoadError] = useState('');
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
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
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Save your name as a User Group contact, creating the user group if it doesn't
  // exist yet (so the name has a stable, share-able identity to attach to).
  const handleSaveName = async (next: string) => {
    if (next === savedName) return;
    setSavingName(true);
    try {
      const { userGroupId } = await ensureUserGroup({ create: true });
      if (!userGroupId) throw new Error('Could not create your user group.');
      await setFriendName(userGroupId, next);
      showToast('Name saved.');
      await refresh();
    } catch (err: any) {
      showError('Failed to save name: ' + err.message);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <>
      {loadError && <p className="md-body-medium text-destructive px-4 pt-2">{loadError}</p>}

      <SettingsGroup label="Your name">
        <md-list-item type="button" data-testid="profile-name" onClick={() => setRenameOpen(true)}>
          <md-icon slot="start">badge</md-icon>
          <div slot="headline">Your name</div>
          <div slot="supporting-text" className={displayName ? undefined : 'opacity-60'}>
            {savingName ? 'Saving…' : displayName || 'Not set'}
          </div>
          <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
        </md-list-item>
      </SettingsGroup>

      <SettingsProse>
        Set the name friends see when you share with them. Saving creates your user group
        if you don't have one yet.
      </SettingsProse>

      <SettingsGroup>
        <md-list-item type="button" data-testid="profile-invite-friend" onClick={() => setAddFriendOpen(true)}>
          <md-icon slot="start">person_add</md-icon>
          <div slot="headline">Invite a friend</div>
          <div slot="supporting-text">Show them a QR code to start sharing</div>
          <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
        </md-list-item>
      </SettingsGroup>

      <SettingsGroup label="Identity">
        {loading ? (
          <md-list-item type="text" data-testid="profile-identity-loading">
            <div slot="headline" className="opacity-60">Loading…</div>
          </md-list-item>
        ) : identity ? (
          <>
            <CopyRow
              icon="group"
              label="User group ID"
              value={identity.userGroupId}
              empty="Not created yet — invite a friend or add a device"
              data-testid="profile-user-group"
            />
            <CopyRow icon="smartphone" label="Device ID" value={identity.deviceId} data-testid="profile-device-id" />
            {settingsDocId && (
              <md-list-item
                type="link"
                href={sourceUrl(settingsDocId)}
                data-testid="profile-shared-settings"
                title="View / edit your shared settings (friends, device names, seen state)"
              >
                <md-icon slot="start">sync</md-icon>
                <div slot="headline">Shared settings</div>
                <div slot="supporting-text">Friends, device names, seen state</div>
                <md-icon slot="end" aria-hidden="true">open_in_new</md-icon>
              </md-list-item>
            )}
          </>
        ) : (
          <md-list-item type="text" data-testid="profile-identity-missing">
            <div slot="headline" className="opacity-60">Keyhive not available.</div>
          </md-list-item>
        )}
      </SettingsGroup>

      {/* allowEmpty: setFriendName('') *removes* the name, so blank is how you
          unset your display name — not an invalid draft. */}
      <RenameSheet
        open={renameOpen}
        title="Your name"
        label="Name"
        value={displayName}
        allowEmpty
        onRename={handleSaveName}
        onClose={() => setRenameOpen(false)}
        data-testid="profile-name-sheet"
      />
      <AddFriendSheet open={addFriendOpen} onOpenChange={setAddFriendOpen} />
    </>
  );
}
