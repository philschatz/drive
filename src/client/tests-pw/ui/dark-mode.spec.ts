import { test, expect } from '@playwright/test';
import { openApp, createDocViaUI, type App } from './support';

/**
 * Dark mode end to end — the only place it *can* be checked.
 *
 * ui/common/theme.ts is unit-tested in jsdom, but jsdom has no `matchMedia`, does
 * not evaluate Tailwind's `@custom-variant`, and does not compute custom
 * properties. So the chain this feature actually depends on —
 * `prefers-color-scheme` → `.dark` on <html> → the `--md-sys-color-*` block →
 * `@theme inline` → a `bg-*` utility — only exists in a real browser.
 *
 * The rest of the suite is unaffected: playwright.config.ts sets no `colorScheme`,
 * so every other spec keeps Playwright's `light` default. This spec opts in on its
 * own context instead of via test.use.
 *
 * One test, one app boot: `emulateMedia` re-themes the live page, so both schemes
 * can be asserted in sequence without paying for a second browser and worker just
 * to start in the other one.
 */

/** Token values straight out of globals.css, light `:root` vs `.dark`.
 * Lowercase because the production CSS minifier normalizes hex case. */
const SURFACE_LIGHT = '#f9f9ff';
const SURFACE_DARK = '#111318';
/** The same two, as a `bg-background` utility resolves them. */
const SURFACE_LIGHT_RGB = 'rgb(249, 249, 255)';
const SURFACE_DARK_RGB = 'rgb(17, 19, 24)';

/**
 * Read the live surface token plus what a Tailwind utility mapped onto it
 * actually paints. The probe div proves the `@theme inline` hop, which a
 * `getPropertyValue` alone would not: `bg-background` is compiled into the
 * bundle because sheet.tsx uses it, so the rule exists to be picked up.
 */
async function readTheme(app: App) {
  return app.page.evaluate(({ }) => {
    const probe = document.createElement('div');
    probe.className = 'bg-background';
    document.body.appendChild(probe);
    const utility = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      hasDarkClass: document.documentElement.classList.contains('dark'),
      surface: getComputedStyle(document.documentElement)
        .getPropertyValue('--md-sys-color-surface')
        .trim(),
      utility,
    };
  }, {});
}

test('the OS color scheme themes the app, and a live flip re-themes it', async ({ browser }) => {
  const app = await openApp(browser, 'theme', { colorScheme: 'light' });
  try {
    // A light-scheme OS leaves the app exactly as it was.
    expect(await readTheme(app)).toEqual({
      hasDarkClass: false,
      surface: SURFACE_LIGHT,
      utility: SURFACE_LIGHT_RGB,
    });

    await createDocViaUI(app, 'Calendar', 'Theme cal');

    // schedule-x ships its own stylesheet keyed off `.is-dark` on its wrapper,
    // which is why it needs the explicit setTheme() push rather than riding the
    // token flip like everything else.
    const wrapper = app.page.locator('.sx__calendar-wrapper');
    await expect(wrapper).toBeVisible({ timeout: 15_000 });
    await expect(wrapper).not.toHaveClass(/is-dark/);

    await app.page.emulateMedia({ colorScheme: 'dark' });

    // No reload: the same DOM must re-theme, every layer of it — the class, the
    // token, the utility that reads the token, and schedule-x.
    await expect(app.page.locator('html')).toHaveClass(/dark/);
    await expect(wrapper).toHaveClass(/is-dark/);
    expect(await readTheme(app)).toEqual({
      hasDarkClass: true,
      surface: SURFACE_DARK,
      utility: SURFACE_DARK_RGB,
    });

    // And back, so a flip is not one-way.
    await app.page.emulateMedia({ colorScheme: 'light' });
    await expect(app.page.locator('html')).not.toHaveClass(/dark/);
    await expect(wrapper).not.toHaveClass(/is-dark/);
    expect((await readTheme(app)).utility).toBe(SURFACE_LIGHT_RGB);
  } finally {
    app.assertNoFatalErrors();
    await app.close();
  }
});
