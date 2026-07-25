import 'temporal-polyfill/global';

import './globals.css';
// Register the @material/web (MD3) custom elements after globals.css so the
// `--md-sys-color-*` tokens they read are already defined.
import './md-elements';
import { render } from 'preact';
import { App } from './App';
import { getHashPath, hashHistory } from './hash-history';
import { settingGetSync } from './idb-storage';

// Expose the worker API on window.__drive for Playwright peer tests. Included in
// all builds (not just dev) so the suite can run against a production build too.
import './test-bridge';

// Cold launch from the installed PWA (its start_url carries `?source=pwa`; a
// hash can't be used there) → reopen the last doc the user had open. A plain
// visit to the base URL has no marker and stays on Home, so deliberately going
// Home is never hijacked back into a document. Only fires before first render.
if (getHashPath() === '/') {
  const params = new URLSearchParams(window.location.search);
  if (params.get('source') === 'pwa') {
    const lastDoc = settingGetSync('last-opened-doc');
    if (lastDoc) hashHistory.replace(lastDoc);
    // Drop the marker so it doesn't linger in the address bar or get bookmarked.
    params.delete('source');
    const search = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (search ? '?' + search : '') + window.location.hash);
  }
}

render(
  <App />,
  document.getElementById('app')!,
);
