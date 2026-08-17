/**
 * ICE server configuration shared by every WebRTC bridge host.
 *
 * The browser reads its override from the build-time `VITE_ICE_SERVERS`; the
 * Node CLI reads the runtime `DRIVE_ICE_SERVERS`. Both carry the same shape — a
 * JSON array of RTCIceServer-like entries — so the parsing lives here and each
 * host supplies only the raw string. (`import.meta` is banned in src/shared,
 * which is why the env *lookup* stays in the callers.)
 */
import { createLogger } from './logger';

const log = createLogger('webrtc');

/** Structural RTCIceServer so nothing here depends on the DOM lib. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Default public STUN servers (no TURN — symmetric-NAT peers stay on the relay). */
export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/** Parse an ICE-server override (JSON array of {@link IceServer}). Absent or invalid → defaults. */
export function parseIceServers(raw: string | undefined | null): IceServer[] {
  try {
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (err) {
    log.warn('invalid ICE-server override, using defaults:', err);
  }
  return DEFAULT_ICE_SERVERS;
}
