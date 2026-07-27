import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdir } from 'fs/promises';
import path from 'path';
import type { DriveBridge } from '../../src/client/test-bridge';
import { waitFor } from '../../src/client/tests-pw/support/peer';
import { VIEWPORT } from './playwright.config';
import { installCursor } from './cursor';
import { DOCS_DIR, type Clip } from './gif';

export { waitFor };

/** Callable members of `window.__drive` — same derivation as tests-pw/support/peer.ts. */
type DriveApi = {
  [K in keyof DriveBridge as DriveBridge[K] extends (...args: any[]) => any ? K : never]: DriveBridge[K];
};

/**
 * One isolated identity for a capture: its own context (⇒ its own IndexedDB,
 * so its own keyhive device and user group), with video recording armed.
 *
 * This mirrors tests-pw/support/peer.ts, but that harness calls
 * `browser.newContext()` with no options and creates its page eagerly. Captures
 * need context options (recordVideo) and control over *when* the recorded page
 * is created — see `take()` for why.
 */
export interface CapturePeer {
  name: string;
  context: BrowserContext;
  /** The page used for setup and for stills. */
  page: Page;
  /** Invoke window.__drive[fn](...args) in this context. */
  call<K extends keyof DriveApi>(
    fn: K,
    ...args: Parameters<DriveApi[K]>
  ): Promise<Awaited<ReturnType<DriveApi[K]>>>;
  close(): Promise<void>;
  /** Answer for the next window.prompt() (contact naming, rename). */
  setPromptAnswer(answer: string): void;
}

/** Wait for the test bridge, then for worker + keyhive init. */
export async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__drive, undefined, { timeout: 90_000 });
  await page.evaluate(() =>
    Promise.all([(window as any).__drive.workerReady, (window as any).__drive.keyhiveReady])
  );
}

const bridgeCall = (page: Page) =>
  <K extends keyof DriveApi>(fn: K, ...args: Parameters<DriveApi[K]>) =>
    page.evaluate(
      ({ fn, args }) => {
        const api = (window as any).__drive;
        if (typeof api[fn] !== 'function') throw new Error(`window.__drive.${fn} is not a function`);
        return Promise.resolve(api[fn](...args));
      },
      { fn, args }
    ) as Promise<Awaited<ReturnType<DriveApi[K]>>>;

/**
 * Wire the console/dialog plumbing every capture page needs.
 *
 * The dialog handler is not optional: native prompt/confirm/alert gate the
 * add-device settings-sync, the add-friend contact naming, rename and archive.
 * Playwright auto-dismisses unhandled dialogs, which silently aborts the flow
 * mid-capture and yields a GIF of nothing happening.
 */
function attach(page: Page, name: string, promptAnswer: { value: string }): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${name}] console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[${name}] pageerror: ${err.message}`));
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') void dialog.accept(promptAnswer.value);
    else void dialog.accept();
  });
}

export async function capturePeer(
  browser: Browser,
  name: string,
  opts: { video?: boolean } = {}
): Promise<CapturePeer> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    // Video always records at the CSS viewport size; deviceScaleFactor only
    // affects screenshots, so stills stay 2x and clips stay 430x932.
    deviceScaleFactor: 2,
    recordVideo: opts.video
      ? { dir: path.resolve(__dirname, '.work/video'), size: VIEWPORT }
      : undefined,
  });
  const promptAnswer = { value: name };
  const page = await context.newPage();
  attach(page, name, promptAnswer);

  await page.goto('/');
  await ready(page);

  return {
    name,
    context,
    page,
    call: bridgeCall(page),
    close: () => context.close(),
    setPromptAnswer: (answer: string) => {
      promptAnswer.value = answer;
    },
  };
}

/**
 * Close a peer's setup page so the recorded page is the context's only tab.
 * The Web Lock the app uses to detect a second tab is released on unload, so
 * give it a beat before the replacement opens.
 */
async function closeSetupPage(peer: CapturePeer): Promise<void> {
  if (peer.page.isClosed()) return;
  await peer.page.close();
  await new Promise((r) => setTimeout(r, 500));
}

let clipSeq = 0;

/**
 * Close a recorded page and return a path to its finished .webm.
 *
 * `video.path()` is not usable here: Playwright only guarantees the recording
 * is on disk once the whole *context* closes, so encoding straight from that
 * path intermittently fails with "No such file or directory" — the capture
 * still has more work to do in that context, so it cannot close it yet.
 * `saveAs()` waits for the recording to be finalized and copies it out.
 */
async function finishRecording(page: Page, label: string): Promise<string> {
  const video = page.video();
  if (!video) throw new Error(`${label}: no video — was the peer created with { video: true }?`);
  await page.close();
  const dir = path.resolve(__dirname, '.work/clips');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${label}-${++clipSeq}.webm`);
  await video.saveAs(dest);
  return dest;
}

