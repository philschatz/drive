/** TEMP verification spec — deleted after the verify run. */
import { test, expect } from '@playwright/test';
import { openApp } from './ui/support';

const SHOT = '/tmp/nix-shell.AeLrkC/claude-1000/-home-phil-code-mine-drive/352e20d6-5043-4838-9ad3-73d39fec9bc2/scratchpad';

test('Settings devices list shows role Select for This device (admin)', async ({ browser }) => {
  const app = await openApp(browser, 'settings');
  await app.page.goto('/#/settings');
  // Devices section heading, then wait for the "This device" row.
  await expect(app.page.getByRole('heading', { name: 'Devices' })).toBeVisible({ timeout: 30_000 });
  await expect(app.page.getByText('This device')).toBeVisible({ timeout: 30_000 });
  // The admin self device must render a role Select (combobox), defaulting to Admin.
  const combo = app.page.getByRole('combobox');
  await expect(combo.first()).toBeVisible();
  const roleText = (await combo.first().innerText()).trim();
  console.log('[verify] self-device role control text:', JSON.stringify(roleText));
  await app.page.screenshot({ path: `${SHOT}/settings-devices.png`, fullPage: true });
  app.assertNoFatalErrors();
  await app.close();
});

test('Link Device sender page shows approximate payload size', async ({ browser }) => {
  const app = await openApp(browser, 'link');
  await app.page.goto('/#/link-device');
  const start = app.page.getByRole('button', { name: 'Start the process' });
  await expect(start).toBeEnabled({ timeout: 60_000 }); // needs relay WS connected
  await start.click();
  const caption = app.page.getByText(/Sending ~.* to the other device\./);
  await expect(caption).toBeVisible({ timeout: 60_000 });
  const captionText = (await caption.innerText()).trim();
  console.log('[verify] link-device caption:', JSON.stringify(captionText));
  await app.page.screenshot({ path: `${SHOT}/link-device-sender.png`, fullPage: true });
  app.assertNoFatalErrors();
  await app.close();
});

test('Add a friend sender page shows approximate payload size', async ({ browser }) => {
  const app = await openApp(browser, 'friend');
  await app.page.goto('/#/add-friend');
  const start = app.page.getByRole('button', { name: 'Start the process' });
  await expect(start).toBeEnabled({ timeout: 60_000 });
  await start.click();
  const caption = app.page.getByText(/Sending ~.* to the other device\./);
  await expect(caption).toBeVisible({ timeout: 60_000 });
  const captionText = (await caption.innerText()).trim();
  console.log('[verify] add-friend caption:', JSON.stringify(captionText));
  await app.page.screenshot({ path: `${SHOT}/add-friend-sender.png`, fullPage: true });
  app.assertNoFatalErrors();
  await app.close();
});
