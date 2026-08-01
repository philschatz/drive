/**
 * Browser KVStore implementation over idb-storage.ts (IndexedDB `app-storage`).
 * Handed to DriveEngine by the worker shell (automerge-worker.ts).
 */
import { idbGet, idbSet, idbDel, idbDelPrefix, idbEntries, settingGet, settingSet } from '../shared/idb-storage';
import type { KVStore } from '../../shared/engine-host';
import type { SettingName, SettingsSchema } from '../../shared/storage-keys';

export const idbKvStore: KVStore = {
  get: <T>(key: string) => idbGet<T>(key),
  set: (key: string, value: unknown) => idbSet(key, value),
  del: (key: string) => idbDel(key),
  delPrefix: (prefix: string) => idbDelPrefix(prefix),
  entries: () => idbEntries(),
  settingGet: <K extends SettingName>(name: K): Promise<SettingsSchema[K]> => settingGet(name),
  settingSet: <K extends SettingName>(name: K, value: SettingsSchema[K]) => settingSet(name, value),
};
