import { test, expect, type Browser } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';

/**
 * End-to-end "Add Friend" through the real UI + link (not the worker API):
 *   - the sharer opens #/add-friend, clicks "Start the process", and the QR link
 *     appears in a readonly input we read out of the DOM;
 *   - a SECOND, genuinely-cold browser opens that link directly — AddFriendPage's
 *     doReceive() runs on mount, so the receiver's worker/keyhive may still be
 *     booting (the real-world race the worker-level rendezvous.spec never hits,
 *     because its peers are pre-booted at '/').
 *
 * Both browsers must end up mutual contacts, and — since two fresh browsers have
 * no name set — each side must offer an input to name the (nameless) other.
 */

/**
 * Open `url` in a brand-new, un-warmed context, exactly as a friend clicking the
 * link would: the add-friend route is the FIRST navigation, so the page mounts
 * (and auto-runs doReceive) while the worker + keyhive are still initializing.
 * Unlike newPeer we do NOT await keyhiveReady before returning — that would mask
 * the cold-start race; `call`/`waitFor` below tolerate the not-yet-ready worker.
 */
async function coldOpenLink(browser: Browser, name: string, url: string): Promise<Peer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${name}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));

  await page.goto(url);
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 60_000 });

  const call = ((fn: string, ...args: any[]) =>
    page.evaluate(
      ({ fn, args }) => {
        const api = (window as any).__drive;
        if (typeof api[fn] !== 'function') throw new Error(`window.__drive.${fn} is not a function`);
        return Promise.resolve(api[fn](...args));
      },
      { fn, args },
    )) as Peer['call'];

  return { name, context, page, call, close: () => context.close() };
}

/** Sharer opens Add Friend, starts the exchange, and returns the QR/link URL. */
async function startShareAndGetLink(alice: Peer): Promise<string> {
  await alice.page.goto('/#/add-friend');
  const startBtn = alice.page.getByRole('button', { name: 'Start the process' });
  await expect(startBtn).toBeEnabled({ timeout: 30_000 }); // gated on the relay WS connecting
  await startBtn.click();

  const linkInput = alice.page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/#\/add-friend\/r\./, { timeout: 30_000 });
  return linkInput.inputValue();
}

test('two fresh browsers become mutual contacts via the add-friend link', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    alice = await newPeer(browser, 'alice');
    const url = await startShareAndGetLink(alice);

    // A different, cold browser opens the link — the receiver flow runs itself.
    bob = await coldOpenLink(browser, 'bob', url);

    // Each peer's own user-group id (the id a contact is keyed by).
    const { userGroupId: aliceGroup } = await alice.call('ensureUserGroup', { create: true });
    const { userGroupId: bobGroup } = await bob.call('ensureUserGroup', { create: true });
    expect(aliceGroup).toBeTruthy();
    expect(bobGroup).toBeTruthy();

    // Direction 1: Bob (the one who opened the link) knows Alice.
    await waitFor(
      () => bob!.call('getKnownContacts', ''),
      (list) => list.some((c) => c.agentId === aliceGroup),
      { label: 'bob knows alice' },
    );
    // Direction 2: Alice knows Bob — the mutual half, all from one link.
    await waitFor(
      () => alice!.call('getKnownContacts', ''),
      (list) => list.some((c) => c.agentId === bobGroup),
      { label: 'alice knows bob' },
    );
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});

test('each side can name a contact who sent no name', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  const NAME_INPUT = 'Enter a name for this contact...';
  try {
    // Neither peer sets a name, so neither transmits one during the exchange.
    alice = await newPeer(browser, 'alice');
    const url = await startShareAndGetLink(alice);
    bob = await coldOpenLink(browser, 'bob', url);

    const { userGroupId: aliceGroup } = await alice.call('ensureUserGroup', { create: true });
    const { userGroupId: bobGroup } = await bob.call('ensureUserGroup', { create: true });

    // Receiver side (Bob): the "name this contact" input is already offered.
    const bobInput = bob.page.getByPlaceholder(NAME_INPUT);
    await expect(bobInput).toBeVisible({ timeout: 30_000 });
    await bobInput.fill('Alice (from Bob)');
    await bob.page.getByRole('button', { name: 'Save' }).click();
    await waitFor(
      () => bob!.call('getAllContactNames'),
      (names) => names[aliceGroup!] === 'Alice (from Bob)',
      { label: 'bob named alice' },
    );

    // Sharer side (Alice): she got no name for Bob, so an input must appear here too.
    const aliceInput = alice.page.getByPlaceholder(NAME_INPUT);
    await expect(aliceInput).toBeVisible({ timeout: 30_000 });
    await aliceInput.fill('Bob (from Alice)');
    await alice.page.getByRole('button', { name: 'Save' }).click();
    await waitFor(
      () => alice!.call('getAllContactNames'),
      (names) => names[bobGroup!] === 'Bob (from Alice)',
      { label: 'alice named bob' },
    );
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});
