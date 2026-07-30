/**
 * Settings index — a Material list navigating to sub-screens (profile, devices,
 * storage, backup, debugging, danger zone) plus Friends.
 * The sections themselves live under ./sections/ and render at
 * `#/settings/:section` via SettingsSection.
 */
import { Fragment } from 'preact';
import { showError } from '@/components/ui/toast';
import { ScanQrButton } from '@/components/ScanQrButton';

const GROUPS: Array<Array<{ icon: string; label: string; href: string }>> = [
  [
    { icon: 'person', label: 'Profile', href: '#/settings/profile' },
    { icon: 'devices', label: 'Devices', href: '#/settings/devices' },
    { icon: 'group', label: 'Friends', href: '#/friends' },
  ],
  [
    { icon: 'sync', label: 'Settings Storage', href: '#/settings/storage' },
    { icon: 'save', label: 'Data Backup', href: '#/settings/backup' },
  ],
  [
    { icon: 'bug_report', label: 'Debugging', href: '#/settings/debugging' },
    { icon: 'warning', label: 'Danger Zone', href: '#/settings/danger' },
  ],
];

export function Settings({ path }: { path?: string }) {
  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      {/* Top app bar */}
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href="#/"
          aria-label="Back"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Settings</h1>
        {/* The app's single QR entry point — friend invites, device links and
            document URLs all scan from here. */}
        <ScanQrButton onError={showError} />
      </div>

      {GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <md-divider role="separator" className="my-1" />}
          <md-list style={{ background: 'transparent' }}>
            {group.map(item => (
              <md-list-item key={item.href} type="link" href={item.href}>
                <md-icon slot="start">{item.icon}</md-icon>
                <div slot="headline">{item.label}</div>
                <md-icon slot="end">chevron_right</md-icon>
              </md-list-item>
            ))}
          </md-list>
        </Fragment>
      ))}
    </div>
  );
}
