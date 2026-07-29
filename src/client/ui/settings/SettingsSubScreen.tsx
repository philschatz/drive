/**
 * Shared layout for Settings sub-screens: a Material top app bar with a back
 * button to the Settings index.
 *
 * It used to also own `useSectionAlerts`, an inline success/error `Alert` pair each
 * section rendered as its first child. Those are snackbars now (`showToast` /
 * `showError` from `components/ui/toast`) — a one-shot result doesn't need a
 * banner that shifts the page. Only *standing* conditions stay inline, in the
 * section that owns them: the relay-socket row and the worker-crash banner on the
 * Debugging page, and load failures that would otherwise leave a blank screen
 * behind a 6-second toast.
 */
import type { ComponentChildren } from 'preact';

export function SettingsSubScreen({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href="#/settings"
          aria-label="Back"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">{title}</h1>
      </div>
      {/* No horizontal padding of its own: with the shell's px-2 sm:px-4 plus
          md-item's internal 16px, rows would sit 24-32px in from the edge. MD3 list
          rows run close to full width; prose gets its indent from SettingsProse. */}
      {children}
    </div>
  );
}
