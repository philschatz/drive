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
      #\${ID}.pw-down { transform: scale(.62); background: rgba(17,17,17,.55); }
      /* The press ripple. A 110ms mousedown is one frame at 8-10fps, so the
         pulse is a separate element with its own longer animation: the click
         stays legible even when the frame it happened on is dropped. */
      .pw-ripple {
        position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px;
        border-radius: 9999px; border: 2px solid rgba(17,17,17,.6);
        pointer-events: none; z-index: 2147483646;
        animation: pw-ripple 420ms ease-out forwards;
      }
      @keyframes pw-ripple {
        from { transform: scale(.5); opacity: .75; }
        to   { transform: scale(2.6); opacity: 0; }
      }
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
    addEventListener('mousedown', (e) => {
      move(e);
      dot.classList.add('pw-down');
      const ripple = document.createElement('div');
      ripple.className = 'pw-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top = e.clientY + 'px';
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);
    }, true);
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

/**
 * Glide to `target`, pause, then press-and-release so the cursor pulse is visible.
 *
 * The press is held for ~250ms, not the ~110ms a real click takes: at the 8–10fps
 * these GIFs encode at, a shorter press can fall entirely between two frames and
 * the UI then appears to change on its own.
 */
export async function tap(page: Page, target: Locator): Promise<void> {
  await glide(page, target);
  await beat(page, 220);
  await page.mouse.down();
  await beat(page, 250);
  await page.mouse.up();
  await beat(page, 120);
}

/**
 * Rest the pointer on a QR code, then flash the frame white — the beat a viewer
 * needs to register that *this* is the thing being scanned.
 *
 * Nothing in the app scans locally (the pairing goes over the rendezvous channel
 * behind the scenes), so without this the QR simply vanishes and is replaced by
 * the next screen, which reads as a glitch rather than a capture. The flash is a
 * painted overlay rather than anything the app knows about, and it is removed
 * again immediately.
 */
export async function scanFlash(page: Page, target: Locator, hold = 600): Promise<void> {
  await glide(page, target);
  await beat(page, hold);
  await page.evaluate(() => {
    const flash = document.createElement('div');
    flash.style.cssText =
      'position:fixed;inset:0;background:#fff;z-index:2147483646;pointer-events:none;' +
      'opacity:0;transition:opacity 90ms linear';
    document.body.appendChild(flash);
    requestAnimationFrame(() => {
      flash.style.opacity = '1';
      setTimeout(() => {
        flash.style.opacity = '0';
        setTimeout(() => flash.remove(), 260);
      }, 130);
    });
  });
  await beat(page, 520);
}

/** A viewport point, as `page.mouse` takes them. */
export interface Pt {
  x: number;
  y: number;
}

/**
 * Select a phrase of prose: double-click its first word, then shift-click the far
 * end. Both points are viewport coordinates — a phrase inside a paragraph is a run
 * of characters with no element of its own, so it has to be measured (see
 * `phraseGrips` in assets.capture.ts). The spreadsheet's equivalent selects
 * between two *cells*, which do have elements, so it stays local to
 * assets.capture.ts as `dragSelect`.
 *
 * Deliberately NOT a press-and-drag, which is the obvious way to film a selection
 * and does not survive a collaborator. A drag has no consistent selection while
 * the button is down, so a remote cursor push arriving mid-sweep makes the
 * editor's caret-restore effect re-apply the half-finished selection it last
 * recorded — that re-anchors the drag, and the rest of the sweep then extends from
 * the wrong end (measured: an anchor at offset 41 became 22 mid-move, selecting 19
 * characters that were never swept). Double-click and shift-click are each atomic,
 * and the state between them is a real selection, so a push landing at any point
 * restores exactly what is already there.
 *
 * Two gestures also read *better* at 8–10fps than a sweep whose intermediate
 * frames are mostly dropped: the word highlights, then the selection snaps out.
 */
export async function selectPhrase(page: Page, word: Pt, end: Pt): Promise<void> {
  await page.mouse.move(word.x, word.y, { steps: 12 });
  await beat(page, 260);
  await page.mouse.dblclick(word.x, word.y);
  await beat(page, 420);
  await page.mouse.move(end.x, end.y, { steps: 14 });
  await beat(page, 240);
  // Shift-click extends the selection. Aimed at the phrase's exact end edge,
  // which is right under both granularities Blink might keep from the
  // double-click: a character boundary, and the last word's own edge.
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await beat(page, 200);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await beat(page, 260);
}

/**
 * Fade the synthetic pointer out, for beats where the hand is not the story.
 *
 * Typing is the case that needs it: the ring is 26px of opaque grey, and left
 * wherever the last gesture ended it sits on top of the very characters being
 * typed. A real hand has left the mouse by then, so drawing one is both ugly and
 * a lie.
 *
 * Self-restoring — the overlay adds `pw-visible` back on the next real
 * `mousemove`, so any following `tap`/`glide` fades it in again as it travels.
 */
export async function hideCursor(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('pw-cursor')?.classList.remove('pw-visible'));
  // Let the overlay's own 150ms opacity transition finish before anything moves.
  await beat(page, 220);
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
