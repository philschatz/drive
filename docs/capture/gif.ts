import { execFile } from 'child_process';
import { statSync } from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** Where finished assets land: the docs/ directory `npm run slides` copies from. */
export const DOCS_DIR = path.resolve(__dirname, '..');

/** A recorded take: the raw .webm plus the interesting window inside it. */
export interface Clip {
  /** Path to the page's recorded video. */
  video: string;
  /** Seconds into the recording where the interesting part starts. */
  start: number;
  /** Seconds into the recording where it ends. */
  end: number;
}

/**
 * Frames identical to their predecessor are dropped and their timestamps kept
 * (`-fps_mode vfr`), so a held frame becomes one long frame instead of eight copies.
 *
 * `frac` is well below mpdecimate's default 0.33 on purpose: the whole point of
 * `cursor.ts` is that a viewer can follow the pointer, and at the default a frame
 * where only the 26px ring moved is "similar enough" to drop — which turns travel
 * into teleporting. At 0.05 a frame survives if 5% of its blocks changed, which the
 * ring clears and a genuinely static hold does not.
 */
const DECIMATE = 'mpdecimate=frac=0.05';

/**
 * The GIF encode. `palettegen`/`paletteuse` in one pass (via `split`) gives a
 * per-clip optimal palette instead of the generic web palette — without it, the
 * app's greys band badly. `stats_mode=diff` weights it toward the pixels that
 * actually change, which is nearly all UI text.
 *
 * `dither=none` because the source is flat UI colour, not photography: there is
 * nothing for dithering to smooth, and the noise it adds both softens text and
 * defeats the GIF's run-length compression.
 */
const paletteChain = (
  fps: number,
  opts: { maxColors?: number; decimate?: boolean } = {}
) => {
  const gen = `palettegen=stats_mode=diff${opts.maxColors ? `:max_colors=${opts.maxColors}` : ''}`;
  // `diff_mode=rectangle` confines each frame to the rectangle that actually
  // changed, which is what lets a decimated clip's held frames cost nothing.
  const use = `paletteuse=dither=none${opts.decimate ? ':diff_mode=rectangle' : ''}`;
  return `fps=${fps}${opts.decimate ? `,${DECIMATE}` : ''},split[pg][pu];[pg]${gen}[p];[pu][p]${use}`;
};

/**
 * Seconds the opening frame is held before anything moves.
 *
 * These loop forever with no controls, so a viewer arrives mid-cycle and has to
 * work out what they are looking at while it is already animating. Freezing the
 * first frame gives them a beat to read the screen — and because the hold is at
 * the head, it also reads as the loop's start rather than an arbitrary cut.
 * `stop_mode=clone` already holds the *last* frame in hstackGif for a different
 * reason (pane length matching); this is the mirror of it at the front.
 */
const LEAD_IN = 1.8;

const leadIn = (seconds = LEAD_IN) => `tpad=start_mode=clone:start_duration=${seconds}`;

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    throw new Error(`ffmpeg failed:\n${err.stderr || err.message}`);
  }
}

/** Roughly the size of the largest asset the deck shipped before; past it, shorten the clip. */
const SIZE_WARN_KB = 2200;

/**
 * Palette size every asset is encoded with.
 *
 * Fewer distinct symbols for LZW to code, and flat UI colour has nothing like 256 of
 * them. Measured on `tour.gif`, the deck's worst case (36s over five screens, one of
 * them a dense spreadsheet): 256 colours 5.0 MB, 128 colours 3.9 MB, 64 colours
 * 3.0 MB — with no visible loss on text, on the spreadsheet's fills, or on the
 * 25%-opacity peer tints and 10px name tips the presence assets exist to show.
 * Raise it per-asset if something ever does band.
 */
const DEFAULT_MAX_COLORS = 64;

function report(name: string, outPath: string): void {
  const kb = Math.round(statSync(outPath).size / 1024);
  console.log(`  ✓ docs/${name} (${kb} KB)`);
  if (kb > SIZE_WARN_KB) {
    console.warn(`  ! docs/${name} is ${kb} KB — consider trimming the flow or dropping fps`);
  }
}

