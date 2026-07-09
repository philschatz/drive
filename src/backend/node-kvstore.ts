/**
 * Node KVStore implementation over a single JSON file — the CLI's equivalent of
 * the browser's `app-storage` IndexedDB. Holds the user-group id + doc list; the
 * disposable `cache:*` query cache is not persisted (it regenerates on demand).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { KVStore } from '../shared/engine-host';
import {
  SETTINGS_PREFIX, SETTINGS_DEFAULTS, CACHE_PREFIX,
  type SettingName, type SettingsSchema,
} from '../shared/storage-keys';

export class NodeKVStore implements KVStore {
  private readonly filePath: string;
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      this.data = {}; // missing/corrupt file → start empty
    }
    this.loaded = true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data));
  }

  async get<T>(key: string): Promise<T | null> {
    this.ensureLoaded();
    return (this.data[key] as T) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    // The query cache is disposable; don't grow the CLI's kv file with it.
    if (key.startsWith(CACHE_PREFIX)) return;
    this.ensureLoaded();
    this.data[key] = value;
    this.persist();
  }

  async del(key: string): Promise<void> {
    this.ensureLoaded();
    if (key in this.data) { delete this.data[key]; this.persist(); }
  }

  async delPrefix(prefix: string): Promise<void> {
    this.ensureLoaded();
    let changed = false;
    for (const k of Object.keys(this.data)) {
      if (k.startsWith(prefix)) { delete this.data[k]; changed = true; }
    }
    if (changed) this.persist();
  }

  async settingGet<K extends SettingName>(name: K): Promise<SettingsSchema[K]> {
    this.ensureLoaded();
    const v = this.data[SETTINGS_PREFIX + name];
    return (v ?? SETTINGS_DEFAULTS[name]) as SettingsSchema[K];
  }

  async settingSet<K extends SettingName>(name: K, value: SettingsSchema[K]): Promise<void> {
    this.ensureLoaded();
    this.data[SETTINGS_PREFIX + name] = value;
    this.persist();
  }
}
