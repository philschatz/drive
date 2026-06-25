/**
 * CJS shim for @automerge/automerge-repo-keyhive in Jest.
 *
 * The real package is ESM and pulls in the full keyhive/automerge-repo tree
 * (blob-interceptor, network adapters, etc.) which Jest's CJS environment
 * can't load. The unit tests only need `initKeyhiveWasm`, and the keyhive
 * WASM is already initialized by tests/keyhive-shim.js (mapped from
 * @keyhive/keyhive/slim). So this exposes a no-op initKeyhiveWasm.
 */
module.exports.initKeyhiveWasm = function () {};
module.exports.isWasmInitialized = function () { return true; };
