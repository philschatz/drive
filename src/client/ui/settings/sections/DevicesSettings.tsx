/**
 * Devices — the linked-device list (rename/remove/role) and the Link Device
 * flow. Extracted 1:1 from the old single-page Settings.
 */
import { useState } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { DeviceList } from '@/components/DeviceList';
import { useDevices, useDeviceStatuses } from '../../shared/use-devices';
import { AddDeviceSheet } from '../AddDeviceSheet';
import { useSectionAlerts } from '../SettingsSubScreen';

export function DevicesSettings() {
  const { alerts, setMessage, setError } = useSectionAlerts();
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);

  // The device list, its live refresh, and removal are owned by the shared hook.
  const { devices, removeDevice, changeDeviceRole } = useDevices({ onError: setError, onMessage: setMessage });
  const deviceStatuses = useDeviceStatuses();

  return (
    <>
      {alerts}
      <section className="mb-6">
        <DeviceList devices={devices} onRemove={removeDevice} onChangeRole={changeDeviceRole} statuses={deviceStatuses} />

        {/* Link another device — opens the linking sheet */}
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={() => setAddDeviceOpen(true)}>
            <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>devices</span>
            Link Device
          </Button>
        </div>
      </section>

      <AddDeviceSheet open={addDeviceOpen} onOpenChange={setAddDeviceOpen} />
    </>
  );
}
