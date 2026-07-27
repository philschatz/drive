/**
 * Danger Zone — full local-data erase. Extracted 1:1 from the old Settings.
 */
import { Button } from '@/components/ui/button';
import { deleteAllData } from '../../worker-api';
import { useSectionAlerts } from '../SettingsSubScreen';

export function DangerZone() {
  const { alerts, setError } = useSectionAlerts();

  const handleDeleteAllData = async () => {
    if (!confirm('Permanently erase ALL local data — every document, your identity/keys, friends, and settings? Documents not shared with another device are lost forever. This cannot be undone.')) return;
    try {
      await deleteAllData(); // terminates the worker, deletes all IndexedDB + localStorage, reloads
    } catch (err: any) {
      setError('Failed to delete data: ' + err.message);
    }
  };

  return (
    <>
      {alerts}
      <section className="mb-6">
        <p className="text-xs text-muted-foreground mb-2">
          Permanently erase all local data — every document, your identity/keys, contacts, and
          settings — then reload as a fresh install. Documents not shared with another device are
          lost forever. Use this to recover from a corrupted local state.
        </p>
        <Button size="sm" variant="destructive" onClick={handleDeleteAllData}>
          Delete All Data
        </Button>
      </section>
    </>
  );
}
