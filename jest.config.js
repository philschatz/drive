process.env.AUTOMERGE_DATA_DIR = '.data-jest';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 15000,
  globalSetup: '<rootDir>/tests/setup.js',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^(?!.*(?:setup|teardown)\\.js).+\\.js$': ['ts-jest', { useESM: false }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!@automerge/)',
  ],
  moduleNameMapper: {
    // Map the slim build to the fullfat CJS version which has WASM pre-initialized
    '^@automerge/automerge/slim$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
    '^@automerge/automerge/slim/next$': '<rootDir>/node_modules/@automerge/automerge/dist/cjs/fullfat_node.cjs',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage/jest',
  coverageReporters: ['json', 'text-summary'],
};
