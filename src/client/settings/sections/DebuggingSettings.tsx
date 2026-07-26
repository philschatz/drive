/**
 * Debugging — debug-mode switch, cache clearing, and the connection-debug page.
 * Extracted 1:1 from the old single-page Settings.
 */
import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { setDebugEnabled, clearAllCaches } from '../../worker-api';
import { isDebugEnabled } from '../../idb-storage';
import { useSectionAlerts } from '../SettingsSubScreen';

export function DebuggingSettings() {
  const { alerts, setError } = useSectionAlerts();
  const [debugEnabled] = useState(isDebugEnabled());

  const handleToggleDebug = async (v: boolean) => {
    try {
      await setDebugEnabled(v); // persists, tells worker, then reloads the page
    } catch (err: any) {
      setError('Failed to update debug setting: ' + err.message);
    }
  };

  const handleClearCaches = async () => {
    try {
      await clearAllCaches(); // clears caches, then reloads the page
    } catch (err: any) {
      setError('Failed to clear caches: ' + err.message);
    }
  };

  return (
    <>
      {alerts}
      <section className="mb-6">
        <p className="text-xs text-muted-foreground mb-2">
          Enabling debug mode bypasses all caches (always reading live data) and logs every
          keyhive/WASM call to the console — and names the last calls on the crash banner if the
          document engine traps. The page reloads when you change this.
        </p>
        <div className="flex items-center gap-2 mb-3">
          <Switch
            id="debug-mode"
            checked={debugEnabled}
            onCheckedChange={handleToggleDebug}
          />
          <Label htmlFor="debug-mode" className="cursor-pointer">Enable debugging (and disable cache)</Label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="destructive" onClick={handleClearCaches}>Clear Caches</Button>
          {/* The status chip in the app bars opens a peers sheet; the full
              connection-debug page lives here. */}
          <a href="#/connection">
            <Button size="sm" variant="outline">
              <span className="material-symbols-outlined">network_check</span> Connection details
            </Button>
          </a>
        </div>
      </section>
    </>
  );
}
