/**
 * Node equivalent of vite.config.ts's `keyhiveWasmPlugin`.
 *
 * The keyhive bridge's blob-interceptor imports `symmetricEncrypt` /
 * `symmetricDecrypt` from `@keyhive/keyhive/slim`, but the slim build does not
 * export them (that Rust blob-interceptor path is unused in this build). In the
 * browser, the Vite plugin appends throwing stubs at transform time; in Node we
 * append the same stubs to the on-disk module so the ESM named imports resolve.
 *
 * Idempotent, and safe for the browser build too (the Vite plugin only appends
 * when the exports are absent, so a pre-patched file is a no-op there). MUST run
 * before the keyhive bridge is first imported.
 */
import * as fs from 'fs';
import * as path from 'path';

const STUBS =
  '\nexport function symmetricEncrypt(){throw new Error("symmetricEncrypt unavailable in this keyhive build (Rust blob-interceptor path unused)");}' +
  '\nexport function symmetricDecrypt(){throw new Error("symmetricDecrypt unavailable in this keyhive build (Rust blob-interceptor path unused)");}\n';

function resolveSlimIndex(): string | null {
  const candidates = [
    path.join(process.cwd(), 'node_modules/@keyhive/keyhive/pkg-slim/index.js'),
    path.resolve(__dirname, '../../node_modules/@keyhive/keyhive/pkg-slim/index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Initialize the subduction WASM for Node via a *real* ESM dynamic import.
 *
 * `new Repo()` calls into `@automerge/automerge-subduction/slim`, whose WASM must
 * be initialized first. The subduction `.` export auto-inits under the `node`
 * condition (`esm/node.js` does `initSync({ module: readFileSync(...wasm) })`),
 * and the `/slim` entry the Repo uses shares that instance. But under the backend's
 * `module: commonjs`, a plain `await import(...)` is downleveled to `require`,
 * which inits the *CJS* instance — a different module object than the ESM one the
 * ESM-loaded Repo uses, leaving the Repo's instance uninitialized.
 *
 * `new Function('s', 'return import(s)')` forces a native ESM import that Node
 * resolves with the `node`+`import` conditions, initializing the ESM instance.
 * (createKeyhiveRepo also imports it the ordinary way, covering the CJS instance,
 * so whichever the Repo ends up using is initialized.) Must run before new Repo().
 */
export async function initSubductionNode(): Promise<void> {
  const nativeImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
  await nativeImport('@automerge/automerge-subduction');
}

let applied = false;

export function ensureKeyhiveNodeShim(): void {
  if (applied) return;
  applied = true;
  const file = resolveSlimIndex();
  if (!file) {
    console.warn('[keyhive-shim] @keyhive/keyhive/pkg-slim/index.js not found; skipping symmetric* stubs');
    return;
  }
  const code = fs.readFileSync(file, 'utf8');
  if (/export\s+(?:function|const)\s+symmetricEncrypt/.test(code)) return; // already present
  fs.appendFileSync(file, STUBS);
  console.log('[keyhive-shim] added symmetricEncrypt/symmetricDecrypt stubs to keyhive slim build');
}
