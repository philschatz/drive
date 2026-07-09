import { useVersionCheck } from '@/shared/useVersionCheck';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export function UpdateBanner() {
  const { updateAvailable, buildTime, reload, dismiss, dismissed } = useVersionCheck();

  if (!updateAvailable || dismissed) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg cursor-pointer hover:bg-accent transition-colors"
      onClick={reload}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') reload(); }}
    >
      <span className="material-symbols-outlined text-primary">update</span>
      <span className="text-sm text-foreground">
        New version available{buildTime ? ` (deployed ${dayjs(buildTime).fromNow()})` : ''}
      </span>
      <button
        className="ml-2 text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        aria-label="Dismiss"
      >
        <span className="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  );
}