/**
 * Record a screencast on a fresh page of `peer`'s context, and return the clip
 * window inside the resulting video.
 *
 * Videos are recorded per *page*, starting the moment the page is created. Any
 * setup done before the take — seeding documents, friending, opening a shared
 * doc — would otherwise sit at the head of the recording, along with the
 * several seconds of WASM/keyhive boot. So the take runs on a fresh page,
 * created after setup is done, and the offsets are measured from that page's
 * creation: `start` is stamped once the app is interactive, `end` once the flow
 * finishes. The setup page's own video is discarded.
 *
 * The setup page is closed first, and that is not optional: the app refuses to
 * sync in a second tab (a keyhive limitation, enforced with a Web Lock) and
 * shows a "multiple tabs is not supported" banner instead, so a take running
 * alongside a still-open setup page records a degraded, disconnected app.
 * Closing releases the lock; the new page inherits the context's IndexedDB, so
 * the identity and everything seeded into it carry over.
 */
export async function take(
  peer: CapturePeer,
  flow: (page: Page) => Promise<void>,
  opts: { url?: string; tail?: number } = {}
): Promise<Clip> {
  await closeSetupPage(peer);
  const t0 = Date.now();
  const page = await peer.context.newPage();
  attach(page, peer.name, { value: peer.name });
  await installCursor(page);
  await page.goto(opts.url ?? '/');
  await ready(page);
  // Let the first paint settle so the clip never opens on a skeleton.
  await page.waitForTimeout(700);

  const start = (Date.now() - t0) / 1000;
  await flow(page);
  // Hold the final frame briefly so the loop doesn't snap away from the payoff.
  await page.waitForTimeout(opts.tail ?? 1200);
  const end = (Date.now() - t0) / 1000;

  return { video: await finishRecording(page, peer.name), start, end };
}

/**
 * Record two peers' pages concurrently and return both clips, for hstacking.
 *
 * The two flows run against each other (one side's QR is the other side's
 * input), so they are driven as a single async function receiving both pages
 * rather than two independent takes.
 */
export async function takePair(
  left: CapturePeer,
  right: CapturePeer,
  flow: (l: Page, r: Page) => Promise<void>,
  opts: {
    leftUrl?: string;
    rightUrl?: string;
    tail?: number;
    /**
     * Runs after both pages are interactive but *before* the clip window opens.
     *
     * `ready()` plus 700ms covers the app shell, but not a view that keeps
     * working after it mounts — the datagrid still has HyperFormula to spin up
     * and a Monte Carlo pass to run. Since gif.ts freezes the opening frame for
     * a beat so viewers can orient, anything half-painted at that moment is held
     * on screen; use this to wait it out off-camera.
     */
    settle?: (l: Page, r: Page) => Promise<void>;
  } = {}
): Promise<{ left: Clip; right: Clip }> {
  await Promise.all([closeSetupPage(left), closeSetupPage(right)]);
  const t0 = Date.now();
  const lPage = await left.context.newPage();
  const rPage = await right.context.newPage();
  attach(lPage, left.name, { value: left.name });
  attach(rPage, right.name, { value: right.name });
  await Promise.all([installCursor(lPage), installCursor(rPage)]);
  await Promise.all([lPage.goto(opts.leftUrl ?? '/'), rPage.goto(opts.rightUrl ?? '/')]);
  await Promise.all([ready(lPage), ready(rPage)]);
  await lPage.waitForTimeout(700);
  if (opts.settle) await opts.settle(lPage, rPage);

  const start = (Date.now() - t0) / 1000;
  await flow(lPage, rPage);
  await lPage.waitForTimeout(opts.tail ?? 1200);
  const end = (Date.now() - t0) / 1000;

  const [lVideo, rVideo] = await Promise.all([
    finishRecording(lPage, left.name),
    finishRecording(rPage, right.name),
  ]);
  return {
    left: { video: lVideo, start, end },
    right: { video: rVideo, start, end },
  };
}

