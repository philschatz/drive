import { useState, useEffect } from 'react';
import { onWorkerError } from '@/worker-api';

/**
 * Surfaces worker errors — uncaught exceptions, unhandled rejections, and fatal init
 * failures (e.g. a dangling user-group) — as a persistent top banner, so problems are
 * visible instead of leaving the app on silent loading spinners. Offers Settings (for
 * recovery via Delete All Data) and a dismiss.
 */
export function WorkerErrorBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => onWorkerError(setMessage), []);

  if (!message) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-3 bg-destructive px-4 py-2 text-destructive-foreground shadow-md">
      <span className="material-symbols-outlined text-base">error</span>
      <span className="text-sm">{message}</span>
      <a
        href="#/settings"
        className="ml-2 shrink-0 rounded border border-current px-2 py-0.5 text-sm font-medium hover:bg-destructive-foreground/10"
      >
        Open Settings
      </a>
      <button
        className="ml-1 shrink-0 opacity-80 hover:opacity-100"
        onClick={() => setMessage(null)}
        aria-label="Dismiss"
      >
        <span className="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  );
}
