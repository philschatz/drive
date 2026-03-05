import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { Presence } from './automerge';
import './presence-log.css';

export interface PresenceLogEntry {
  id: number;
  time: number;
  dir: 'sent' | 'recv';
  type: string;
  peerId: string;
  detail: string;
  docId?: string;
}

const MAX_LOG_ENTRIES = 200;
let logIdCounter = 0;

/** Hook that manages presence log state and provides helpers to wire up a Presence instance. */
export function usePresenceLog() {
  const [entries, setEntries] = useState<PresenceLogEntry[]>([]);

  const addEntry = useCallback((dir: 'sent' | 'recv', type: string, peerId: string, detail: string, docId?: string) => {
    const entry: PresenceLogEntry = { id: ++logIdCounter, time: Date.now(), dir, type, peerId, detail, docId };
    setEntries(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
    });
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  /** Attach event listeners to a Presence instance and log its initial state. Returns a cleanup function. */
  const attachToPresence = useCallback((presence: Presence<any, any>, mountedRef?: { current: boolean }, docId?: string) => {
    const logRecv = (e: any) => {
      if (mountedRef && !mountedRef.current) return;
      const type: string = e?.type ?? 'unknown';
      const peerId: string = e?.peerId ?? e?.pruned?.join(',') ?? '?';
      let detail = '';
      if (type === 'snapshot') detail = JSON.stringify(e.state);
      else if (type === 'update') detail = `${e.channel}: ${JSON.stringify(e.value)}`;
      else if (type === 'pruning') detail = `pruned: ${JSON.stringify(e.pruned)}`;
      else if (type === 'goodbye' || type === 'heartbeat') detail = '';
      addEntry('recv', type, peerId, detail, docId);
    };
    presence.on('update', logRecv);
    presence.on('snapshot', logRecv);
    presence.on('goodbye', logRecv);
    presence.on('heartbeat', logRecv);
    presence.on('pruning', logRecv);

    addEntry('sent', 'snapshot', 'self', JSON.stringify(presence.getLocalState()), docId);

    return () => {
      presence.off('update', logRecv);
      presence.off('snapshot', logRecv);
      presence.off('goodbye', logRecv);
      presence.off('heartbeat', logRecv);
      presence.off('pruning', logRecv);
    };
  }, [addEntry]);

  return { entries, addEntry, clear, attachToPresence };
}

function formatLogTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

type DisplayEntry = PresenceLogEntry & { count: number };

function rollupEntries(entries: PresenceLogEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (
      e.type === 'heartbeat' &&
      last?.type === 'heartbeat' &&
      last.dir === e.dir &&
      last.peerId === e.peerId
    ) {
      out[out.length - 1] = { ...last, count: last.count + 1, time: e.time };
    } else {
      out.push({ ...e, count: 1 });
    }
  }
  return out;
}

export function PresenceLogTable({ entries, onClear, showDocId }: {
  entries: PresenceLogEntry[];
  onClear: () => void;
  showDocId?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);

  const display = rollupEntries(entries);

  return (
    <div className="presence-log">
      <div className="presence-log-header">
        <span className="presence-log-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '\u25b6' : '\u25bc'}
        </span>
        <strong>Presence Log</strong>
        <span className="presence-log-count">{entries.length}</span>
        {!collapsed && entries.length > 0 && (
          <button className="presence-log-clear" onClick={onClear}>clear</button>
        )}
      </div>
      {!collapsed && (
        <div className="presence-log-body">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {showDocId && <th>Doc</th>}
                <th>Dir</th>
                <th>Type</th>
                <th>Peer</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {display.map(e => (
                <tr key={e.id} className={e.dir === 'sent' ? 'log-sent' : 'log-recv'}>
                  <td className="log-time">{formatLogTime(e.time)}</td>
                  {showDocId && <td className="log-doc">{e.docId ? <a href={`/source/${e.docId}`} title={e.docId}>{e.docId.slice(0, 8)}</a> : ''}</td>}
                  <td className="log-dir">{e.dir === 'sent' ? '\u2191' : '\u2193'}</td>
                  <td>{e.type}</td>
                  <td className="log-peer" title={e.peerId}>{e.peerId === 'self' ? 'self' : e.peerId.slice(0, 8)}</td>
                  <td className="log-detail">{e.type === 'heartbeat' && e.count > 1 ? `×${e.count}` : e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && <div className="presence-log-empty">No presence messages yet.</div>}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
