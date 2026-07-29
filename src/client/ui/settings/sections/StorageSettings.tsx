/**
 * Settings Storage — Local (default) vs Shared (one-way opt-in) settings sync.
 */
import { useState, useEffect } from 'preact/hooks';
import { showError } from '@/components/ui/toast';
import { useConfirm } from '../../common/ConfirmSheet';
import { getIdentity, type IdentityInfo } from '../../common/keyhive-api';
import { enableSettingsSync, getReachableSettingsDoc } from '../../worker-api';
import { idbGet, KEYS } from '../../../shared/idb-storage';
import { sourceUrl } from '../../common/doc-urls';
import { SettingsGroup, SettingsProse } from '../SettingsGroup';

export function StorageSettings() {
  const { confirm, confirmSheet } = useConfirm();
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Inline, not a toast: a load failure means the branch below can't be trusted.
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setIdentity(await getIdentity());
        // KEYS.driveSettings holds a docId string (SHARED) or a blob object (LOCAL).
        const settingsVal = await idbGet<unknown>(KEYS.driveSettings);
        setSettingsDocId(typeof settingsVal === 'string' ? settingsVal : null);
      } catch (err: any) {
        setLoadError(err.message);
      }
    })();
  }, []);

  const handleEnableSync = async () => {
    // Probe FIRST (before any prompt): if a synced settings doc already exists and
    // is reachable, just adopt it — no scary "this is permanent" confirmation. Only
    // CREATING a brand-new synced doc is the irreversible step worth confirming.
    let existing: string | null = null;
    try {
      existing = await getReachableSettingsDoc();
    } catch { /* fall through to the confirm+create path */ }
    if (!existing && !await confirm({
      title: 'Sync settings across your devices?',
      body: (
        <>
          Friends, device names and seen state will sync between your devices.{' '}
          <strong>This is permanent</strong> — synced settings can’t be made device-only again.
        </>
      ),
      confirmLabel: 'Sync settings',
      confirmIcon: 'sync',
      // Not `destructive`: irreversible is not destructive, and an error-toned
      // "yes, sync my settings" would read as "this will break something".
      'data-testid': 'confirm-enable-sync',
    })) return;
    setSyncing(true);
    try {
      await enableSettingsSync(); // adopts the existing reachable doc, else creates + migrates
      window.location.reload();
    } catch (err: any) {
      showError('Could not enable settings sync: ' + (err.message ?? err));
      setSyncing(false);
    }
  };

  return (
    <>
      {loadError && <p className="md-body-medium text-destructive px-4 pt-2">{loadError}</p>}

      {settingsDocId ? (
        <>
          <SettingsProse>
            Your settings (friends, device names, seen state) are{' '}
            <strong>synced across your devices</strong>.
          </SettingsProse>
          <SettingsGroup>
            <md-list-item type="link" href={sourceUrl(settingsDocId)} data-testid="storage-inspect">
              <md-icon slot="start">sync</md-icon>
              <div slot="headline">Inspect synced settings</div>
              <div slot="supporting-text">Friends, device names, seen state</div>
              <md-icon slot="end" aria-hidden="true">open_in_new</md-icon>
            </md-list-item>
          </SettingsGroup>
        </>
      ) : (
        <>
          <SettingsProse>
            Your settings are stored <strong>only on this device</strong>. You can sync them across
            your devices — this is <strong>permanent</strong> and can’t be undone.
          </SettingsProse>
          <SettingsGroup>
            <md-list-item
              type="button"
              data-testid="storage-enable-sync"
              disabled={syncing || !identity?.userGroupId || undefined}
              onClick={handleEnableSync}
            >
              <md-icon slot="start">sync</md-icon>
              <div slot="headline">Sync settings across devices</div>
              {/* One statement of the reason, visible on touch — the old page had it
                  twice, once in a `title` tooltip a phone never shows. */}
              <div slot="supporting-text">
                {syncing
                  ? 'Enabling…'
                  : identity?.userGroupId
                    ? 'Permanent — this can’t be undone'
                    : 'Add a friend or link a device first'}
              </div>
            </md-list-item>
          </SettingsGroup>
        </>
      )}

      {confirmSheet}
    </>
  );
}
