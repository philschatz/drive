/**
 * URL builders for the QR friend/device exchange, used by the sharer side (the two
 * bottom sheets). Both forms carry only the rendezvous `{id, key}` — the contact
 * bundle itself travels over the encrypted relay channel, never in the URL.
 *
 * They live here rather than in either sheet because the receiver pages are
 * `lazyView`-wrapped in App.tsx, and these builders used to live *in* those page
 * modules — so opening a sheet eagerly pulled the whole receiver page into the
 * bundle and defeated its code split.
 *
 * They can't move down into `src/shared/rendezvous-url.ts` either: these read
 * `window.location` to build an absolute URL for the current deployment.
 */
import { buildRendezvousUrl } from '../../../shared/rendezvous-url';

/** The app's own base URL, without the hash. */
function appBase(): string {
  return window.location.origin + window.location.pathname;
}

export function buildLinkDeviceRendezvousUrl(rendezvousId: string, key: string): string {
  return buildRendezvousUrl(appBase(), rendezvousId, key);
}

export function buildAddFriendRendezvousUrl(rendezvousId: string, key: string): string {
  return `${appBase()}#/add-friend/r.${rendezvousId}.${key}`;
}
