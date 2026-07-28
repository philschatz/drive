/**
 * Renders every `docs/*.mmd` to a same-named transparent PNG for the deck.
 *
 * Marp cannot render a mermaid fence — `npm run slides` is plain marp-cli with no
 * plugin, and there is no maintained Marp mermaid plugin — so the diagrams are
 * pre-rendered images like every other asset in docs/.
 *
 * Deliberately NOT @mermaid-js/mermaid-cli: v11 lists `puppeteer` as a peer
 * dependency, whose install downloads a Chromium that will not run on NixOS.
 * Instead this drives the same system Chromium the Playwright configs use, with
 * mermaid's self-contained `dist/mermaid.min.js` injected into a blank page —
 * so the only new dependency is the pure-JS `mermaid` package, and this works
 * offline.
 *
 * Usage:
 *   npm run docs:diagrams                 # all of docs/*.mmd
 *   npm run docs:diagrams -- add-device   # just the ones matching a substring
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DOCS, '..');

// Same resolution as playwright.config.ts / docs/capture/playwright.config.ts: the
// NixOS system Chromium, falling back to Playwright's own bundle (CI) when absent.
const chromiumPath = process.env.CHROMIUM_BIN || '/run/current-system/sw/bin/chromium';
const executablePath = existsSync(chromiumPath) ? chromiumPath : undefined;

/**
 * Palette lifted from docs/slides-theme.css so a diagram reads as part of the
 * deck rather than as default-mermaid purple. The PNG is transparent, so the
 * slide's own gradient shows through and no background colour is set here.
 */
const themeVariables = {
  primaryColor: '#f6f7fd',
  primaryTextColor: '#191c20',
  primaryBorderColor: '#415f91',
  lineColor: '#43474e',
  textColor: '#191c20',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontSize: '16px',
  // sequenceDiagram-specific
  actorBkg: '#e2e5f0',
  actorBorder: '#415f91',
  actorTextColor: '#415f91',
  actorLineColor: '#c4c6d0',
  signalColor: '#43474e',
  signalTextColor: '#191c20',
  labelBoxBkgColor: '#415f91',
  labelBoxBorderColor: '#415f91',
  labelTextColor: '#ffffff',
  loopTextColor: '#43474e',
  noteBkgColor: '#415f91',
  noteBorderColor: '#415f91',
  noteTextColor: '#ffffff',
  activationBkgColor: '#c4c6d0',
  activationBorderColor: '#415f91',
  sequenceNumberColor: '#ffffff',
};

/**
 * Height is what binds a diagram scaled onto a 16:9 slide — the width is never
 * the constraint — so apparent text size is roughly `slideHeight / rowCount`,
 * whatever the font size. Hence `mirrorActors: false`, which drops the duplicate
 * participant boxes at the bottom and buys back a whole row's worth of height.
 */
const sequence = {
  mirrorActors: false,
  useMaxWidth: false,
  actorMargin: 130,
  messageMargin: 40,
  boxMargin: 8,
};

const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const sources = readdirSync(DOCS)
  .filter((f) => f.endsWith('.mmd'))
  .filter((f) => filter.length === 0 || filter.some((needle) => f.includes(needle)))
  .sort();

if (sources.length === 0) {
  console.error(
    filter.length ? `No docs/*.mmd matching ${filter.join(', ')}` : 'No docs/*.mmd found',
  );
  process.exit(1);
}

const mermaidJs = readFileSync(path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
// A big viewport so a tall diagram is never clipped before the SVG is measured;
// scale 3 keeps the text crisp when Marp scales the PNG onto a 1280x720 slide.
const page = await browser.newPage({ viewport: { width: 1600, height: 1600 }, deviceScaleFactor: 3 });
// The host hugs the SVG (inline-block) and pads it: with `mirrorActors: false` the
// lifelines stop at the last message, so screenshotting the bare SVG leaves the final
// arrowhead flush against the edge. The padding is transparent, like the rest.
await page.setContent(
  '<body style="margin:0"><div id="out" style="display:inline-block;padding:14px"></div></body>',
);
await page.addScriptTag({ content: mermaidJs });

let failed = 0;
for (const file of sources) {
  const src = readFileSync(path.join(DOCS, file), 'utf8');
  const out = file.replace(/\.mmd$/, '.png');
  const result = await page.evaluate(
    async ([definition, themeVars, sequenceCfg]) => {
      // eslint-disable-next-line no-undef
      const mermaid = window.mermaid;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: themeVars,
        sequence: sequenceCfg,
      });
      const host = document.getElementById('out');
      host.innerHTML = '';
      try {
        const { svg } = await mermaid.render(`d${Date.now()}`, definition, host);
        host.innerHTML = svg;
        // Mermaid sizes the SVG to 100% width by default; pin it to its own
        // viewBox so the element screenshot is the diagram, not the viewport.
        const el = host.querySelector('svg');
        const [, , w, h] = el.getAttribute('viewBox').split(/\s+/).map(Number);
        el.setAttribute('width', String(w));
        el.setAttribute('height', String(h));
        el.style.maxWidth = 'none';
        return { ok: true, w, h };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    },
    [src, themeVariables, sequence],
  );

  if (!result.ok) {
    console.error(`✗ ${file}\n  ${result.error}`);
    failed++;
    continue;
  }
  await page.locator('#out').screenshot({
    path: path.join(DOCS, out),
    omitBackground: true,
  });
  // CSS pixels, not the file's pixels (which are 3x that plus the padding). This is
  // the number that matters: the slide scales by height, so height/rowCount is what
  // decides whether the text survives a projector.
  console.log(`✓ ${out}  ${Math.round(result.w)}x${Math.round(result.h)} css @3x`);
}

await browser.close();
// A mermaid typo must not be a silent no-op — the deck would keep showing a
// stale PNG that looks perfectly fine.
process.exit(failed ? 1 : 0);
