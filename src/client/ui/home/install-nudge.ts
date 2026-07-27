/**
 * PWA install nudge: a once-per-session toast shown when Home loads on a
 * mobile browser that isn't already running as an installed PWA.
 *
 * When Chromium's `beforeinstallprompt` is available the toast carries a real
 * "Install" action; otherwise the message gives browser-specific instructions
 * for the manual "Add to Home screen" flow (the menu item is named differently
 * in Safari, Firefox, Samsung Internet, …).
 */
import { useEffect, useState } from 'preact/hooks';
import { detectBrowserName, detectDeviceKind } from '@/lib/device-name';
import { upsertToast } from '@/components/ui/toast';

export type MobilePlatform = 'ios' | 'android';

const DISMISSED_KEY = 'install-nudge-dismissed';
const TOAST_KEY = 'install-nudge';

/** iOS vs Android, or null for anything else (desktop, unknown mobile OS). */
export function detectMobilePlatform(ua: string): MobilePlatform | null {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return null;
}

/**
 * Per-browser wording for the manual install flow. `browser` is the coarse
 * name from detectBrowserName() (which already distinguishes iOS pseudo-
 * browsers via their CriOS/FxiOS/EdgiOS tokens).
 */
export function installInstructions(browser: string, platform: MobilePlatform): string {
  const prefix = 'Install this app: ';
  if (platform === 'ios') {
    return prefix + (browser === 'Safari'
      ? 'tap the Share button, then "Add to Home Screen"'
      : 'tap the Share icon in the address bar, then "Add to Home Screen"');
  }
  switch (browser) {
    case 'Chrome': return prefix + 'tap the ⋮ menu, then "Add to Home screen" or "Install app"';
    case 'Firefox': return prefix + 'tap the ⋮ menu, then "Add app to Home screen"';
    case 'Samsung Internet': return prefix + 'tap the ≡ menu, then "Add page to" → "Home screen"';
    case 'Edge': return prefix + 'tap the ⋯ menu, then "Add to phone"';
    case 'Opera': return prefix + 'tap the ⋮ menu, then "Add to" → "Home screen"';
    default: return prefix + 'use your browser\'s "Add to Home screen" or "Install app" menu option';
  }
}

/**
 * Drive the install-nudge toast while the caller (Home) is mounted. The toast
 * is persistent on-screen but keyed, so it upgrades in place when the deferred
 * `beforeinstallprompt` event arrives and is cleared when Home unmounts.
 * Dismissing it sets a sessionStorage flag: one nudge per browser session.
 */
export function useInstallNudge() {
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [dismissed, setDismissed] = useState(() => !!sessionStorage.getItem(DISMISSED_KEY));

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as any).standalone === true;
    const platform = detectMobilePlatform(navigator.userAgent);

    const show = !isStandalone && !dismissed && platform !== null && detectDeviceKind() === 'phone';
    const onDismiss = () => {
      sessionStorage.setItem(DISMISSED_KEY, '1');
      setDismissed(true);
    };

    upsertToast(TOAST_KEY, show ? {
      icon: 'install_mobile',
      durationMs: null,
      testId: 'install-nudge',
      onDismiss,
      ...(installPrompt ? {
        message: 'Install this app for quicker access',
        action: {
          label: 'Install',
          onClick: async () => {
            installPrompt.prompt();
            const { outcome } = await installPrompt.userChoice;
            if (outcome === 'accepted') {
              setInstallPrompt(null);
              onDismiss();
            }
          },
        },
      } : {
        message: installInstructions(detectBrowserName(), platform!),
      }),
    } : null);

    // Home unmounted (user navigated into a doc) — don't linger over editors.
    return () => upsertToast(TOAST_KEY, null);
  }, [installPrompt, dismissed]);
}
