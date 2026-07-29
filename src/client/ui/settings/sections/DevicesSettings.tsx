/**
 * Devices — the linked-device list (rename/remove/role) and the Link Device flow.
 *
 * The rows and their options sheet live in `components/DeviceList`; this file is
 * just the page's shell. `useDevices`'s success/failure callbacks go straight to
 * the snackbar functions, which is why "Device removed." and "Device access
 * updated." need no wiring here.
 */
import { useState } from 'preact/hooks';
import { showToast, showError } from '@/components/ui/toast';
import { DeviceList } from '@/components/DeviceList';
import { useDevices, useDeviceStatuses } from '../../common/use-devices';
import { AddDeviceSheet } from '../AddDeviceSheet';
import { SettingsGroup } from '../SettingsGroup';

export function DevicesSettings() {
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);

  // The device list, its live refresh, and removal are owned by the shared hook.
  const { devices, removeDevice, changeDeviceRole } = useDevices({ onError: showError, onMessage: showToast });
  const deviceStatuses = useDeviceStatuses();

  return (
    <>
      <DeviceList devices={devices} onRemove={removeDevice} onChangeRole={changeDeviceRole} statuses={deviceStatuses} />

      <SettingsGroup>
        <md-list-item type="button" data-testid="devices-link" onClick={() => setAddDeviceOpen(true)}>
          <md-icon slot="start">add_link</md-icon>
          <div slot="headline">Link a device</div>
          <div slot="supporting-text">Open a link on your other device to connect it</div>
          <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
        </md-list-item>
      </SettingsGroup>

      <AddDeviceSheet open={addDeviceOpen} onOpenChange={setAddDeviceOpen} />
    </>
  );
}
