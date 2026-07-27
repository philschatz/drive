/**
 * Developer: Open Link — paste a URL/hash to navigate to it.
 * Extracted 1:1 from the old single-page Settings.
 */
import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { navigateToUrlOrHash } from '../../shared/navigate-url';
import { useSectionAlerts } from '../SettingsSubScreen';

export function DeveloperSettings() {
  const { alerts, setError } = useSectionAlerts();
  const [linkUrl, setLinkUrl] = useState('');

  const handleNavigateUrl = () => {
    const err = navigateToUrlOrHash(linkUrl);
    if (err) setError(`Invalid URL — ${err.toLowerCase()}`);
  };

  return (
    <>
      {alerts}
      <section className="mb-6">
        <p className="text-xs text-muted-foreground mb-2">
          Paste a link to navigate to it (e.g. document or add-friend links).
        </p>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 text-sm p-2 rounded border border-border font-mono"
            value={linkUrl}
            onInput={(e: any) => setLinkUrl(e.currentTarget.value)}
            placeholder="Paste URL here..."
          />
          <Button size="sm" onClick={handleNavigateUrl} disabled={!linkUrl.trim()}>
            Go
          </Button>
        </div>
      </section>
    </>
  );
}