/** The bundled example documents, created by the empty-home offer. */
export const EXAMPLE_COUNT = 11;

/**
 * Seed the eleven bundled example documents.
 *
 * The "Yes, create examples" offer only renders on an empty home page, so this
 * must run on a fresh context. It is the only seeding path that covers the two
 * Sentences examples — their structure lives in Automerge marks, which the JSON
 * projection can't carry, so they go through createDocsFromItems rather than a
 * plain createDoc.
 */
export async function seedExamples(page: Page): Promise<void> {
  await page.goto('/#/');
  const offer = page.getByTestId('create-examples');
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await offer.click();
  await expect(page.getByTestId('doc-row')).toHaveCount(EXAMPLE_COUNT, { timeout: 120_000 });
  // Dismiss the "Created 11 example documents" banner — it is a seeding
  // artifact, not part of the screen being documented. The Alert's close
  // control is an unlabelled button whose only content is a × glyph.
  const dismiss = page.locator('button').filter({ hasText: /^×$/ });
  if (await dismiss.count()) await dismiss.first().click();
  await page.waitForTimeout(300);
}

/** Open a seeded example by its list row, and wait for the editor to mount. */
export async function openDocNamed(page: Page, name: string): Promise<string> {
  await page.goto('/#/');
  await page.getByTestId('doc-row').filter({ hasText: name }).first().click();
  await expect(page).toHaveURL(/#\/d\//, { timeout: 30_000 });
  await expect(page.getByTestId('doc-title')).toBeVisible({ timeout: 30_000 });
  return /#\/d\/([^/?]+)/.exec(page.url())![1];
}

/**
 * Write a still to docs/<name>.
 *
 * Scrolls to the top first: the document title bars hide themselves on scroll
 * (useHideOnScroll), so a screenshot taken mid-page loses its chrome.
 *
 * The viewport is a tall phone frame, but several of these screens (Settings,
 * an empty editor) only fill the top third of it — and a slide does not want
 * two thirds of dead background. So the frame is trimmed to the lowest visible
 * element, measured rather than guessed, and clamped to the viewport. Elements
 * pinned to the bottom (the FABs) are part of that measurement, so trimming
 * never crops an affordance away. Pass `{ trim: false }` to keep the full
 * frame.
 */
export async function still(
  page: Page,
  name: string,
  opts: { trim?: boolean } = {}
): Promise<void> {
  // Park the pointer and drop focus: whatever was last clicked otherwise keeps
  // a hover/focus state layer, which reads as a selected row in the still.
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(450);

  const out = path.join(DOCS_DIR, name);
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (opts.trim !== false) {
    const contentBottom = await page.evaluate(() => {
      let max = 0;
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
        if (r.bottom > max) max = r.bottom;
      }
      return Math.ceil(max);
    });
    const { width, height } = page.viewportSize()!;
    const trimmed = Math.min(height, Math.max(240, contentBottom + 12));
    if (trimmed < height - 8) clip = { x: 0, y: 0, width, height: trimmed };
  }

  await page.screenshot({ path: out, clip });
  console.log(`  ✓ docs/${name}${clip ? ` (trimmed to ${clip.height}px)` : ''}`);
}

/**
 * Set the display name friends (and the presence dots) see.
 *
 * Stored as a user-group contact rather than per device, so this also mints the
 * peer's user group — which sharing needs anyway. Driven through Settings →
 * Profile because `setFriendName` is not part of the worker API bridge.
 */
export async function setDisplayName(page: Page, name: string): Promise<void> {
  await page.goto('/#/settings/profile');
  const input = page.getByPlaceholder('Your name (optional)');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByText('Name saved.')).toBeVisible({ timeout: 30_000 });
}

