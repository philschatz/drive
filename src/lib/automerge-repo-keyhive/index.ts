// Forked from @automerge/automerge-repo-keyhive v0.1.0-alpha.17x
// with CGKA encryption wired up.
//
// WASM initialization is handled by the original package — this fork
// only re-exports the bridge layer with encryption hooks.

import { initFromBase64Wasm } from "@keyhive/keyhive/slim";
// @ts-expect-error
import { wasmBase64 } from "@keyhive/keyhive/keyhive_wasm.base64.js";

export const MODULE_INSTANCE_ID = Math.random().toString(36).slice(2);

let wasmInitialized = false;

export function initKeyhiveWasm(): void {
  if (wasmInitialized) {
    return;
  }
  wasmInitialized = true;
  try {
    initFromBase64Wasm(wasmBase64);
  } catch (e) {
    // In Vite builds, keyhiveWasmPlugin replaces keyhive_wasm.js with an async-fetch
    // module that does NOT export initSync. The plugin's top-level await already
    // initialized WASM before this function runs, so this error is safe to ignore.
  }
}

export function isWasmInitialized(): boolean {
  return wasmInitialized;
}

export type { Active } from "./keyhive/active";
export { KeyhiveEventEmitter } from "./keyhive/emitter";
export { AutomergeRepoKeyhive } from "./keyhive/automerge-repo-keyhive"
export {
  docIdFromAutomergeUrl,
  initializeAutomergeRepoKeyhive,
  KeyhiveStorage,
} from "./keyhive/keyhive";
export { KeyhiveNetworkAdapter } from "./network-adapter/network-adapter";
export type { SyncServer } from "./sync-server";
export {
  peerIdFromSigner,
  uint8ArrayToHex,
  verifyingKeyPeerIdWithoutSuffix,
} from "./utilities";

// Re-export all keyhive types
export * from "@keyhive/keyhive/slim";
