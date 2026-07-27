/**
 * Central builders for document URLs. All doc URLs are hash-based and type-free:
 * `#/d/<docId>[/<rest>]` — the document's `@type` selects the view (see DocRoute),
 * never the URL. `<rest>` is the plugin-specific deep-link remainder
 * (e.g. `events/<uid>`, `tasks/<uid>`, `sheets/<sid>`).
 *
 * Transient selection state is deliberately absent: nothing mirrors the focused
 * field into the hash, so `<rest>` only ever holds real navigation.
 */

export const DOC_ROUTE_PREFIX = '/d';

/** Router-relative path for a document, e.g. `/d/<id>/events/<uid>`. */
export function docPath(docId: string, rest?: string): string {
  return `${DOC_ROUTE_PREFIX}/${docId}${rest ? `/${rest}` : ''}`;
}

/** Href for a document, e.g. `#/d/<id>`. */
export function docUrl(docId: string, rest?: string): string {
  return `#${docPath(docId, rest)}`;
}

/** Router-relative path for a document's sharing screen, e.g. `/d/<id>/share`. */
export function sharePath(docId: string): string {
  return docPath(docId, 'share');
}

/** Href for a document's sharing screen, e.g. `#/d/<id>/share`. */
export function shareUrl(docId: string): string {
  return `#${sharePath(docId)}`;
}

/** Encode a focus path (array of keys) as a `rest` string. */
export function encodeRestPath(path: (string | number)[]): string {
  return path.map(seg => encodeURIComponent(String(seg))).join('/');
}

/** Router-relative path for the source inspector, e.g. `/source/<id>/events/<uid>/title`. */
export function sourcePath(docId: string, path?: (string | number)[]): string {
  return `/source/${docId}${path && path.length ? `/${encodeRestPath(path)}` : ''}`;
}

/** Href for the source inspector, e.g. `#/source/<id>`. */
export function sourceUrl(docId: string, path?: (string | number)[]): string {
  return `#${sourcePath(docId, path)}`;
}

/**
 * Record navigation-like state (switching sheets) in the URL so Back returns to
 * it. The router only listens to hashchange/popstate, so this does not re-render
 * routes on the way in; Back still flows the new `rest` down through the router.
 */
export function pushDocHash(docId: string, rest?: string): void {
  const base = window.location.href.split('#')[0];
  window.history.pushState(null, '', `${base}${docUrl(docId, rest)}`);
}
