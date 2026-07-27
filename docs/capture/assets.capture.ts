import { expect, test } from '@playwright/test';
import { beat, tap, tapAndReplace, tapAndType, type as typeText } from './cursor';
import { hstackGif, toGif } from './gif';
import {
  befriend,
  capturePeer,
  EXAMPLE_COUNT,
  nameContact,
  openDocNamed,
  seedExamples,
  setDisplayName,
  share,
  still,
  take,
  takePair,
  waitFor,
  warmDoc,
} from './support';

/**
 * Regenerates every image in docs/ from the real app.
 *
 * One test per asset, so a single stale image can be refreshed with
 * `npm run docs:capture -- -g homepage.png` instead of rerunning everything.
 * Assets are written straight into docs/ (where `npm run slides` picks them up);
 * raw recordings stay in the gitignored .work/ scratch directory.
 *
 * See README.md for the full list and how to add one.
 */

/** A TaskList with enough content to look real in a two-peer capture. */
const SHARED_TASKS = {
  '@type': 'TaskList',
  name: 'Camping trip',
  tasks: {
    t1: { '@type': 'Task', title: 'Book the campsite', progress: 'completed' },
    t2: { '@type': 'Task', title: 'Borrow a second tent', progress: 'needs-action' },
    t3: { '@type': 'Task', title: 'Plan the meals', progress: 'needs-action' },
    t4: { '@type': 'Task', title: 'Check the weather', progress: 'needs-action' },
  },
};

// ---------------------------------------------------------------- stills, one peer

test('homepage.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await seedExamples(phil.page);
  await still(phil.page, 'homepage.png');
  await phil.close();
});

test('settings.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await phil.page.goto('/#/settings');
  await expect(phil.page.locator('md-list-item').filter({ hasText: 'Devices' })).toBeVisible();
  await still(phil.page, 'settings.png');
  await phil.close();
});

test('todo.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await seedExamples(phil.page);
  await openDocNamed(phil.page, 'Family Groceries');
  await expect(phil.page.getByTestId('task-row').first()).toBeVisible();
  await still(phil.page, 'todo.png');
  await phil.close();
});

test('link-device.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  await setDisplayName(phil.page, 'Phil');
  await phil.page.goto('/#/settings/devices');
  // Opening the sheet fires a native confirm() about syncing settings to the
  // new device; the peer's dialog handler accepts it.
  await phil.page.getByRole('button', { name: 'Link Device' }).click();
  await expect(phil.page.locator('div[title="Click to copy link"] svg')).toBeVisible({ timeout: 60_000 });
  await beat(phil.page, 600);
  await still(phil.page, 'link-device.png');
  await phil.close();
});

// ---------------------------------------------------------------- stills, two peers

test('connections.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  const sam = await capturePeer(browser, 'sam');
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  await share(phil, sam, bGroup, docId);

  // Both sitting on the doc is what makes them peers on the wire.
  await phil.page.goto(`/#/d/${docId}`);
  await sam.page.goto(`/#/d/${docId}`);

  // The direct-WebRTC upgrade is opportunistic. Prefer it — a filled dot and
  // "direct (P2P)" is the whole point of the slide — but do not fail the run if
  // the upgrade doesn't land; the relay fallback is a truthful screenshot too.
  const direct = await waitFor(
    () => phil.call('getDirectPeers'),
    (peers) => Array.isArray(peers) && peers.length > 0,
    { label: 'direct P2P channel', timeout: 45_000, interval: 1000 }
  ).catch(() => null);
  if (!direct) console.warn('  ! no direct WebRTC channel — connections.png will show "via relay"');

  await phil.page.goto('/#/connection');
  await expect(phil.page.getByText(/Peer devices connected: [1-9]/)).toBeVisible({ timeout: 60_000 });
  await beat(phil.page, 800);
  await still(phil.page, 'connections.png');
  await Promise.all([phil.close(), sam.close()]);
});

test('sharing.png', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil');
  const sam = await capturePeer(browser, 'sam');
  const ada = await capturePeer(browser, 'ada');
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  await setDisplayName(ada.page, 'Ada');
  const { bGroup: samGroup } = await befriend(phil, sam);
  const { bGroup: adaGroup } = await befriend(phil, ada);
  await nameContact(phil, 0, 'Sam');
  await nameContact(phil, 1, 'Ada');

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  // Two people at different roles — the page is about who can do what.
  await share(phil, sam, samGroup, docId, 'edit');
  await share(phil, ada, adaGroup, docId, 'read');
  await sam.page.goto(`/#/d/${docId}`);
  await ada.page.goto(`/#/d/${docId}`);

  await phil.page.goto(`/#/d/${docId}/share`);
  // The list is *other* members — you are not a row in your own share list.
  await expect(phil.page.getByTestId('member-row')).toHaveCount(2, { timeout: 60_000 });
  await expect(phil.page.getByTestId('member-row').filter({ hasText: 'Sam' })).toBeVisible();
  await beat(phil.page, 1200);
  await still(phil.page, 'sharing.png');
  await Promise.all([phil.close(), sam.close(), ada.close()]);
});

