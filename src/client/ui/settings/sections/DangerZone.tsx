/**
 * Danger Zone — full local-data erase.
 */
import { showError } from '@/components/ui/toast';
import { useConfirm } from '../../common/ConfirmSheet';
import { deleteAllData } from '../../worker-api';
import { SettingsGroup, SettingsProse } from '../SettingsGroup';

export function DangerZone() {
  const { confirm, confirmSheet } = useConfirm();

  const handleDeleteAllData = async () => {
    if (!await confirm({
      title: 'Erase all local data?',
      body: (
        <>
          Every document, your identity and keys, friends and settings will be deleted, and the app
          reloads as a fresh install. <strong>Documents not shared with another device are lost
          forever.</strong>
        </>
      ),
      confirmLabel: 'Erase everything',
      confirmIcon: 'delete_forever',
      destructive: true,
      'data-testid': 'confirm-delete-all',
    })) return;
    try {
      await deleteAllData(); // terminates the worker, deletes all IndexedDB + localStorage, reloads
    } catch (err: any) {
      showError('Failed to delete data: ' + err.message);
    }
  };

  return (
    <>
      <SettingsProse>
        Permanently erase all local data — every document, your identity/keys, friends, and
        settings — then reload as a fresh install. Documents not shared with another device are
        lost forever. Use this to recover from a corrupted local state.
      </SettingsProse>

      <SettingsGroup>
        <md-list-item type="button" data-testid="danger-delete-all" onClick={handleDeleteAllData}>
          <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>delete_forever</md-icon>
          <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Delete all data</div>
          <div slot="supporting-text">Every document, your keys, friends and settings</div>
        </md-list-item>
      </SettingsGroup>

      {confirmSheet}
    </>
  );
}
