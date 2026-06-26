import 'temporal-polyfill/global';

import './globals.css';
import { render } from 'preact';
import { App } from './App';

// Expose the worker API on window.__drive for Playwright peer tests. Included in
// all builds (not just dev) so the suite can run against a production build too.
import './test-bridge';

render(
  <App />,
  document.getElementById('app')!,
);
