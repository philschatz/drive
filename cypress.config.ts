import { defineConfig } from 'cypress';
import codeCoverageTask from '@cypress/code-coverage/task';

const port = process.env.PORT || '3000';

export default defineConfig({
  e2e: {
    baseUrl: `http://localhost:${port}`,
    supportFile: 'cypress/support/e2e.ts',
    testIsolation: false,
    defaultCommandTimeout: 10000,
    setupNodeEvents(on, config) {
      codeCoverageTask(on, config);
      return config;
    },
  },
  env: {
    codeCoverage: {
      exclude: ['node_modules/**'],
    },
  },
  nyc: {
    'report-dir': 'coverage/cypress',
  },
});
