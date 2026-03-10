process.env.AUTOMERGE_DATA_DIR = '.data-jest';

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
      roots: ['<rootDir>/src', '<rootDir>/tests'],
      testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
      testPathIgnorePatterns: ['<rootDir>/tests/ui/'],
      transform: {
        '^.+\\.ts$': 'ts-jest',
        '^(?!.*(?:setup|teardown)\\.js).+\\.js$': ['ts-jest', { useESM: false }],
      },
      transformIgnorePatterns: [
        'node_modules/(?!@automerge/)',
      ],
      moduleNameMapper: {
        '^@automerge/automerge/slim$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
        '^@automerge/automerge/slim/next$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
      },
    },
    // UI component tests (jsdom environment)
    {
      displayName: 'ui',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/tests/ui'],
      testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
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
              '@/*': ['./src/client/*'],
              'react': ['./node_modules/preact/compat/'],
              'react-dom': ['./node_modules/preact/compat/'],
            },
          },
        }],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/client/$1',
        '^@testing-library/preact$': '<rootDir>/node_modules/@testing-library/preact/dist/cjs/index.js',
        '^preact/jsx-runtime$': '<rootDir>/node_modules/preact/jsx-runtime/dist/jsxRuntime.js',
        '^preact/test-utils$': '<rootDir>/node_modules/preact/test-utils/dist/testUtils.js',
        '^preact/hooks$': '<rootDir>/node_modules/preact/hooks/dist/hooks.js',
        '^preact/compat$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        '^preact$': '<rootDir>/node_modules/preact/dist/preact.js',
        '^react$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        '^react-dom$': '<rootDir>/node_modules/preact/compat/dist/compat.js',
        '^react-dom/test-utils$': '<rootDir>/node_modules/preact/test-utils/dist/testUtils.js',
        '\\.css$': '<rootDir>/tests/ui/__mocks__/style.js',
      },
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage/jest',
  coverageReporters: ['json', 'text-summary'],
};
