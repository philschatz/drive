/**
 * Central builders for document URLs. All doc URLs are hash-based and type-free:
 * `#/d/<docId>[/<rest>]` — the document's `@type` selects the view (see DocRoute),
 * never the URL. `<rest>` is the plugin-specific deep-link remainder
 * (e.g. `events/<uid>`, `tasks/<uid>`, `sheets/<sid>/cells/<row>:<col>`).
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

function hrefFor(docId: string, rest?: string, query?: string): string {
  const base = window.location.href.split('#')[0];
  return `${base}${docUrl(docId, rest)}${query ?? ''}`;
}

/**
 * Record the current deep-link state in the URL without navigating (the router
 * only listens to hashchange/popstate, so these do not re-render routes; Back
 * still flows the new `rest` down through the router). `query` must include its
 * leading `?` (e.g. `?anchor=r1:c2`).
 *
 * replaceDocHash: transient state (focused field / selected cell) — no history entry.
 * pushDocHash: navigation-like state (switching sheets) — Back returns to it.
 */
export function replaceDocHash(docId: string, rest?: string, query?: string): void {
  window.history.replaceState(null, '', hrefFor(docId, rest, query));
}

export function pushDocHash(docId: string, rest?: string, query?: string): void {
  window.history.pushState(null, '', hrefFor(docId, rest, query));
}