// ---------------------------------------------------------------- screencasts, one peer

test('new-doc.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await seedExamples(phil.page);

  const clip = await take(phil, async (page) => {
    await beat(page, 900);
    await tap(page, page.getByRole('button', { name: 'New document' }));
    const sheet = page.getByTestId('create-doc-sheet');
    await expect(sheet).toBeVisible();
    await beat(page, 700);

    // Substring match: shadow-DOM innerText carries a trailing newline.
    await tap(page, sheet.locator('md-list-item', { hasText: 'Task list' }));
    const title = page.getByTestId('doc-title-input');
    await expect(title).toBeVisible({ timeout: 30_000 });
    await beat(page, 600);

    await tapAndReplace(page, title, 'Camping trip');
    await title.press('Enter');
    await beat(page, 700);

    await tap(page, page.getByRole('button', { name: 'New task' }));
    const taskTitle = page.getByTestId('ted-title');
    await expect(taskTitle).toBeVisible({ timeout: 30_000 });
    await beat(page, 500);
    await tapAndType(page, taskTitle, 'Book the campsite');
    // Tasks auto-save on blur — no Save button.
    await taskTitle.press('Escape');
    await expect(page.getByTestId('task-row')).toHaveCount(1, { timeout: 30_000 });
  }, { url: '/#/' });

  await toGif('new-doc.gif', clip);
  await phil.close();
});

test('timeline.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  await seedExamples(phil.page);
  const docId = await openDocNamed(phil.page, 'Family Groceries');

  const clip = await take(phil, async (page) => {
    await expect(page.getByTestId('task-row').first()).toBeVisible({ timeout: 30_000 });
    await beat(page, 700);

    // A few edits so the version history has something to scrub through.
    for (const i of [0, 1, 2]) {
      await tap(page, page.getByTestId('task-row').nth(i).locator('md-checkbox'));
      await beat(page, 450);
    }

    await tap(page, page.getByRole('button', { name: 'More actions' }));
    await beat(page, 500);
    await tap(page, page.locator('md-menu-item[title="History"]'));
    await expect(page.getByText(/Version history \(\d+\)/)).toBeVisible({ timeout: 30_000 });
    await beat(page, 800);

    // Scrub the slider back through the versions, then forward again.
    const slider = page.locator('input[type="range"]');
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width - 4, y, { steps: 10 });
    await page.mouse.down();
    await page.mouse.move(box.x + 4, y, { steps: 34 });
    await beat(page, 900);
    await page.mouse.move(box.x + box.width - 4, y, { steps: 26 });
    await page.mouse.up();
    await beat(page, 600);
  }, { url: `/#/d/${docId}` });

  await toGif('timeline.gif', clip);
  await phil.close();
});

// ---------------------------------------------------------------- screencasts, two peers

