import { test, expect, type Browser } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';

/**
 * End-to-end "Add Friend" through the real UI + link (not the worker API):
 *   - the sharer opens the Add Friend sheet (from Contacts), which auto-starts the
 *     rendezvous — no "Start the process" button — and the QR link appears in a
 *     readonly input we read out of the DOM;
 *   - a SECOND, genuinely-cold browser opens that link directly — AddFriendPage's
 *     doReceive() runs on mount, so the receiver's worker/keyhive may still be
 *     booting (the real-world race the worker-level rendezvous.spec never hits,
 *     because its peers are pre-booted at '/').
 *
 * Both browsers must end up mutual contacts, and — since two fresh browsers have
 * no name set — each side must raise a prompt to name the (nameless) other.
 */

/**
 * Answer the completion dialogs the add-friend flow raises: a prompt asking for
 * the (nameless) friend's name, or an alert when they did send one. Must be
 * attached before the flow can finish. Registering any handler opts out of
 * Playwright's default auto-dismiss, so this has to cover every dialog type.
 */
function answerNamePrompt(peer: Pick<Peer, 'page'>, name: string) {
  peer.page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') void dialog.accept(name);
    else void dialog.accept();
  });
}

/**
 * Open `url` in a brand-new, un-warmed context, exactly as a friend clicking the
 * link would: the add-friend route is the FIRST navigation, so the page mounts
 * (and auto-runs doReceive) while the worker + keyhive are still initializing.
 * Unlike newPeer we do NOT await keyhiveReady before returning — that would mask
 * the cold-start race; `call`/`waitFor` below tolerate the not-yet-ready worker.
 */
async function coldOpenLink(browser: Browser, name: string, url: string, promptAnswer?: string): Promise<Peer> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${name}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));

  // Before goto: doReceive() auto-runs on mount, so the dialog can fire early.
  if (promptAnswer !== undefined) answerNamePrompt({ page }, promptAnswer);

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

/** Sharer opens the Add Friend sheet, which auto-starts the exchange, and returns the QR/link URL. */
async function startShareAndGetLink(alice: Peer): Promise<string> {
  // Drive it from Contacts (not Settings): the sheet auto-starts on open, so there's
  // no "Start the process" button, and Contacts has no other "Save" button to collide
  // with the sheet's contact-name Save used by the naming test below.
  await alice.page.goto('/#/contacts');
  await alice.page.getByRole('button', { name: 'Add Friend' }).click();

  // The sheet stages the rendezvous once keyhive + the relay WS are ready; the
  // readonly link input appears when it's staged (the generous timeout covers connect).
  const linkInput = alice.page.locator('input[readonly]');
  await expect(linkInput).toHaveValue(/#\/add-friend\/r\./, { timeout: 30_000 });
  return linkInput.inputValue();
}

test('two fresh browsers become mutual contacts via the add-friend link', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    alice = await newPeer(browser, 'alice');
    // Neither peer has a name set, so both ends finish on a name prompt.
    answerNamePrompt(alice, 'Bob');
    const url = await startShareAndGetLink(alice);

    // A different, cold browser opens the link — the receiver flow runs itself.
    bob = await coldOpenLink(browser, 'bob', url, 'Alice');

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

test('each side names a contact who sent no name, via the prompt', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    // Neither peer sets a name, so neither transmits one during the exchange —
    // which is what makes both ends fall through to the naming prompt.
    alice = await newPeer(browser, 'alice');
    answerNamePrompt(alice, 'Bob (from Alice)');
    const url = await startShareAndGetLink(alice);
    bob = await coldOpenLink(browser, 'bob', url, 'Alice (from Bob)');

    const { userGroupId: aliceGroup } = await alice.call('ensureUserGroup', { create: true });
    const { userGroupId: bobGroup } = await bob.call('ensureUserGroup', { create: true });

    // Receiver side (Bob): the prompt answer is saved against Alice's group.
    await waitFor(
      () => bob!.call('getAllContactNames'),
      (names) => names[aliceGroup!] === 'Alice (from Bob)',
      { label: 'bob named alice' },
    );

    // Sharer side (Alice): she got no name for Bob, so she is prompted too.
    await waitFor(
      () => alice!.call('getAllContactNames'),
      (names) => names[bobGroup!] === 'Bob (from Alice)',
      { label: 'alice named bob' },
    );

    // Both dialogs resolved themselves: Alice's sheet closed behind them.
    await expect(alice.page.locator('input[readonly]')).toHaveCount(0);
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});
