import { useEffect } from 'preact/hooks';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { onWorkerError } from '@/worker-api';
import { settingSet, settingSetSync } from '@client/shared/idb-storage';
import { useVersionCheck } from '@/common/useVersionCheck';
import { upsertToast } from './ui/toast';

dayjs.extend(relativeTime);

/**
 * Drives the app's persistent, actionable notices as Radix toasts (see ui/toast.tsx):
 *   - worker crash / fatal init failure — destructive, "Reload app"
 *   - new version available — click "Reload"
 * Renders nothing itself; each notice is upserted by a stable key so re-renders
 * don't stack duplicates and clearing the condition removes the toast.
 *
 * There is no longer a multi-tab warning: every tab shares the one engine owned by
 * the leadership-lock holder (ui/tab-transport.ts), so extra tabs edit and sync
 * normally. Which role a tab has is shown in Settings → Debugging.
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
