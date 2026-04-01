function getHashPath(): string {
  const hash = window.location.hash;
  const full = hash.startsWith('#') ? hash.slice(1) || '/' : '/';
  return full.split('?')[0];
}

function getHashSearch(): string {
  const hash = window.location.hash;
  const full = hash.startsWith('#') ? hash.slice(1) : '';
  const q = full.indexOf('?');
  return q >= 0 ? full.slice(q) : '';
}

export const hashHistory = {
  get location() {
    return { pathname: getHashPath(), search: getHashSearch() };
  },
  listen(cb: (loc: { pathname: string; search: string }) => void) {
    const handler = () => cb({ pathname: getHashPath(), search: getHashSearch() });
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  },
  push(path: string) {
    window.location.hash = path;
  },
  replace(path: string) {
    window.history.replaceState(null, '', window.location.href.split('#')[0] + '#' + path);
  },
};
