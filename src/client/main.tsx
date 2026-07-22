import 'temporal-polyfill/global';

import './globals.css';
import { render } from 'preact';
import { App } from './App';
import { getHashPath, hashHistory } from './hash-history';
import { settingGetSync } from './idb-storage';

// Expose the worker API on window.__drive for Playwright peer tests. Included in
// all builds (not just dev) so the suite can run against a production build too.
import './test-bridge';

// Cold launch on the bare base URL (e.g. PWA start_url, which cannot carry a
// hash) → reopen the last doc the user had open. Only fires before first render,
// so navigating to Home afterwards behaves normally.
if (getHashPath() === '/') {
  const lastDoc = settingGetSync('last-opened-doc');
  if (lastDoc) hashHistory.replace(lastDoc);
}

render(
  <App />,
  document.getElementById('app')!,
);
