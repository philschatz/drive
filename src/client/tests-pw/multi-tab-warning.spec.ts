import { test, expect } from '@playwright/test';

/**
 * Multi-tab warning. Two same-origin tabs in ONE browser context share Web
 * Locks (unlike the isolated per-`newPeer` contexts), so the second tab loses
 * the singleton lock and must show the "syncing with multiple tabs isn't
 * supported" banner. Closing the leader releases the lock; the survivor becomes
 * leader and its banner clears.
 */
test('secondary tab shows the multi-tab banner; it clears when it becomes leader', async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const banner = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="multi-tab-banner"]');
  try {
    // Tab 1: sole tab → leader → no banner.
    const page1 = await ctx.newPage();
    await page1.goto('/');
    await expect(banner(page1)).toHaveCount(0);

    // Tab 2: another tab already holds the lock → secondary → banner shows.
    const page2 = await ctx.newPage();
    await page2.goto('/');
    await expect(banner(page2)).toBeVisible({ timeout: 15_000 });
    // Tab 1 (leader) stays clean.
    await expect(banner(page1)).toHaveCount(0);

    // Close the leader → tab 2 acquires the lock → its banner clears.
    await page1.close();
    await expect(banner(page2)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});
