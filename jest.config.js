process.env.AUTOMERGE_DATA_DIR = '.data-jest';
// App logging goes through src/shared/logger.ts. `error` silences the warn/info
// lines and the per-message firehoses that otherwise bury the output of
// `jest --verbose` (and of a single-file run, where Jest turns verbose on for
// you), while still letting an UNEXPECTED error through — a test that expects
// one claims it with captureConsole(['error']) (tests/support/console.ts).
//
// `??=`, not `=`, so `LOG_LEVEL=debug npx jest …` from the shell wins: that is
// the escape hatch when a failure needs the engine's own account of what
// happened. LOG_NS=engine:debug narrows it to one namespace. Workers inherit
// this env, and it covers both the `server` and `ui` projects.
process.env.LOG_LEVEL ??= 'error';

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    // Backend + shared logic tests (node environment)
    {
      displayName: 'server',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testTimeout: 15000,
      globalSetup: '<rootDir>/tests/setup.js',
      setupFiles: ['<rootDir>/tests/setup-subduction.js'],
      setupFilesAfterEnv: ['<rootDir>/tests/support/setup-console.ts'],
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      // Only *.test.ts — *.spec.ts is reserved for Playwright (src/client/tests-pw).
      testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(test).ts'],
      testPathIgnorePatterns: ['\\.test\\.tsx$', '/clipboard\\.test\\.ts$'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
        '^(?!.*(?:setup|teardown)\\.js).+\\.js$': ['ts-jest', { useESM: false, diagnostics: false }],
      },
      transformIgnorePatterns: [
        // uuid@14 (pulled in by automerge-repo subduction.37) ships ESM only,
        // so it must be transformed to CJS for the node/jest environment.
        'node_modules/(?!(@automerge/|@keyhive/|uuid/))',
      ],
      moduleNameMapper: {
        '^@automerge/automerge/slim$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
        '^@automerge/automerge/slim/next$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
        '^@automerge/automerge-repo/slim$': '<rootDir>/node_modules/@automerge/automerge-repo/dist/entrypoints/slim.js',
        '^@automerge/automerge-subduction$': '<rootDir>/node_modules/@automerge/automerge-subduction/dist/cjs/node.cjs',
        '^@automerge/automerge-repo-keyhive$': '<rootDir>/tests/repo-keyhive-shim.js',
        '^@keyhive/keyhive/slim$': '<rootDir>/tests/keyhive-shim.js',
        '^@keyhive/keyhive/keyhive_wasm\\.base64\\.js$': '<rootDir>/tests/keyhive-base64-shim.js',
      },
    },
    // UI component tests (jsdom environment)
    {
      displayName: 'ui',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      setupFilesAfterEnv: ['<rootDir>/tests/support/setup-console.ts'],
      roots: ['<rootDir>/src/client'],
      // Build-time constants Vite substitutes via `define` (see vite.config.ts).
      // Components that render them (Home's footer) would otherwise throw a bare
      // ReferenceError under jsdom.
      globals: {
        __APP_VERSION__: 'test',
        __BUILD_TIME__: '2026-01-01T00:00:00.000Z',
      },
      testMatch: ['**/?(*.)+(test).tsx', '**/clipboard.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          diagnostics: false,
          tsconfig: {
            jsx: 'react-jsx',
            jsxImportSource: 'preact',
            module: 'CommonJS',
            esModuleInterop: true,
            skipLibCheck: true,
            paths: {
              '@/*': ['./src/client/ui/*'],
              '@client/*': ['./src/client/*'],
              'react': ['./node_modules/preact/compat/'],
              'react-dom': ['./node_modules/preact/compat/'],
            },
          },
        }],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/client/ui/$1',
        '^@client/(.*)$': '<rootDir>/src/client/$1',
        '^@testing-library/preact$': '<rootDir>/node_modules/@testing-library/preact/dist/cjs/index.js',
        '^preact/jsx-runtime$': '<rootDir>/node_modules/preact/jsx-runtime/dist/jsxRuntime.js',
        '^preact/test-utils$': '<rootDir>/node_modules/preact/test-utils/dist/testUtils.js',
        '^preact/hooks$': '<rootDir>/node_modules/preact/hooks/dist/hooks.js',
        '^preact/compat$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        '^preact$': '<rootDir>/node_modules/preact/dist/preact.js',
        '^react$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        // Radix primitives compile to the automatic JSX runtime; route both the
        // prod and dev variants to Preact so Radix-based UI (Label/Select/…)
        // renders under jsdom instead of pulling in real React.
        '^react/jsx-runtime$': '<rootDir>/node_modules/preact/jsx-runtime/dist/jsxRuntime.js',
        '^react/jsx-dev-runtime$': '<rootDir>/node_modules/preact/jsx-runtime/dist/jsxRuntime.js',
        '^react-dom$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        '^react-dom/test-utils$': '<rootDir>/node_modules/preact/test-utils/dist/testUtils.js',
        '\\.css$': '<rootDir>/src/client/ui/__mocks__/style.js',
      },
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/**/*.d.ts',
    '!src/client/tests-pw/**',
  ],
  coverageDirectory: 'coverage/jest',
  coverageReporters: ['json', 'text-summary'],
};
