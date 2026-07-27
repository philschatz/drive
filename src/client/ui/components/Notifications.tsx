import { useEffect } from 'preact/hooks';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { onWorkerError } from '@/worker-api';
import { settingSet, settingSetSync } from '@client/idb-storage';
import { watchTabLeadership } from '@/multi-tab';
import { useVersionCheck } from '@/shared/useVersionCheck';
import { upsertToast } from './ui/toast';

dayjs.extend(relativeTime);

/**
 * Drives the app's persistent, actionable notices as Radix toasts (see ui/toast.tsx):
 *   - worker crash / fatal init failure — destructive, "Reload app"
 *   - multiple tabs open — warning; auto-clears when this tab becomes the leader
 *   - new version available — click "Reload"
 * Renders nothing itself; each notice is upserted by a stable key so re-renders
 * don't stack duplicates and clearing the condition removes the toast.
 */

/** Reload to Home, clearing the remembered doc so startup doesn't bounce back into it. */
async function reloadAtHome() {
  settingSetSync('last-opened-doc', null);
  await settingSet('last-opened-doc', null).catch(() => {});
  window.location.hash = '#/';
  window.location.reload();
}

export function Notifications() {
  // Worker errors — uncaught exceptions, unhandled rejections, fatal init failures.
  useEffect(() =>
    onWorkerError((message) => {
      upsertToast('worker-error', {
        message,
        tone: 'destructive',
        icon: 'error',
        durationMs: null,
        action: { label: 'Reload app', onClick: reloadAtHome },
      });
    }), []);

  // Multi-tab: remote sync only works in one tab per device (keyhive limitation).
  // Warn on the secondary tab(s); clear when this tab becomes the sole/leader tab.
  useEffect(() =>
    watchTabLeadership((secondary) => {
      upsertToast('multi-tab', secondary ? {
        message:
          "Remote real-time syncing with multiple tabs is not supported yet (keyhive limitation). " +
          "This tab won't sync — use a single tab, or close the others to sync here.",
        tone: 'warning',
        icon: 'warning',
        durationMs: null,
        testId: 'multi-tab-banner',
      } : null);
    }), []);

  // New deployed version available.
  const { updateAvailable, buildTime, reload, dismiss, dismissed } = useVersionCheck();
  useEffect(() => {
    upsertToast('update', (updateAvailable && !dismissed) ? {
      message: `New version available${buildTime ? ` (deployed ${dayjs(buildTime).fromNow()})` : ''}`,
      icon: 'update',
      durationMs: null,
      action: { label: 'Reload', onClick: reload },
      onDismiss: dismiss, // so it stays dismissed instead of the effect re-adding it
    } : null);
  }, [updateAvailable, buildTime, dismissed, reload, dismiss]);

  return null;
}
