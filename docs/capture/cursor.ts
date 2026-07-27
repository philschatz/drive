import type { Locator, Page } from '@playwright/test';

/**
 * A synthetic pointer for the screencasts.
 *
 * Playwright's video recording does not draw the mouse cursor, so a raw
 * recording looks like the UI operating itself — sheets open, text appears, and
 * nothing explains why. This injects a small ring that follows real pointer
 * events and pulses on press, so a viewer can see what is being tapped.
 *
 * It tracks genuine `mousemove`/`mousedown` events rather than being positioned
 * by the test, so it stays honest: it can only be somewhere the real pointer
 * went. Drive it with `tap()` / `glide()` below (or any `page.mouse.*` call) —
 * `locator.click()` teleports the pointer and produces no visible travel.
 */
const CURSOR_SCRIPT = `
(() => {
  const ID = 'pw-cursor';
  if (document.getElementById(ID)) return;

  const install = () => {
    if (document.getElementById(ID)) return;
    const style = document.createElement('style');
    style.textContent = \`
      #\${ID} {
        position: fixed; left: 0; top: 0; width: 26px; height: 26px;
        margin: -13px 0 0 -13px; border-radius: 9999px;
        border: 2px solid rgba(17,17,17,.75);
        background: rgba(17,17,17,.16);
        box-shadow: 0 1px 4px rgba(0,0,0,.35);
        pointer-events: none; z-index: 2147483647;
        opacity: 0; transition: opacity .15s linear, transform .08s ease-out;
        will-change: transform;
      }
      #\${ID}.pw-visible { opacity: 1; }
      #\${ID}.pw-down { transform: scale(.62); background: rgba(17,17,17,.42); }
    \`;
    document.head.appendChild(style);

    const dot = document.createElement('div');
    dot.id = ID;
    document.body.appendChild(dot);

    let x = 0, y = 0, raf = 0;
    const paint = () => { raf = 0; dot.style.left = x + 'px'; dot.style.top = y + 'px'; };
    const move = (e) => {
      x = e.clientX; y = e.clientY;
      dot.classList.add('pw-visible');
      if (!raf) raf = requestAnimationFrame(paint);
    };
    // Capture phase so overlays that stopPropagation() still move the cursor.
    addEventListener('mousemove', move, true);
    addEventListener('mousedown', (e) => { move(e); dot.classList.add('pw-down'); }, true);
    addEventListener('mouseup', () => dot.classList.remove('pw-down'), true);
  };

  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
})();
`;

/** Inject the cursor overlay into every navigation of this page's context. */
export async function installCursor(page: Page): Promise<void> {
  await page.addInitScript(CURSOR_SCRIPT);
  // addInitScript only affects future navigations; cover the current document too.
  await page.evaluate(CURSOR_SCRIPT).catch(() => {});
}

/** Human-ish pause. Every capture step goes through these so clips read evenly. */
export const beat = (page: Page, ms = 420) => page.waitForTimeout(ms);

/**
 * Move the pointer to the centre of `target` with visible travel, without clicking.
 *
 * The move is always routed via an offset point rather than going straight to
 * the destination. Two reasons: it arcs, which looks like a hand rather than a
 * teleport; and it guarantees genuine movement. Consecutive taps at the same
 * screen position — a title-bar button, then the same corner of the next
 * screen after an SPA route change — otherwise leave Chromium's hit-test target
 * pointing at the element that used to be there, and the click lands on nothing.
 */
export async function glide(page: Page, target: Locator, steps = 18): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`glide: ${target} has no bounding box (not visible?)`);
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const { width, height } = page.viewportSize()!;
  // Approach from inside the viewport, so the waypoint is always hit-testable.
  const wx = Math.min(Math.max(x - 60, 4), width - 4);
  const wy = Math.min(Math.max(y + 90, 4), height - 4);
  await page.mouse.move(wx, wy, { steps: Math.max(4, Math.round(steps / 2)) });
  await page.mouse.move(x, y, { steps });
}

/** Glide to `target`, pause, then press-and-release so the cursor pulse is visible. */
export async function tap(page: Page, target: Locator): Promise<void> {
  await glide(page, target);
  await beat(page, 220);
  await page.mouse.down();
  await beat(page, 110);
  await page.mouse.up();
}

/** Type into the focused element at a readable, human cadence. */
export async function type(page: Page, text: string, delay = 55): Promise<void> {
  await page.keyboard.type(text, { delay });
}

/** Tap an empty field, then type into it — the usual "fill this in" beat. */
export async function tapAndType(page: Page, target: Locator, text: string): Promise<void> {
  await tap(page, target);
  await beat(page, 200);
  await type(page, text);
}

/**
 * Tap a field that already has content, select all of it, and type over the top.
 * Tapping only places a caret, so typing into e.g. the "Untitled" document title
 * interleaves with what is there instead of replacing it.
 */
export async function tapAndReplace(page: Page, target: Locator, text: string): Promise<void> {
  await tap(page, target);
  await beat(page, 200);
  await page.keyboard.press('ControlOrMeta+a');
  await beat(page, 150);
  await type(page, text);
}
