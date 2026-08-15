import { test, expect, type Browser } from '@playwright/test';
import { newPeer, waitFor, type Peer } from './support/peer';
import { mdField } from './ui/support';

/**
 * End-to-end "Invite a friend" through the real UI + link (not the worker API):
 *   - the sharer opens the invite sheet from the Friends page FAB, which
 *     auto-starts the rendezvous — no "Start the process" button — and the QR
 *     link appears in a readonly input we read out of the DOM;
 *   - a SECOND, genuinely-cold browser opens that link directly and answers the
 *     confirmation gate. The tap lands as the page paints, so the receiver's
 *     worker/keyhive may still be booting — that cold-start race is the reason this
 *     test exists at the UI level rather than against the worker API, where both
 *     peers are already booted.
 *
 * Both browsers must end up mutual friends, and — since two fresh browsers have
 * no name set — each side must be offered a name field for the (nameless) other,
 * with the name it types ending up in that side's roster.
 *
 * There are deliberately NO `page.on('dialog')` handlers anywhere in this file:
 * the flow raises no native dialogs any more (the alert/prompt became a snackbar
 * and a Material name field). With none registered, Playwright's default
 * auto-dismiss applies, so a dialog creeping back in would fail the naming waits
 * loudly rather than being silently answered.
 */

/** Fill the name field and save it. Both surfaces expose RenameSheet's fixed testids. */
async function nameTheFriend(peer: Pick<Peer, 'page'>, name: string) {
  await expect(mdField(peer.page, 'rename-input')).toBeVisible({ timeout: 30_000 });
  await mdField(peer.page, 'rename-input').fill(name);
  await peer.page.getByTestId('rename-save').click();
}

/**
 * Open `url` in a brand-new, un-warmed context, exactly as a friend clicking the
 * link would: the add-friend route is the FIRST navigation, so the page mounts while
 * the worker + keyhive are still initializing. Unlike newPeer we do NOT await
 * keyhiveReady before returning — that would mask the cold-start race the confirm
 * tap then lands in the middle of; `call`/`waitFor` below tolerate the not-yet-ready
 * worker.
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

/** Sharer opens the invite sheet, which auto-starts the exchange, and returns the QR/link URL. */
async function startShareAndGetLink(alice: Peer): Promise<string> {
  // The Friends page FAB is the primary way in; the sheet auto-starts on open,
  // so there is no "Start the process" button to click afterwards.
  await alice.page.goto('/#/friends');
  await alice.page.getByRole('button', { name: 'Invite a friend' }).click();

  // The sheet stages the rendezvous once keyhive + the relay WS are ready; the
  // readonly link input appears when it's staged (the generous timeout covers connect).
  const linkInput = alice.page.getByTestId('rendezvous-url');
  await expect(linkInput).toHaveValue(/#\/add-friend\/r\./, { timeout: 30_000 });
  return linkInput.inputValue();
}

test('two fresh browsers become mutual friends via the add-friend link', async ({ browser }) => {
  let alice: Peer | undefined;
  let bob: Peer | undefined;
  try {
    // Neither peer sets a name, so neither transmits one during the exchange —
    // which is what makes both ends fall through to the naming field.
    alice = await newPeer(browser, 'alice');
    const url = await startShareAndGetLink(alice);

    // The whole link has to fit in a scannable QR code, which is why the payload
    // travels over the relay rendezvous and only a topic id + key ride the URL.
    // (The size of the payload behind it is bounded in tests/rendezvous-bounds.)
    expect(new URL(url).hash.length).toBeLessThan(200);

    // A different, cold browser opens the link and answers the gate. Nothing has
    // reached Alice until this tap — that is the point of the gate.
    bob = await coldOpenLink(browser, 'bob', url);
    await bob.page.getByTestId('add-friend-confirm').click();

    // Both ends land on the name field. Naming is what closes each side's flow, so
    // it has to happen before the assertions. Receiver side (Bob) is
    // AddFriendPage's RenameSheet; sharer side (Alice) is the invite sheet's own
    // body, swapped in place of the QR.
    await nameTheFriend(bob, 'Alice');
    await nameTheFriend(alice, 'Bob');

    // Each peer's own user-group id (the id a friend is keyed by).
    const { userGroupId: aliceGroup } = await alice.call('ensureUserGroup', { create: true });
    const { userGroupId: bobGroup } = await bob.call('ensureUserGroup', { create: true });
    expect(aliceGroup).toBeTruthy();
    expect(bobGroup).toBeTruthy();

    // Direction 1: Bob (the one who opened the link) knows Alice, by the name he gave.
    await waitFor(
      () => bob!.call('getKnownFriends', ''),
      (list) => list.some((c) => c.agentId === aliceGroup),
      { label: 'bob knows alice' },
    );
    await waitFor(
      () => bob!.call('getAllFriendNames'),
      (names) => names[aliceGroup!] === 'Alice',
      { label: 'bob named alice' },
    );
    // Direction 2: Alice knows Bob — the mutual half, all from one link.
    await waitFor(
      () => alice!.call('getKnownFriends', ''),
      (list) => list.some((c) => c.agentId === bobGroup),
      { label: 'alice knows bob' },
    );
    await waitFor(
      () => alice!.call('getAllFriendNames'),
      (names) => names[bobGroup!] === 'Bob',
      { label: 'alice named bob' },
    );

    // Saving the name resolves the flow: Alice's invite sheet closed behind it.
    await expect(alice.page.getByTestId('add-friend-sheet')).toHaveCount(0);
    await expect(alice.page.getByTestId('rendezvous-url')).toHaveCount(0);
  } finally {
    await Promise.all([alice?.close(), bob?.close()].filter(Boolean) as Promise<void>[]);
  }
});
