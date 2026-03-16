import { defineConfig } from 'cypress';
import codeCoverageTask from '@cypress/code-coverage/task';

const port = process.env.PORT || '3000';

export default defineConfig({
  e2e: {
    baseUrl: `http://localhost:${port}`,
    supportFile: 'cypress/support/e2e.ts',
    testIsolation: false,
    defaultCommandTimeout: 10000,
    experimentalMemoryManagement: true,
    numTestsKeptInMemory: 0,
    specPattern: ['cypress/e2e/datagrid.cy.ts', 'cypress/e2e/calendar.cy.ts'],
    setupNodeEvents(on, config) {
      codeCoverageTask(on, config);
      on('task', {
        log(message: string) {
          console.log(message);
          return null;
        },
      });
      on('before:browser:launch', (browser, launchOptions) => {
        // The combined automerge + keyhive WASM modules exceed the default
        // renderer heap limit (~4 GB). Raise it to prevent OOM crashes.
        if (browser.family === 'chromium') {
          launchOptions.args.push('--js-flags=--max-old-space-size=8192');
        }
        return launchOptions;
      });
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
