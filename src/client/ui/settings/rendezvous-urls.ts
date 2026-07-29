/**
 * URL builders for the QR friend/device exchange, shared by the sharer (the two
 * bottom sheets) and the receiver (the two pages).
 *
 * They live here rather than in either page because `AddDeviceSheet` /
 * `AddFriendSheet` used to import them *from* those page modules — and the pages
 * are `lazyView`-wrapped in App.tsx, so opening a sheet eagerly pulled the whole
 * receiver page into the bundle and defeated its code split.
 *
 * They can't move down into `src/shared/rendezvous-url.ts` either: these read
 * `window.location` to build an absolute URL for the current deployment.
 */
import { deflate, inflate } from 'pako';
import { buildRendezvousUrl } from '../../../shared/rendezvous-url';

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The app's own base URL, without the hash. */
function appBase(): string {
  return window.location.origin + window.location.pathname;
}

function decodeStringFromUrl(b64url: string): string {
  return new TextDecoder().decode(inflate(b64urlToBytes(b64url)));
}

export function encodeCardForUrl(value: string): string {
  return bytesToB64url(deflate(new TextEncoder().encode(value)));
}

/* ---------------------------------------------------------------- */
/*  Device linking                                                  */
/* ---------------------------------------------------------------- */

/** The preferred, tiny form: the QR carries only the rendezvous {id, key}. */
export function buildLinkDeviceRendezvousUrl(rendezvousId: string, key: string): string {
  return buildRendezvousUrl(appBase(), rendezvousId, key);
}

/** Legacy/second-leg form: the contact card and user-group id ride in the URL. */
export function buildLinkDeviceUrl(cardJson: string, userGroupId?: string | null): string {
  const payload = JSON.stringify({ card: cardJson, userGroupId: userGroupId ?? null });
  return `${appBase()}#/link-device/${encodeCardForUrl(payload)}`;
}

/** Decode a device-link payload, tolerating the legacy raw-card format. */
export function decodeLinkData(b64url: string): { cardJson: string; userGroupId: string | null } {
  const raw = decodeStringFromUrl(b64url);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
      return { cardJson: parsed.card, userGroupId: parsed.userGroupId ?? null };
    }
  } catch {
    // Not the wrapper format — old-style raw card JSON
  }
  return { cardJson: raw, userGroupId: null };
}

/* ---------------------------------------------------------------- */
/*  Friend invites                                                  */
/* ---------------------------------------------------------------- */

export function buildAddFriendRendezvousUrl(rendezvousId: string, key: string): string {
  return `${appBase()}#/add-friend/r.${rendezvousId}.${key}`;
}

export function buildAddFriendUrl(cardJson: string, displayName?: string, userGroupId?: string | null): string {
  const payload = (displayName || userGroupId)
    ? JSON.stringify({ card: cardJson, displayName, userGroupId: userGroupId ?? undefined })
    : cardJson;
  return `${appBase()}#/add-friend/${encodeCardForUrl(payload)}`;
}

export function decodeFriendData(b64url: string): { cardJson: string; displayName?: string; userGroupId?: string } {
  const raw = decodeStringFromUrl(b64url);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
      return { cardJson: parsed.card, displayName: parsed.displayName, userGroupId: parsed.userGroupId };
    }
  } catch {
    // Not the wrapper format — old-style raw card
  }
  return { cardJson: raw };
}