test('linking-a-device.gif', async ({ browser }) => {
  const laptop = await capturePeer(browser, 'laptop', { video: true });
  const phone = await capturePeer(browser, 'phone', { video: true });
  await setDisplayName(laptop.page, 'Phil');
  // The point of linking is that the new device inherits the user's documents,
  // so the first device needs a library worth inheriting.
  await seedExamples(laptop.page);

  const clips = await takePair(
    laptop,
    phone,
    async (l, r) => {
      // Open on the first device's documents, and the second device's empty one.
      await expect(l.getByTestId('doc-row')).toHaveCount(EXAMPLE_COUNT);
      await beat(l, 1600);

      await l.goto('/#/settings/devices');
      await beat(l, 600);
      await tap(l, l.getByRole('button', { name: 'Link Device' }));
      await expect(l.locator('div[title="Click to copy link"] svg')).toBeVisible({ timeout: 60_000 });
      await beat(l, 1200);

      const url = await l.locator('input[readonly]').inputValue();
      expect(url).toMatch(/#\/link-device\/r\./);

      // The new device opens the link; both sides then show the same five-step
      // rendezvous ladder, which is the part worth watching.
      await r.goto(url);
      await expect(r.getByText('Link Device')).toBeVisible({ timeout: 30_000 });
      await expect(r.getByText('Linking complete')).toBeVisible({ timeout: 120_000 });
      await beat(r, 900);

      // The payoff: the same documents arrive on the new device's home page.
      await tap(r, r.getByRole('button', { name: 'Done' }));
      await r.goto('/#/');
      await expect
        .poll(() => r.getByTestId('doc-row').count(), { timeout: 180_000, intervals: [500] })
        .toBe(EXAMPLE_COUNT);
      await beat(r, 1500);

      // And the new device shows as Online back on the first one.
      await l.goto('/#/settings/devices');
      await expect(l.getByText(/^Online/).first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 800);
    },
    { leftUrl: '/#/', rightUrl: '/#/' }
  );

  await hstackGif('linking-a-device.gif', clips.left, clips.right);
  await Promise.all([laptop.close(), phone.close()]);
});

test('presence-updates.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  const { bGroup } = await befriend(phil, sam);

  const { docId } = await phil.call('createDoc', SHARED_TASKS);
  await share(phil, sam, bGroup, docId, 'edit');
  await nameContact(phil, 0, 'Sam');
  await nameContact(sam, 0, 'Phil');
  // Both workers must hold the doc before either editor mounts, or the first
  // presence broadcast races a cold worker and no dots appear.
  await warmDoc(phil, docId, 'Camping trip');
  await warmDoc(sam, docId, 'Camping trip');

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      // Staggered opens, as editor-presence.spec.ts does: Phil is already in the
      // document when Sam arrives, so the capture shows a peer *joining*.
      await l.goto(`/#/d/${docId}`);
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 2500);

      await r.goto(`/#/d/${docId}`);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await expect(l.getByTestId('peer-dot').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1200);

      // Both open the *same* task, so Phil is watching the per-field dots
      // rather than a single row marker.
      const TASK = 'Plan the meals';
      await tap(l, l.getByRole('button', { name: `Edit ${TASK}` }));
      await expect(l.getByTestId('ted-title')).toBeVisible({ timeout: 30_000 });
      await beat(l, 900);

      await tap(r, r.getByRole('button', { name: `Edit ${TASK}` }));
      const title = r.getByTestId('ted-title');
      await expect(title).toBeVisible({ timeout: 30_000 });
      await beat(r, 900);

      // Sam moves between fields; on Phil's side the dot follows, because
      // presence is a path into the document rather than a cursor position.
      // Only the title has a testid — the rest are identified by input type.
      await tap(r, title);
      await beat(r, 500);
      await title.press('End');
      await typeText(r, ' — burgers + salad', 85);
      await beat(l, 1400);

      await tap(r, r.locator('input[type="number"]'));
      await beat(r, 400);
      await r.keyboard.press('ControlOrMeta+a');
      await typeText(r, '2', 120);
      await beat(l, 1400);

      await tap(r, r.locator('textarea'));
      await beat(r, 400);
      await typeText(r, 'Two dinners, one packed lunch.', 70);
      await beat(l, 1600);
    },
    // Both start on Home; the flow navigates them into the document, staggered.
    { leftUrl: '/#/', rightUrl: '/#/' }
  );

  await hstackGif('presence-updates.gif', clips.left, clips.right);
  await Promise.all([phil.close(), sam.close()]);
});

test('add-and-share-with-friend.gif', async ({ browser }) => {
  const phil = await capturePeer(browser, 'phil', { video: true });
  const sam = await capturePeer(browser, 'sam', { video: true });
  await setDisplayName(phil.page, 'Phil');
  await setDisplayName(sam.page, 'Sam');
  // Each side names the other when the rendezvous completes (native prompt).
  phil.setPromptAnswer('Sam');
  sam.setPromptAnswer('Phil');

  const { docId } = await phil.call('createDoc', SHARED_TASKS);

  const clips = await takePair(
    phil,
    sam,
    async (l, r) => {
      // Phil starts in the document he wants to share.
      await expect(l.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      // The sharing page opens its QR invite by itself when a document has no
      // members and the user has no contacts — there would be nothing else to
      // show. So do NOT click "Add people" here: that click lands on the
      // sheet's own overlay and dismisses the invite instead of opening it.
      await tap(l, l.getByRole('link', { name: 'Share' }));
      await expect(l.locator('div[title="Click to copy link"] svg')).toBeVisible({ timeout: 60_000 });
      await beat(l, 1400);

      const url = await l.locator('input[readonly]').inputValue();
      expect(url).toMatch(/#\/add-friend\/r\./);

      await r.goto(url);
      // The receiver's success path is a prompt() then a bounce to home, so the
      // contact landing on Sam's side is the observable end of the exchange.
      await expect(r).toHaveURL(/#\/$/, { timeout: 120_000 });
      await beat(r, 900);

      // Phil's QR sheet closes itself once the exchange is done, and the page
      // then asks what the new friend may do — sharing always names a role.
      await expect(l.getByTestId('role-picker-sheet')).toBeVisible({ timeout: 60_000 });
      await beat(l, 900);
      await tap(l, l.getByTestId('role-edit'));
      // You are not a row in your own share list, so one contact is one row.
      await expect(l.getByTestId('member-row')).toHaveCount(1, { timeout: 60_000 });
      await beat(l, 900);

      // It appears on Sam's home page, and he opens it.
      await r.goto('/#/');
      const row = r.getByTestId('doc-row').filter({ hasText: 'Camping trip' });
      await expect(row).toBeVisible({ timeout: 90_000 });
      await beat(r, 1200);
      await tap(r, row);
      await expect(r.getByTestId('task-row').first()).toBeVisible({ timeout: 60_000 });
      await beat(r, 1400);
    },
    // Phil opens on the document itself; Sam on his (empty) home page.
    { leftUrl: `/#/d/${docId}`, rightUrl: '/#/' }
  );

  await hstackGif('add-and-share-with-friend.gif', clips.left, clips.right);
  await Promise.all([phil.close(), sam.close()]);
});
