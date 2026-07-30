/**
 * Router component for `#/settings/:section` — renders the matching settings
 * sub-screen inside the shared SettingsSubScreen layout (back → #/settings).
 */
import type { ComponentType } from 'preact';
import { SettingsSubScreen } from './SettingsSubScreen';
import { SettingsProse } from './SettingsGroup';
import { ProfileSettings } from './sections/ProfileSettings';
import { DevicesSettings } from './sections/DevicesSettings';
import { StorageSettings } from './sections/StorageSettings';
import { BackupSettings } from './sections/BackupSettings';
import { DebuggingSettings } from './sections/DebuggingSettings';
import { DangerZone } from './sections/DangerZone';

export const SETTINGS_SECTIONS: Record<string, { title: string; icon: string; Component: ComponentType }> = {
  profile: { title: 'Profile', icon: 'person', Component: ProfileSettings },
  devices: { title: 'Devices', icon: 'devices', Component: DevicesSettings },
  storage: { title: 'Settings Storage', icon: 'sync', Component: StorageSettings },
  backup: { title: 'Data Backup', icon: 'save', Component: BackupSettings },
  // 'developer' (Open Link) folded into Debugging — a developer utility didn't
  // warrant a top-level row. `#/settings/developer` falls to the unknown-section
  // fallback below, matching the app's no-legacy-redirects convention.
  debugging: { title: 'Debugging', icon: 'bug_report', Component: DebuggingSettings },
  danger: { title: 'Danger Zone', icon: 'warning', Component: DangerZone },
};

export function SettingsSection({ section }: { section?: string; path?: string }) {
  const entry = section ? SETTINGS_SECTIONS[section] : undefined;
  if (!entry) {
    return (
      <SettingsSubScreen title="Settings">
        <SettingsProse>Unknown settings section.</SettingsProse>
      </SettingsSubScreen>
    );
  }
  const { title, Component } = entry;
  return (
    <SettingsSubScreen title={title}>
      <Component />
    </SettingsSubScreen>
  );
}
