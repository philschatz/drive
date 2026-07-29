/**
 * Dark mode — the single place it is detected.
 *
 * The app follows the OS and nothing else: there is no toggle and no stored
 * preference. `startThemeSync()` mirrors `prefers-color-scheme` onto a `.dark`
 * class on <html>, which is all the CSS needs — globals.css defines every
 * `--md-sys-color-*` role twice (`:root` light, `.dark` dark) and Tailwind's
 * `dark:` variant is bound to a `.dark` ancestor. Custom properties inherit
 * through shadow boundaries, so the md-* web components re-theme too, live,
 * with no markup changes anywhere.
 *
 * `isDark()` / `onThemeChange()` exist for the one consumer that can't read our
 * tokens: schedule-x, which ships its own `.is-dark` stylesheet and has to be
 * told via `calendar.setTheme()`.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<(dark: boolean) => void>();
let dark = false;

/** Whether the OS is currently asking for a dark UI. */
export function isDark(): boolean {
  return dark;
}

function apply(next: boolean) {
  dark = next;
  document.documentElement.classList.toggle('dark', next);
  for (const cb of listeners) cb(next);
}

/**
 * Begin mirroring the OS color scheme onto <html>. Called once from main.tsx
 * before the first render, so nothing ever paints in the wrong theme.
 *
 * No-ops when `matchMedia` is missing — jsdom does not implement it, and this
 * module must stay safe to import from any component under test.
 */
export function startThemeSync(): void {
  if (typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia(DARK_QUERY);
  apply(mq.matches);
  mq.addEventListener('change', e => apply(e.matches));
}

/** Subscribe to theme flips. Returns an unsubscribe. */
export function onThemeChange(cb: (dark: boolean) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
