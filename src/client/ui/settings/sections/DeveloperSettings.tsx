/**
 * Developer: Open Link — paste a URL/hash to navigate to it.
 *
 * The one Settings screen that is a form rather than a list, so it keeps a real
 * field and a submit button (the same shape `FieldEditor` uses for Cancel/Save) —
 * a "Go" row in a list has nothing to submit.
 */
import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { MdTextField } from '@/components/ui/md-text-field';
import { showError } from '@/components/ui/toast';
import { navigateToUrlOrHash } from '../../common/navigate-url';
import { SettingsProse } from '../SettingsGroup';

export function DeveloperSettings() {
  const [linkUrl, setLinkUrl] = useState('');

  const handleNavigateUrl = () => {
    if (!linkUrl.trim()) return;
    const err = navigateToUrlOrHash(linkUrl);
    if (err) showError(`Invalid URL — ${err.toLowerCase()}`);
  };

  return (
    <>
      <SettingsProse>
        Paste a link to navigate to it (e.g. document or add-friend links).
      </SettingsProse>

      <div className="px-4 pt-2">
        <MdTextField
          label="Link"
          type="url"
          value={linkUrl}
          placeholder="https://… or #/…"
          data-testid="developer-url"
          onInput={setLinkUrl}
          onEnter={handleNavigateUrl}
        />
        <div className="flex items-center justify-end gap-2 mt-4">
          <Button data-testid="developer-go" disabled={!linkUrl.trim()} onClick={handleNavigateUrl}>
            Open
          </Button>
        </div>
      </div>
    </>
  );
}
