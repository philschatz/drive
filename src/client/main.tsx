import 'temporal-polyfill/global';

import './globals.css';
import { render } from 'preact';
import { App } from './App';

// Dev-only: expose the worker API on window.__drive for Playwright peer tests.
// Stripped from production builds by Vite's dead-code elimination.
if (import.meta.env.DEV) {
  import('./test-bridge');
}

render(
  <App />,
  document.getElementById('app')!,
);