/**
 * Encode one recorded take to docs/<name>.
 *
 * `maxColors` and `decimate` are the two levers that actually move the size of a
 * *long* clip, measured on `tour.gif` (36s across five different screens, which no
 * amount of fps trimming would fix — 8fps 5.6 MB, 6fps 5.0 MB):
 *
 * - **`maxColors`** is the big one. A smaller palette means fewer distinct symbols
 *   for LZW to code, and flat UI colour has nothing like 256 of them: 128 took it to
 *   3.9 MB and 64 to 3.0 MB with no visible loss on either text or the
 *   spreadsheet's fills. Reach for this before fps.
 * - **`decimate`** drops frames identical to their predecessor and keeps their
 *   timestamps (`-fps_mode vfr`), so a held frame becomes one long frame instead of
 *   eight copies — worth ~11% on a clip that pauses, and it preserves duration
 *   (measured 37.7s against 38.5s). Pointless on a clip that never holds still.
 *
 * Both are on by default for every asset — see DEFAULT_MAX_COLORS.
 */
export async function toGif(
  name: string,
  clip: Clip,
  opts: { fps?: number; maxColors?: number; decimate?: boolean } = {}
): Promise<void> {
  const { fps = 10, maxColors = DEFAULT_MAX_COLORS, decimate = true } = opts;
  const out = path.join(DOCS_DIR, name);
  await ffmpeg([
    // -ss before -i seeks the input, which is both faster and frame-accurate
    // enough here since the recordings are all-keyframe VP8.
    '-ss', clip.start.toFixed(2),
    '-to', clip.end.toFixed(2),
    '-i', clip.video,
    '-vf', `${leadIn()},${paletteChain(fps, { maxColors, decimate })}`,
    ...(decimate ? ['-fps_mode', 'vfr'] : []),
    '-loop', '0',
    out,
  ]);
  report(name, out);
}

/**
 * Encode two takes side by side — the shape the two-peer GIFs need, and how the
 * originals were captured (two browser windows next to each other).
 *
 * The two clips are never the same length, and `hstack` stops at the shorter
 * input, which would cut the longer peer's story short. `tpad=stop_mode=clone`
 * freezes each pane's last frame so both run to the length of the longer one;
 * `-t` then trims the (now equal-length, padded) result back to that length.
 *
 * The lead-in is applied to the stacked result rather than per pane, so both
 * panes hold the same opening frame, and `-t` allows for it — trimming to the
 * clip length alone would cut exactly the hold back off again.
 */
export async function hstackGif(
  name: string,
  left: Clip,
  right: Clip,
  opts: { fps?: number; width?: number; maxColors?: number; decimate?: boolean } = {}
): Promise<void> {
  const { fps = 10, width, maxColors = DEFAULT_MAX_COLORS, decimate = true } = opts;
  const out = path.join(DOCS_DIR, name);
  const leftDur = left.end - left.start;
  const rightDur = right.end - right.start;
  const total = Math.max(leftDur, rightDur);
  const pad = Math.ceil(Math.abs(leftDur - rightDur)) + 1;
  // Downscale after the stack, before the palette, so the palette is generated
  // from the pixels actually being written.
  //
  // Do not reach for this to save bytes: it usually costs them. Lanczos turns
  // crisp UI text into anti-aliased gradients, which a GIF cannot compress —
  // add-and-share-with-friend.gif measured 1.3 MB → 2.7 MB at width: 720. The
  // three assets still passing it were never re-measured against that finding.
  const resize = width ? `scale=${width}:-1:flags=lanczos,` : '';

  await ffmpeg([
    '-ss', left.start.toFixed(2), '-to', left.end.toFixed(2), '-i', left.video,
    '-ss', right.start.toFixed(2), '-to', right.end.toFixed(2), '-i', right.video,
    '-filter_complex',
    `[0:v]tpad=stop_mode=clone:stop_duration=${pad},pad=iw+4:ih:0:0:color=#c8c8c8[l];` +
      `[1:v]tpad=stop_mode=clone:stop_duration=${pad}[r];` +
      `[l][r]hstack=inputs=2,${leadIn()},${resize}${paletteChain(fps, { maxColors, decimate })}`,
    '-t', (total + LEAD_IN).toFixed(2),
    ...(decimate ? ['-fps_mode', 'vfr'] : []),
    '-loop', '0',
    out,
  ]);
  report(name, out);
}
