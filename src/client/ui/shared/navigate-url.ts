/**
 * Navigate to a link the user pasted or scanned. Accepts a full URL (we take its
 * hash fragment), a hash-only string (`#/...`), or a bare rendezvous code
 * (`r.<id>.<key>`, which we route to the add-friend page). Returns an error
 * message on failure, or null on success.
 */
export function navigateToUrlOrHash(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Empty link.';
  const hashIdx = value.indexOf('#');
  if (hashIdx !== -1) {
    window.location.hash = value.slice(hashIdx + 1);
    return null;
  }
  // No hash: a bare rendezvous code joins the add-friend flow.
  if (value.startsWith('r.')) {
    window.location.hash = `/add-friend/${value}`;
    return null;
  }
  return 'Not a recognized link.';
}
