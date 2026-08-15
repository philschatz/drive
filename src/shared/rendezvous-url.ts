/**
 * Shared parsing/building of the device-link / friend-share rendezvous URL form
 * `#/link-device/r.<rendezvousId>.<key>` (base64url parts, '.' separated).
 *
 * Used by the app (LinkDevicePage / AddFriendPage) and the headless CLI, so the
 * URL contract can't drift between them.
 */

/**
 * Extract `{ rendezvousId, key }` from either a full link
 * (`…/#/link-device/r.<id>.<key>`) or a bare `r.<id>.<key>` token (what the app's
 * router hands the page). Returns null for anything else — which, since this is
 * the only link form the app builds, means the link is unusable.
 */
export function parseRendezvousToken(input: string): { rendezvousId: string; key: string } | null {
  let token = input.trim();
  const linkIdx = token.indexOf('link-device/');
  if (linkIdx >= 0) token = token.slice(linkIdx + 'link-device/'.length);
  const rIdx = token.indexOf('r.');
  if (rIdx < 0) return null;
  const parts = token.slice(rIdx).split('.');
  if (parts.length < 3 || parts[0] !== 'r' || !parts[1] || !parts[2]) return null;
  return { rendezvousId: parts[1], key: parts[2] };
}

/** Build a rendezvous link from a base (`origin + pathname`) + id/key. */
export function buildRendezvousUrl(base: string, rendezvousId: string, key: string): string {
  return `${base}#/link-device/r.${rendezvousId}.${key}`;
}
