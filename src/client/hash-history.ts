function getHashPath(): string {
  const hash = window.location.hash;
  return hash.startsWith('#') ? hash.slice(1) || '/' : '/';
}

export const hashHistory = {
  get location() {
    return { pathname: getHashPath(), search: '' };
  },
  listen(cb: (loc: { pathname: string; search: string }) => void) {
    const handler = () => cb({ pathname: getHashPath(), search: '' });
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