/**
 * Name this device, the way Settings → Devices does.
 *
 * A device names itself by sniffing the user agent (`💻 Chrome`), which in a
 * capture means every device is labelled with whatever browser Playwright is
 * driving — the same for both panes of a two-device shot. Naming them
 * explicitly is what makes "this happened on the other device" legible.
 *
 * Driven through the UI because `setDeviceName` is not part of the worker API
 * bridge, the same gap `setDisplayName` works around for friend names.
 *
 * Call this BEFORE linking: the link rendezvous carries `resolveDeviceName()`
 * to the other device, so a name set afterwards never reaches it. The row
 * exists even on a device that has never linked — `listGroupDevices`
 * synthesizes the self row when there is no user group yet.
 */
export async function setDeviceName(peer: CapturePeer, name: string): Promise<string> {
  const { agentId } = await peer.call('getIdentity');
  await peer.page.goto('/#/settings/devices');
  const input = peer.page.getByTitle(agentId);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(name);
  await input.press('Enter');
  await waitFor(
    () => peer.call('getAllDeviceNames'),
    (names) => names[agentId] === name,
    { label: `${peer.name} is named ${name}`, timeout: 30_000 }
  );
  return agentId;
}

/**
 * Make two peers mutual contacts, as tests-pw/support/scenarios.ts does.
 * Splitting it out of `setupSharedDoc` lets the add-friend capture drive the
 * same exchange through the QR UI instead.
 */
export async function befriend(a: CapturePeer, b: CapturePeer): Promise<{ aGroup: string; bGroup: string }> {
  const aGroup = (await a.call('ensureUserGroup', { create: true })).userGroupId!;
  const bGroup = (await b.call('ensureUserGroup', { create: true })).userGroupId!;
  const [aCard, bCard] = [await a.call('getContactCard'), await b.call('getContactCard')];
  await a.call('receiveContactCard', bCard, { userGroupId: bGroup });
  await b.call('receiveContactCard', aCard, { userGroupId: aGroup });
  return { aGroup, bGroup };
}

/**
 * Wait until `peer`'s worker actually holds the document.
 *
 * Presence only works between peers whose workers have the doc loaded before
 * the editor mounts — opening the UI on a cold worker races the first
 * broadcast and the dots never appear. tests-pw/editor-presence.spec.ts warms
 * both peers the same way for the same reason.
 */
export async function warmDoc(peer: CapturePeer, docId: string, name: string): Promise<void> {
  await waitFor(
    () => peer.call('queryDoc', docId, '.name').then((r: any) => r.result).catch(() => null),
    (r) => r === name,
    { label: `${peer.name} loads ${name}`, timeout: 60_000 }
  );
}

/**
 * Give a contact a display name on this peer.
 *
 * `receiveContactCard` carries no name — a contact's name only travels over the
 * QR rendezvous exchange. So peers friended programmatically show up as a
 * truncated agent id, which looks like a bug in a screenshot. This renames them
 * through Friends → row → Rename, the same path a user would take.
 */
export async function nameContact(peer: CapturePeer, index: number, name: string): Promise<void> {
  peer.setPromptAnswer(name);
  await peer.page.goto('/#/friends');
  const rows = peer.page.getByTestId('friend-row');
  await expect(rows.nth(index)).toBeVisible({ timeout: 60_000 });
  await rows.nth(index).click();
  await peer.page.getByTestId('friend-rename').click();
  await expect(rows.filter({ hasText: name })).toBeVisible({ timeout: 30_000 });
}

/** Share `docId` from `owner` to `peerGroup`, retrying until the group's ops have synced. */
export async function share(
  owner: CapturePeer,
  recipient: CapturePeer,
  peerGroup: string,
  docId: string,
  role: 'read' | 'edit' | 'admin' = 'edit'
): Promise<void> {
  await waitFor(
    async () => {
      try {
        await owner.call('addMember', peerGroup, docId, role);
        return true;
      } catch (err) {
        if (/Agent not found/.test((err as Error).message)) return false;
        throw err;
      }
    },
    (ok) => ok === true,
    { label: `${owner.name} shares with ${recipient.name}`, timeout: 60_000, interval: 500 }
  );
  await waitFor(
    () => recipient.call('getMyAccess', docId),
    (access) => access?.toLowerCase() === role,
    { label: `${recipient.name} gains ${role} access`, timeout: 45_000 }
  );
}
