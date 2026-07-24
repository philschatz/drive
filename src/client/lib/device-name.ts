/**
 * Generate a friendly default name for THIS device.
 *
 * Browser-only (reads `navigator`). Used to seed the per-device name when the
 * user hasn't set one: an emoji for the device kind (📱 phone / 💻 laptop) plus
 * a generic browser name (Firefox, Chrome, Edge, Safari, …), e.g. "💻 Firefox".
 *
 * We deliberately keep the browser name coarse — no versions, no engine names —
 * so it reads as a human label ("my Chrome laptop"), not a diagnostic string.
 */

export type DeviceKind = 'phone' | 'laptop';

/** Minimal shape of the (Chromium-only) navigator.userAgentData we consume. */
interface UserAgentData {
  mobile?: boolean;
  brands?: { brand: string; version: string }[];
}

function uaData(): UserAgentData | undefined {
  return (navigator as any).userAgentData as UserAgentData | undefined;
}

/** Phone vs laptop/desktop. Prefer the UA-Client-Hints flag, else sniff the UA. */
export function detectDeviceKind(): DeviceKind {
  const data = uaData();
  if (data && typeof data.mobile === 'boolean') return data.mobile ? 'phone' : 'laptop';
  return /Mobi|Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry/i.test(navigator.userAgent)
    ? 'phone'
    : 'laptop';
}

/**
 * Coarse browser name. Order matters: Edge/Opera/Samsung UAs also contain
 * "Chrome", and Chrome's UA contains "Safari", so the more specific brands must
 * be tested first. On iOS every browser is WebKit under the hood but advertises
 * a distinguishing token (CriOS/FxiOS/EdgiOS).
 */
export function detectBrowserName(): string {
  const ua = navigator.userAgent;
  // Client-Hints brands are the most reliable signal on Chromium browsers.
  const brands = (uaData()?.brands ?? []).map((b) => b.brand).join(' ');

  if (/Edg|EdgiOS|Edge/i.test(brands) || /Edg[A-Z]?\//i.test(ua)) return 'Edge';
  if (/OPR|Opera/i.test(brands) || /OPR\/|Opera\//i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  if (/Google Chrome|Chromium/i.test(brands) || /CriOS\/|Chrome\/|Chromium\//i.test(ua)) return 'Chrome';
  // Real Safari carries a "Version/" token; Chrome-family UAs also say "Safari".
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return 'Safari';
  return 'Browser';
}

const KIND_EMOJI: Record<DeviceKind, string> = { phone: '📱', laptop: '💻' };

/** e.g. "💻 Firefox" or "📱 Chrome". */
export function generateDefaultDeviceName(): string {
  return `${KIND_EMOJI[detectDeviceKind()]} ${detectBrowserName()}`;
}
