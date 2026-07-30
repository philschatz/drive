import 'temporal-polyfill/global';

import '../assets/globals.css';
// Register the @material/web (MD3) custom elements after globals.css so the
// `--md-sys-color-*` tokens they read are already defined.
import './md-elements';
import { render } from 'preact';
import { App } from './App';
import { getHashPath, hashHistory } from './hash-history';
import { settingGetSync } from '../shared/idb-storage';
import { startThemeSync } from './common/theme';
import { flushStorage } from './worker-api';

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

// Mirror the OS color scheme onto <html> before the first paint of any app
// content (#app is empty until the render below), so nothing flashes light.
startThemeSync();

// The repo runs in a dedicated worker and saves on a debounce, so edits from the
// last ~100ms are applied but not yet durable — and a reload or tab close
// terminates the worker mid-debounce. `visibilitychange → hidden` is the last
// event guaranteed to fire before a mobile tab is discarded (`beforeunload` and
// `pagehide` are not), so flush there. Fire-and-forget by necessity: a page being
// torn down cannot await a postMessage, and on a plain background/foreground the
// flush has all the time it needs.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushStorage().catch(() => {});
});

render(
  <App />,
  document.getElementById('app')!,
);
