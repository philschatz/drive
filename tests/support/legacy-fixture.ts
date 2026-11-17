/**
 * Loader for tests/fixtures/legacy-alpha58.json — a real profile written by the
 * pre-upgrade keyhive build (alpha.58 fork). See the capture notes in the file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeMemStorage, makeMemKv, type MemStorage } from './mem-storage';

/** Undo the on-disk backup encoding: `{ __driveBin: <base64> }` → Uint8Array. */
function binFromJson(v: any): any {
  if (Array.isArray(v)) return v.map(binFromJson);
  if (v && typeof v === 'object') {
    if (typeof v.__driveBin === 'string') return Uint8Array.from(Buffer.from(v.__driveBin, 'base64'));
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = binFromJson(val);
    return out;
  }
  return v;
}

export interface LegacyFixture {
  agentId: string;
  userGroupId: string;
  friendGroupId: string;
  docs: { calendar: string; tasks: string; sentences: string };
  /** Raw storage chunks + kv pairs of the old profile. */
  full: { storage: { key: string[]; data: Uint8Array }[]; kv: { key: string; value: unknown }[] };
  /** What the old build itself exported for the same profile (docs + settings). */
  snapshot: { docs: { bin: Uint8Array; doc?: any; markdown?: string; metadata?: { type?: string; name?: string } }[]; settings: any };
}

let cached: LegacyFixture | null = null;
export function loadLegacyFixture(): LegacyFixture {
  cached ??= binFromJson(JSON.parse(readFileSync(resolve(__dirname, '../fixtures/legacy-alpha58.json'), 'utf8')));
  return cached!;
}

/** A storage adapter + kv seeded exactly as the old profile left them. */
export function seedLegacyProfile(storage: MemStorage = makeMemStorage()) {
  const fx = loadLegacyFixture();
  for (const c of fx.full.storage) storage.store.set(c.key.join('\x00'), { key: [...c.key], data: c.data });
  const kv = makeMemKv(Object.fromEntries(fx.full.kv.map((p) => [p.key, p.value])));
  return { fx, storage, kv };
}
