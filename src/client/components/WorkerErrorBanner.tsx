import { useState, useEffect } from 'preact/hooks';
import { onWorkerError } from '@/worker-api';
import { settingSet, settingSetSync } from '@/idb-storage';

/**
 * Surfaces worker errors — uncaught exceptions, unhandled rejections, and fatal init
 * failures (e.g. a dangling user-group) — as a persistent top banner, so problems are
 * visible instead of leaving the app on silent loading spinners. Offers a reload to
 * the homepage (clearing the remembered last-opened doc) and a dismiss.
 */
export function WorkerErrorBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => onWorkerError(setMessage), []);

  if (!message) return null;

  return (
    <div class="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-3 bg-destructive px-4 py-2 text-destructive-foreground shadow-md">
      <span class="material-symbols-outlined text-base">error</span>
      <span class="text-sm">{message}</span>
      <button
        class="ml-2 shrink-0 rounded border border-current px-2 py-0.5 text-sm font-medium hover:bg-destructive-foreground/10"
        onClick={async () => {
          // Clear the remembered doc so the startup redirect doesn't bounce
          // right back into the (possibly broken) doc, then reload at Home.
          settingSetSync('last-opened-doc', null);
          await settingSet('last-opened-doc', null).catch(() => {});
          window.location.hash = '#/';
          window.location.reload();
        }}
      >
        Reload app
      </button>
      <button
        class="ml-1 shrink-0 opacity-80 hover:opacity-100"
        onClick={() => setMessage(null)}
        aria-label="Dismiss"
      >
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  );
}
