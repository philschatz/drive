/**
 * theme.ts — the OS dark-mode detector.
 *
 * What's worth pinning here is the wiring, not the palette (jsdom evaluates
 * neither Tailwind's `@custom-variant` nor custom properties — that's the job of
 * tests-pw/ui/dark-mode.spec.ts). So: the class lands on <html> for a dark OS,
 * later flips reach the non-CSS subscribers, unsubscribing actually detaches,
 * and a missing `matchMedia` is survivable — jsdom has none, so any component
 * test that transitively imports this module depends on that last one.
 *
 * Named .test.tsx despite having no JSX: jest's jsdom `ui` project matches only
 * *.test.tsx (plus one hand-listed .ts exception), and this needs a document.
 */

type Handler = (e: { matches: boolean }) => void;

/** Minimal MediaQueryList stand-in with a `flip()` to fire a `change`. */
function stubMatchMedia(initial: boolean) {
  const handlers = new Set<Handler>();
  let matches = initial;
  const mq = {
    get matches() { return matches; },
    addEventListener: (_type: string, cb: Handler) => { handlers.add(cb); },
    removeEventListener: (_type: string, cb: Handler) => { handlers.delete(cb); },
  };
  (window as any).matchMedia = jest.fn(() => mq);
  return {
    flip(next: boolean) {
      matches = next;
      for (const cb of handlers) cb({ matches: next });
    },
    get listenerCount() { return handlers.size; },
  };
}

/**
 * Fresh copy of the module per test — it keeps the current theme and the
 * subscriber set in module scope, so state must not leak between cases.
 */
function loadTheme() {
  let mod!: typeof import('./theme');
  jest.isolateModules(() => { mod = require('./theme'); });
  return mod;
}

afterEach(() => {
  delete (window as any).matchMedia;
  document.documentElement.classList.remove('dark');
});

it('applies .dark to <html> when the OS asks for dark', () => {
  stubMatchMedia(true);
  const { startThemeSync, isDark } = loadTheme();

  startThemeSync();

  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(isDark()).toBe(true);
});

it('leaves <html> unclassed for a light OS', () => {
  stubMatchMedia(false);
  const { startThemeSync, isDark } = loadTheme();

  startThemeSync();

  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(isDark()).toBe(false);
});

it('follows a later OS flip in both directions', () => {
  const mq = stubMatchMedia(false);
  const { startThemeSync, isDark } = loadTheme();
  startThemeSync();

  mq.flip(true);
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(isDark()).toBe(true);

  mq.flip(false);
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(isDark()).toBe(false);
});

it('notifies subscribers on a flip, and stops after unsubscribe', () => {
  const mq = stubMatchMedia(false);
  const { startThemeSync, onThemeChange } = loadTheme();
  startThemeSync();

  const seen: boolean[] = [];
  const unsub = onThemeChange(dark => seen.push(dark));

  mq.flip(true);
  mq.flip(false);
  expect(seen).toEqual([true, false]);

  unsub();
  mq.flip(true);
  expect(seen).toEqual([true, false]);
});

it('reports the state at subscribe time via isDark(), not a replayed callback', () => {
  stubMatchMedia(true);
  const { startThemeSync, onThemeChange, isDark } = loadTheme();
  startThemeSync();

  const seen: boolean[] = [];
  onThemeChange(dark => seen.push(dark));

  // A late subscriber gets no synthetic first call — it reads isDark() instead,
  // which is how schedule-x's initial `isDark:` config value is sourced.
  expect(seen).toEqual([]);
  expect(isDark()).toBe(true);
});

it('no-ops without matchMedia instead of throwing (jsdom has none)', () => {
  expect((window as any).matchMedia).toBeUndefined();
  const { startThemeSync, isDark, onThemeChange } = loadTheme();

  expect(() => startThemeSync()).not.toThrow();
  expect(isDark()).toBe(false);
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(() => onThemeChange(() => {})()).not.toThrow();
});
