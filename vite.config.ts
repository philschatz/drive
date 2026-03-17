import { defineConfig, Plugin } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { relayPlugin } from './src/backend/relay-plugin';

const automergeEntry = resolve(__dirname, 'node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js');

// Radix UI's Presence component calls getComputedStyle(node) in a ref callback,
// but under Preact's compat layer the ref value may not be a DOM Element.
// Match by code content (not path) because Vite pre-bundles deps into single files.
function radixPreactPatchPlugin(): Plugin {
  return {
    name: 'radix-preact-patch',
    transform(code) {
      if (code.includes('stylesRef.current = node2 ? getComputedStyle(node2) : null')) {
        return code.replace(
          'stylesRef.current = node2 ? getComputedStyle(node2) : null;',
          'stylesRef.current = (node2 instanceof Element) ? getComputedStyle(node2) : null;',
        );
      }
    },
  };
}

function automergeWasmPlugin(): Plugin {
  return {
    name: 'automerge-wasm-async',
    load(id) {
      if (id.includes('wasm_bindgen_output/web/index.js')) {
        // Load WASM as a separate asset (via ?url) instead of base64-inlining.
        // init() uses fetch() + WebAssembly.instantiateStreaming() for efficient
        // streaming compilation without buffering the entire binary in JS heap.
        return `
          import wasmUrl from "./automerge_wasm_bg.wasm?url";
          import init from "./automerge_wasm.js";
          await init(wasmUrl);
          export * from "./automerge_wasm.js";
        `;
      }
    },
  };
}

// The keyhive npm package uses wasm-bindgen's ESM integration:
//   import * as wasm from "./keyhive_wasm_bg.wasm";
// This requires the bundler to wire WASM imports from the bg.js glue code,
// which vite-plugin-wasm doesn't handle correctly in web workers.
// Instead, we fetch the WASM binary and instantiate it manually with the
// proper import object from the bg.js glue code.
function keyhiveWasmPlugin(): Plugin {
  return {
    name: 'keyhive-wasm',
    load(id) {
      if (id.includes('@keyhive/keyhive') && id.endsWith('keyhive_wasm.js')) {
        return `
          import wasmUrl from "./keyhive_wasm_bg.wasm?url";
          import * as bg from "./keyhive_wasm_bg.js";
          const imports = { "./keyhive_wasm_bg.js": bg };
          const wasmResponse = await fetch(wasmUrl);
          const { instance } = await WebAssembly.instantiateStreaming(wasmResponse, imports);
          bg.__wbg_set_wasm(instance.exports);
          instance.exports.__wbindgen_start();
          export {
            Access, Agent, Archive, CannotParseEd25519SigningKey, CannotParseIdentifier,
            Capability, CgkaOperation, ChangeId, CiphertextStore, ContactCard, Delegation,
            DocContentRefs, Document, DocumentId, Encrypted, EncryptedContentWithUpdate,
            Event, GenerateWebCryptoError, Group, GroupId, History, Identifier, Individual,
            IndividualId, Invocation, Keyhive, Membered, Membership, Peer, Revocation,
            ShareKey, Signed, SignedCgkaOperation, SignedDelegation, SignedInvocation,
            SignedRevocation, Signer, Stats, Summary, setPanicHook
          } from "./keyhive_wasm_bg.js";
        `;
      }
    },
  };
}

// Resolve @automerge/automerge-subduction to its "web" entrypoint which
// initializes WASM from a base64-encoded string via initSync().
// The default "browser/bundler" entrypoint uses `import * as wasm from ".wasm"`
// which vite-plugin-wasm doesn't handle correctly, leaving the WASM exports
// undefined at runtime.
const subductionEntry = resolve(__dirname, 'node_modules/@automerge/automerge-subduction/dist/esm/web.js');

export default defineConfig(async () => {
  const istanbulPlugins = process.env.CYPRESS_COVERAGE
    ? [(await import('vite-plugin-istanbul')).default({
        include: 'src/**/*',
        exclude: ['node_modules'],
        extension: ['.ts', '.tsx'],
      })]
    : [];

  const base = process.env.VITE_BASE_PATH || '/';

  return {
  base,
  plugins: [
    wasm(),
    preact(),
    tailwindcss(),
    relayPlugin(),
    radixPreactPatchPlugin(),
    automergeWasmPlugin(),
    keyhiveWasmPlugin(),
    ...istanbulPlugins,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'Automerge Drive',
        short_name: 'Drive',
        description: 'Collaborative documents with offline support',
        theme_color: '#4A90D9',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: `${base}pwa-192x192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}pwa-512x512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${base}pwa-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MB — WASM + worker bundle
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/health/,
          /^\/dav\//,
          /^\/automerge\//,
          /^\/docs\//,
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  root: 'src/client',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: 'es' as const,
    plugins: () => [wasm(), keyhiveWasmPlugin()],
  },
  resolve: {
    alias: {
      '@/': resolve(__dirname, 'src/client') + '/',
      '@automerge/automerge/slim': automergeEntry,
      '@automerge/automerge': automergeEntry,
      '@automerge/automerge-subduction': subductionEntry,
    },
    dedupe: ['preact', '@preact/signals', '@preact/signals-core'],
  },
  server: {
    fs: {
      allow: [resolve(__dirname)],
    },
    hmr: {
      port: Number(process.env.PORT || 3000) + 1,
    },
  },
  optimizeDeps: {
    include: ['@preact/signals', '@preact/signals-core', 'preact/hooks', 'preact/compat'],
    // Exclude automerge so the Vite automergeWasmPlugin load() hook can intercept
    // wasm_bindgen_output/web/index.js and replace base64 WASM with a URL fetch.
    // Pre-bundling bypasses load() hooks (esbuild doesn't use Vite plugins),
    // so without this exclusion the full 2.4 MB base64 string ends up in the
    // pre-bundled chunk and OOMs the Chromium renderer during dev-mode testing.
    exclude: ['@automerge/automerge', '@automerge/automerge-subduction', '@keyhive/keyhive'],
  },
  };
});
