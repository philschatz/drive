import { useState, useEffect, useRef } from 'preact/hooks';
import { useRelayLog, type RelayLogEntry } from '../worker-api';
import './relay-log.css';

function formatLogTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/** Syntax-highlight a JSON value with CSS classes for the relay log. */
function highlightJson(val: unknown, indent: number = 0): preact.JSX.Element {
  if (val === null || val === undefined) {
    return <span className="json-null">null</span>;
  }
  if (typeof val === 'boolean') {
    return <span className="json-bool">{String(val)}</span>;
  }
  if (typeof val === 'number') {
    return <span className="json-number">{val}</span>;
  }
  if (typeof val === 'string') {
    // Annotate encrypted / decrypted / binary markers
    if (val.startsWith('[encrypted:')) {
      return <span className="json-encrypted">{val}</span>;
    }
    if (val.startsWith('[decrypted]') || val.startsWith('[decrypted:')) {
      return <span className="json-decrypted">{val}</span>;
    }
    if (val.startsWith('[signed:') || val.startsWith('[binary:') || val.match(/^\[\d+ bytes\]$/)) {
      return <span className="json-binary">{val}</span>;
    }
    return <span className="json-string">"{val}"</span>;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return <span>{'[]'}</span>;
    const pad = '  '.repeat(indent + 1);
    const closePad = '  '.repeat(indent);
    return (
      <span>
        {'[\n'}
        {val.map((item, i) => (
          <span key={i}>
            {pad}{highlightJson(item, indent + 1)}{i < val.length - 1 ? ',' : ''}{'\n'}
          </span>
        ))}
        {closePad}{']'}
      </span>
    );
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val);
    if (entries.length === 0) return <span>{'{}'}</span>;
    const pad = '  '.repeat(indent + 1);
    const closePad = '  '.repeat(indent);
    return (
      <span>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {pad}<span className="json-key">"{k}"</span>: {highlightJson(v, indent + 1)}{i < entries.length - 1 ? ',' : ''}{'\n'}
          </span>
        ))}
        {closePad}{'}'}
      </span>
    );
  }
  return <span>{String(val)}</span>;
}

interface DisplayEntry extends RelayLogEntry {
  count: number;
}

function rollupEntries(entries: RelayLogEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    // Roll up consecutive keyhive-sync-check messages in the same direction
    if (
      e.message?.type === 'keyhive-sync-check' &&
      last?.message?.type === 'keyhive-sync-check' &&
      last.dir === e.dir
    ) {
      out[out.length - 1] = { ...last, count: last.count + 1, ts: e.ts };
    } else {
      out.push({ ...e, count: 1 });
    }
  }
  return out;
}

export function RelayLogPanel() {
  const [entries, clear] = useRelayLog();
  const [collapsed, setCollapsed] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!collapsed) {
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [entries.length, collapsed]);

  const display = rollupEntries(entries);

  return (
    <div className="relay-log">
      <div className="relay-log-header">
        <span className="relay-log-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '\u25b6' : '\u25bc'}
        </span>
        <strong>Relay Log</strong>
        <span className="relay-log-count">{entries.length}</span>
        {!collapsed && entries.length > 0 && (
          <button className="relay-log-clear" onClick={clear}>clear</button>
        )}
      </div>
      {!collapsed && (
        <div className="relay-log-body">
          {display.map(e => {
            const msgType: string = e.message?.type ?? 'unknown';
            const isKeyhive = msgType.startsWith('keyhive-');
            const isAdapter = e.dir !== 'sent' && e.dir !== 'recv';
            const dirClass = e.dir === 'sent' ? 'log-sent' : e.dir === 'recv' ? 'log-recv' : 'log-keyhive-adapter';
            return (
              <div key={e.id} className={`relay-log-entry ${dirClass}`}>
                <span className="log-time">{formatLogTime(e.ts)}</span>
                <span className="log-dir">{e.dir === 'sent' ? '\u2191' : '\u2193'}</span>
                <span className={`log-type${isKeyhive ? ' keyhive' : ''}`}>{msgType}</span>
                <span className="log-json">
                  {e.count > 1 ? (
                    <span className="relay-log-rollup">{'\u00d7'}{e.count}</span>
                  ) : (
                    <pre>{highlightJson(e.message)}</pre>
                  )}
                </span>
              </div>
            );
          })}
          {entries.length === 0 && <div className="relay-log-empty">No relay messages yet.</div>}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
