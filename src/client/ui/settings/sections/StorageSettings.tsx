/**
 * Settings Storage — Local (default) vs Shared (one-way opt-in) settings sync.
 * Extracted 1:1 from the old single-page Settings.
 */
import { useState, useEffect } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { getIdentity, type IdentityInfo } from '../../common/keyhive-api';
import { enableSettingsSync, getReachableSettingsDoc } from '../../worker-api';
import { idbGet, KEYS } from '../../../shared/idb-storage';
import { sourceUrl } from '../../common/doc-urls';
import { useSectionAlerts } from '../SettingsSubScreen';

export function StorageSettings() {
  const { alerts, setError } = useSectionAlerts();
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [settingsDocId, setSettingsDocId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setIdentity(await getIdentity());
        // KEYS.driveSettings holds a docId string (SHARED) or a blob object (LOCAL).
        const settingsVal = await idbGet<unknown>(KEYS.driveSettings);
        setSettingsDocId(typeof settingsVal === 'string' ? settingsVal : null);
      } catch (err: any) {
        setError(err.message);
      }
    })();
  }, [setError]);

  const handleEnableSync = async () => {
    setError('');
    // Probe FIRST (before any prompt): if a synced settings doc already exists and
    // is reachable, just adopt it — no scary "this is permanent" confirmation. Only
    // CREATING a brand-new synced doc is the irreversible step worth confirming.
    let existing: string | null = null;
    try {
      existing = await getReachableSettingsDoc();
    } catch { /* fall through to the confirm+create path */ }
    if (!existing && !window.confirm(
      'Sync your settings (friends, device names, seen state) across your devices?\n\n' +
      "This is permanent — synced settings can't be made device-only again.",
    )) return;
    setSyncing(true);
    try {
      await enableSettingsSync(); // adopts the existing reachable doc, else creates + migrates
      window.location.reload();
    } catch (err: any) {
      setError('Could not enable settings sync: ' + (err.message ?? err));
      setSyncing(false);
    }
  };

  return (
    <>
      {alerts}
      <section className="mb-6">
        {settingsDocId ? (
          <p className="text-xs text-muted-foreground">
            Your settings (friends, device names, seen state) are{' '}
            <strong>synced across your devices</strong> —{' '}
            <a href={sourceUrl(settingsDocId)} className="text-primary underline underline-offset-2">
              inspect them
            </a>.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              Your settings are stored <strong>only on this device</strong>. You can sync them across
              your devices — this is <strong>permanent</strong> and can’t be undone.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={handleEnableSync}
              disabled={syncing || !identity?.userGroupId}
              title={identity?.userGroupId ? undefined : 'Add a friend or link a device first to enable synced settings'}
            >
              {syncing ? 'Enabling…' : 'Sync settings across devices'}
            </Button>
            {!identity?.userGroupId && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Add a friend or link a device first to enable synced settings.
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
