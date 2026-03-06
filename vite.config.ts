import { defineConfig, Plugin } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

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

export default defineConfig(async () => {
  const istanbulPlugins = process.env.CYPRESS_COVERAGE
    ? [(await import('vite-plugin-istanbul')).default({
        include: 'src/**/*',
        exclude: ['node_modules'],
        extension: ['.ts', '.tsx'],
      })]
    : [];

  return {
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [
    preact(),
    tailwindcss(),
    radixPreactPatchPlugin(),
    automergeWasmPlugin(),
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
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
        enabled: true,
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
  },
  resolve: {
    alias: {
      '@/': resolve(__dirname, 'src/client') + '/',
      '@automerge/automerge/slim': automergeEntry,
      '@automerge/automerge': automergeEntry,
    },
    dedupe: ['preact', '@preact/signals', '@preact/signals-core'],
  },
  optimizeDeps: {
    include: ['@preact/signals', '@preact/signals-core', 'preact/hooks', 'preact/compat'],
    // Exclude automerge so the Vite automergeWasmPlugin load() hook can intercept
    // wasm_bindgen_output/web/index.js and replace base64 WASM with a URL fetch.
    // Pre-bundling bypasses load() hooks (esbuild doesn't use Vite plugins),
    // so without this exclusion the full 2.4 MB base64 string ends up in the
    // pre-bundled chunk and OOMs the Chromium renderer during dev-mode testing.
    exclude: ['@automerge/automerge'],
  },
  };
});
