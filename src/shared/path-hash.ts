type Path = (string | number)[];

/** Encode a path array into a URL hash fragment. */
export function pathToHash(path: Path): string {
  if (path.length === 0) return '';
  return '#' + path.map(s => encodeURIComponent(String(s))).join('/');
}

/** Decode a URL hash fragment into a path array, or null if empty. */
export function hashToPath(hash: string): Path | null {
  if (!hash || hash === '#') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  return raw.split('/').map(s => {
    const decoded = decodeURIComponent(s);
    const n = Number(decoded);
    return !isNaN(n) && decoded.trim() !== '' ? n : decoded;
  });
}
