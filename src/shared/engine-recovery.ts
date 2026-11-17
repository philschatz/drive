/**
 * Recovery mode for DriveEngine (class-expression mixin, OUTERMOST in the chain).
 *
 * When init() finds keyhive state written by an older version (see
 * keyhive-format.ts) it boots neither keyhive nor the repo and sets
 * `resetRequired`. From then on this mixin's `handleMessage` runs before any
 * other layer's and serves exactly two requests — the ones the reset screen
 * needs — answering everything else with an error. That is what keeps every
 * inner layer from dereferencing a null repo/khOps, and what guarantees the old
 * state is never handed to the bridge or the network: nothing below this ever
 * runs.
 *
 *   export-legacy-backup  a snapshot backup read straight from storage
 *   reset-keyhive         remove the old keyhive state (the caller then reloads)
 *
 * Outside recovery mode the same export still works for a device that has
 * already reset — its pre-upgrade documents are still on disk, listed in the
 * record the reset left (KEYS.preResetState) — and `reset-keyhive` is refused,
 * so nothing can wipe healthy state through it.
 */
import type { EngineCore } from './drive-engine';
import type { MainToWorker } from './worker-protocol';
import type { BackupPayload } from './backup';
import { KEYS } from './storage-keys';
import { resetKeyhiveState, inspectKeyhiveStorage, type PreResetState } from './keyhive-format';
import { buildLegacyBackup } from './legacy-backup';
import { createLogger } from './logger';

const log = createLogger('engine');

export type EngineRecoveryCtor = new (...args: any[]) => EngineCore;

export interface LegacyBackupResult {
  payload: BackupPayload;
  /** Names of documents that could not be read from storage. */
  unreadable: string[];
}

export interface PreResetInfo {
  docCount: number;
  resetAt: string;
}

/** This mixin's external API (also types the composed instance). */
export interface EngineRecoverySurface {
  exportLegacyBackup(): Promise<LegacyBackupResult>;
  resetKeyhive(): Promise<{ ok: true }>;
  preResetInfo(): Promise<PreResetInfo | null>;
}

const BLOCKED = 'This device needs a reset before it can be used: its saved sharing keys are from an older version.';

export function EngineRecovery<C extends EngineRecoveryCtor>(Base: C):
  new (...args: any[]) => InstanceType<C> & EngineRecoverySurface {
  return class EngineRecoveryMixin extends Base {
    /**
     * Documents + settings as a snapshot backup, read from storage without
     * keyhive. While blocked the source is the live home list; after a reset it
     * is the record the reset left behind.
     */
    async exportLegacyBackup(): Promise<LegacyBackupResult> {
      const kv = this.host.kv;
      let docs: PreResetState['docs'];
      let settings: unknown;
      if (this.resetRequired) {
        docs = (await kv.get<PreResetState['docs']>(KEYS.docIds)) ?? [];
        settings = await kv.get<unknown>(KEYS.driveSettings);
      } else {
        const record = await kv.get<PreResetState>(KEYS.preResetState);
        if (!record) throw new Error('Nothing to export: this device has no pre-upgrade documents.');
        docs = record.docs ?? [];
        settings = record.settings;
      }
      // Automerge's own WASM has nothing to do with keyhive; in recovery mode
      // init() never got far enough to load it, so load it here.
      const Automerge = this.Automerge ?? (await import('@automerge/automerge'));
      const result = await buildLegacyBackup({ storage: this.host.storage, Automerge, docs, settings });
      if (result.unreadable.length) {
        log.warn(`legacy export: ${result.unreadable.length} document(s) could not be read:`, result.unreadable.join(', '));
      }
      return result;
    }

    /** Remove the old-format keyhive state. Only ever valid in recovery mode. */
    async resetKeyhive(): Promise<{ ok: true }> {
      if (!this.resetRequired) {
        const state = await inspectKeyhiveStorage(this.host.storage);
        throw new Error(`No reset is needed: this device's keyhive state is not old-format (it is ${state.kind}).`);
      }
      await resetKeyhiveState(this.host.storage, this.host.kv);
      log.info('keyhive state reset; reload to boot fresh');
      return { ok: true };
    }

    /** The record a past reset left, summarised — or null if there was none. */
    async preResetInfo(): Promise<PreResetInfo | null> {
      const record = await this.host.kv.get<PreResetState>(KEYS.preResetState);
      return record ? { docCount: record.docs?.length ?? 0, resetAt: record.resetAt } : null;
    }

    async handleMessage(msg: MainToWorker): Promise<void> {
      if (msg.type === 'export-legacy-backup') {
        await this.respond(msg.id, () => this.exportLegacyBackup(), 'export-legacy-backup failed:');
        return;
      }
      if (msg.type === 'reset-keyhive') {
        await this.respond(msg.id, () => this.resetKeyhive(), 'reset-keyhive failed:');
        return;
      }
      if (msg.type === 'get-pre-reset-info') {
        await this.respond(msg.id, () => this.preResetInfo());
        return;
      }

      if (this.resetRequired) {
        // Blocked: no repo, no keyhive. Answer requests so nothing waits on a
        // reply that will never come; drop fire-and-forget messages.
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'number') this.host.emit({ type: 'result', id, error: BLOCKED });
        else log.debug('dropped while waiting for a reset:', msg.type);
        return;
      }

      await super.handleMessage(msg);
    }
  } as any;
}
