// Main-thread cache layer. These are localStorage/IDB mirrors of worker state that
// exist purely for instant paint; the worker is always the source of truth.
//
// The "disable cache" setting toggles whether these mirrors are live. Because toggling
// it reloads the page (see setCacheDisabled in worker-api.ts), isCacheDisabled() is
// constant for the lifetime of a page load — so each cache picks its implementation ONCE
// here, at module init, instead of re-checking the flag at every call site.
//
// This file owns ONLY the client-side caches (tier 1). The worker-side caches (jqCache,
// query-result cache, validation cache) live in automerge-worker.ts and can't move here,
// since change-detection has to run where Automerge change events fire.

import { isCacheDisabled, idbGet, hashStr, type QueryCacheEntry } from './idb-storage';
import type { DocEntry } from './doc-storage';
import type { AccessLevel } from './shared/useAccess';

// ── Doc list (localStorage mirror of the worker's IDB doc-id list) ───────────

const DOC_STORAGE_KEY = 'automerge-doc-ids';

interface DocListCache {
  read(): DocEntry[];
  write(list: DocEntry[]): void;
}

const cachedDocList: DocListCache = {
  read() {
    try {
      const raw = JSON.parse(localStorage.getItem(DOC_STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  },
  write(list) {
    localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(list));
  },
};

const directDocList: DocListCache = {
  read: () => [],
  write: () => {},
};

export const docListCache: DocListCache = isCacheDisabled() ? directDocList : cachedDocList;

// ── Access level (localStorage mirror of keyhive per-doc access) ──────────────

const ACCESS_CACHE_KEY = 'keyhive-access-cache';

interface AccessCache {
  read(docId: string): AccessLevel;
  write(docId: string, access: AccessLevel): void;
}

function readAccessMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(ACCESS_CACHE_KEY) || '{}'); }
  catch { return {}; }
}

const cachedAccess: AccessCache = {
  read(docId) {
    return (readAccessMap()[docId] as AccessLevel) ?? null;
  },
  write(docId, access) {
    const map = readAccessMap();
    if (access === null) delete map[docId];
    else map[docId] = access;
    localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify(map));
  },
};

const directAccess: AccessCache = {
  read: () => null,
  write: () => {},
};

export const accessCache: AccessCache = isCacheDisabled() ? directAccess : cachedAccess;

// ── Query result fast-path (IDB read while the worker parses a large doc) ─────

interface QueryFastPath {
  read(docId: string, filter: string): Promise<QueryCacheEntry | null>;
}

const cachedQueryFastPath: QueryFastPath = {
  read(docId, filter) {
    return idbGet<QueryCacheEntry>(`qc:${docId}:${hashStr(filter)}`);
  },
};

const directQueryFastPath: QueryFastPath = {
  read: () => Promise.resolve(null),
};

export const queryFastPath: QueryFastPath = isCacheDisabled() ? directQueryFastPath : cachedQueryFastPath;
