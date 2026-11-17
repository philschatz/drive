/**
 * Node-only WASM bootstrap for the headless hosts (CLI, CalDAV bridge).
 *
 * keyhive needs nothing here: the bridge initialises its WASM from the
 * package's own base64 build (`initKeyhiveWasm`). Only subduction does.
 */

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
