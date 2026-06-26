import { test, expect } from '@playwright/test';

/**
 * TEMPORARY diagnostic: open Settings, click "Show QR code", and report what
 * actually renders (svg? fallback note? nothing?) plus the captured console.
 */
test('diagnose Settings QR rendering', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });
  await page.evaluate(() =>
    Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady]),
  );

  await page.goto('/#/settings');

  // The "Share me with a friend" button (lowercase "code"); the device one is
  // "Show QR Code" (capital C).
  const friendBtn = page.getByRole('button', { name: 'Show QR code', exact: true });
  await expect(friendBtn).toBeVisible({ timeout: 15_000 });
  await friendBtn.click();

  // Give generation a moment.
  await page.waitForTimeout(3000);

  // Inspect the DOM: is there an <svg>, the fallback note, or nothing?
  const report = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('section'));
    const friendSection = sections.find((s) => /share me with a friend/i.test(s.textContent || ''));
    const svgCount = friendSection?.querySelectorAll('svg').length ?? -1;
    const inputVal = (friendSection?.querySelector('input[readonly]') as HTMLInputElement | null)?.value ?? null;
    return {
      friendSectionFound: !!friendSection,
      svgCount,
      friendSectionHTML: friendSection?.innerHTML?.slice(0, 1500) ?? '(none)',
      urlLength: inputVal?.length ?? null,
      urlSample: inputVal?.slice(0, 80) ?? null,
    };
  });

  console.log('\n========= QR DIAGNOSTIC =========');
  console.log('friendSectionFound:', report.friendSectionFound);
  console.log('svgCount:', report.svgCount);
  console.log('urlLength:', report.urlLength);
  console.log('urlSample:', report.urlSample);
  console.log('--- friend section HTML ---\n', report.friendSectionHTML);
  console.log('--- captured page console ---');
  for (const l of logs) console.log('  ', l);
  console.log('================================\n');

  await context.close();
});
