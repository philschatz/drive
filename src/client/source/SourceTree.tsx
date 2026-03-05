import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

import type { ValidationError } from '../../shared/schemas';

type Path = (string | number)[];

interface PeerFocus {
  path: Path;
  color: string;
  peerId: string;
}

interface SourceTreeProps {
  data: any;
  editable?: boolean;
  onEdit?: (path: Path, value: any) => void;
  onDelete?: (path: Path) => void;
  onAdd?: (path: Path, key: string, value: any) => void;
  peerFocusedPaths?: PeerFocus[];
  onFocusPath?: (path: Path | null) => void;
  errors?: ValidationError[];
  revealPath?: Path | null;
}

interface NodeProps {
  name: string | number | null;
  value: any;
  path: Path;
  depth: number;
  editable: boolean;
  onEdit: (path: Path, value: any) => void;
  onDelete: (path: Path) => void;
  onAdd: (path: Path, key: string, value: any) => void;
  peerFocusedPaths: PeerFocus[];
  onFocusPath: (path: Path | null) => void;
  changedPaths: Set<string>;
  errors: ValidationError[];
  revealPath: Path | null;
}

function pathsEqual(a: Path, b: Path): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPrefix(prefix: Path, full: Path): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

function EditInput({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  return (
    <input
      className="source-edit-input"
      value={val}
      onInput={(e) => setVal((e.target as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSave(val);
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onCancel()}
      autoFocus
    />
  );
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function unescapeString(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') { result += '\n'; i++; continue; }
      if (next === 'r') { result += '\r'; i++; continue; }
      if (next === 't') { result += '\t'; i++; continue; }
      if (next === '\\') { result += '\\'; i++; continue; }
    }
    result += s[i];
  }
  return result;
}

function parseValue(raw: string): any {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return num;
  return unescapeString(raw);
}

/** Recursively diff two values and collect the path keys of all changed leaves + their ancestors. */
function collectChangedPaths(prev: any, curr: any, path: Path, out: Set<string>) {
  if (prev === curr) return;
  const prevIsObj = prev !== null && typeof prev === 'object';
  const currIsObj = curr !== null && typeof curr === 'object';
  if (!prevIsObj || !currIsObj) {
    // Leaf changed (or type changed)
    out.add(path.join('/'));
    return;
  }
  // Both are objects/arrays — compare children
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of allKeys) {
    collectChangedPaths(prev[key], curr[key], [...path, key], out);
  }
}

function SourceNode({ name, value, path, depth, editable, onEdit, onDelete, onAdd, peerFocusedPaths, onFocusPath, changedPaths, errors, revealPath }: NodeProps) {
  const [collapsed, setCollapsed] = useState(depth >= 2);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addVal, setAddVal] = useState('');
  const rowRef = useRef<HTMLDivElement>(null);

  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const isContainer = isObject || isArray;

  const pathKey = path.join('/');
  const isChanged = changedPaths.has(pathKey);

  // Flash animation when this path is in the changed set
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (isChanged && !editing) {
      setFlashing(true);
      const id = setTimeout(() => setFlashing(false), 600);
      return () => clearTimeout(id);
    }
  }, [isChanged, editing]);

  // Broadcast focus when editing state changes
  // Use serialized path as dependency since `path` is a new array reference each render
  useEffect(() => {
    if (editing) {
      onFocusPath(path);
      return () => onFocusPath(null);
    }
  }, [editing, pathKey]);

  // Auto-expand when a peer focuses on a descendant path, and scroll to exact match
  const prevPeerFocusKeysRef = useRef('');
  useEffect(() => {
    if (peerFocusedPaths.length === 0) { prevPeerFocusKeysRef.current = ''; return; }
    if (isContainer && collapsed && peerFocusedPaths.some(p => isPrefix(path, p.path))) {
      setCollapsed(false);
    }
    // Scroll to this node when a peer newly focuses on it
    const exactMatch = peerFocusedPaths.find(p => pathsEqual(p.path, path));
    if (exactMatch) {
      const focusKey = peerFocusedPaths.map(p => p.peerId + ':' + p.path.join('/')).join(',');
      if (focusKey !== prevPeerFocusKeysRef.current) {
        prevPeerFocusKeysRef.current = focusKey;
        // Delay scroll to let ancestor expansions render first
        const id = setTimeout(() => {
          rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);
        return () => clearTimeout(id);
      }
    }
  }, [peerFocusedPaths]);

  useEffect(() => {
    if (!isContainer || !collapsed || changedPaths.size === 0) return;
    for (const cp of changedPaths) {
      if (cp.startsWith(pathKey + '/')) {
        setCollapsed(false);
        break;
      }
    }
  }, [changedPaths]);

  // Reveal path: expand ancestors and scroll/highlight the target
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!revealPath) return;
    if (isContainer && collapsed && isPrefix(path, revealPath)) {
      setCollapsed(false);
    }
    if (pathsEqual(path, revealPath)) {
      setRevealed(true);
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      const id = setTimeout(() => setRevealed(false), 1200);
      return () => clearTimeout(id);
    }
  }, [revealPath]);

  // Presence: colored dots for exact focus, border-left for ancestor
  const exactFocusPeers = peerFocusedPaths.filter(p => pathsEqual(p.path, path));
  const ancestorFocus = exactFocusPeers.length === 0 ? peerFocusedPaths.find(p => isPrefix(path, p.path)) : undefined;
  const rowStyle: Record<string, string> | undefined =
    exactFocusPeers.length > 0
      ? { opacity: '0.5', borderLeftColor: exactFocusPeers[0].color + '60' }
      : ancestorFocus
        ? { borderLeftColor: ancestorFocus.color + '60' }
        : undefined;

  const handleSave = useCallback((raw: string) => {
    setEditing(false);
    onEdit(path, parseValue(raw));
  }, [path, onEdit]);

  const handleAdd = useCallback(() => {
    if (isArray) {
      onAdd(path, String(value.length), parseValue(addVal));
    } else if (addKey) {
      onAdd(path, addKey, parseValue(addVal));
    }
    setAdding(false);
    setAddKey('');
    setAddVal('');
  }, [path, onAdd, isArray, value, addKey, addVal]);

  // Validation errors: exact match and descendant (ancestor indicator)
  const nodeErrors = errors.filter(e => pathsEqual(e.path, path));
  const schemaErrors = nodeErrors.filter(e => !e.kind || e.kind === 'schema');
  const depErrors = nodeErrors.filter(e => e.kind === 'dependency');
  const warnErrors = nodeErrors.filter(e => e.kind === 'warning');
  const hasDescendantErrors = nodeErrors.length === 0 && errors.some(e => isPrefix(path, e.path));

  const renderKey = () => {
    if (name === null) return null;
    return (
      <>
        <span className={'source-key' + (flashing ? ' source-changed' : '')}>{typeof name === 'number' ? name : `"${name}"`}</span>
        {schemaErrors.length > 0 && (
          <span className="source-error-icon schema" title={schemaErrors.map(e => e.message).join('\n')}>❌</span>
        )}
        {depErrors.length > 0 && (
          <span className="source-error-icon" title={depErrors.map(e => e.message).join('\n')}>⚠️</span>
        )}
        {warnErrors.length > 0 && (
          <span className="source-error-icon" title={warnErrors.map(e => e.message).join('\n')}>⚠️</span>
        )}
        {hasDescendantErrors && (
          <span className="source-error-icon descendant" title="Contains validation errors">⚠️</span>
        )}
      </>
    );
  };

  if (isContainer) {
    const bracket = isArray ? ['[', ']'] : ['{', '}'];
    const count = isArray ? value.length : Object.keys(value).length;

    return (
      <div className="source-node">
        <div ref={rowRef} className={'source-row' + (revealed ? ' source-revealed' : '')} style={rowStyle}>
          <span className={'source-toggle' + (collapsed ? ' collapsed' : '')} onClick={() => setCollapsed(!collapsed)}>&#9656;</span>
          {renderKey()}
          {name !== null && <span className="source-colon">: </span>}
          {collapsed ? (
            <span className="source-bracket" onClick={() => setCollapsed(false)}>
              {bracket[0]} <span className="source-count">{count} {isArray ? 'items' : 'keys'}</span> {bracket[1]}
            </span>
          ) : (
            <span className="source-bracket">{bracket[0]}</span>
          )}
          {exactFocusPeers.map((p, i) => (
            <span key={i} className="source-peer-dot" style={{ backgroundColor: p.color }} title={`Peer ${p.peerId.slice(0, 8)} is editing`} />
          ))}
          {editable && (
            <span className="source-actions">
              {name !== null && <button className="source-btn delete" onClick={() => onDelete(path)} title="Delete">×</button>}
            </span>
          )}
        </div>
        {!collapsed && (
          <div className="source-children">
            {isArray
              ? value.map((item: any, i: number) => (
                  <SourceNode key={i} name={i} value={item} path={[...path, i]} depth={depth + 1}
                    editable={editable} onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
                    peerFocusedPaths={peerFocusedPaths} onFocusPath={onFocusPath} changedPaths={changedPaths} errors={errors} revealPath={revealPath} />
                ))
              : Object.keys(value).map((key) => (
                  <SourceNode key={key} name={key} value={value[key]} path={[...path, key]} depth={depth + 1}
                    editable={editable} onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
                    peerFocusedPaths={peerFocusedPaths} onFocusPath={onFocusPath} changedPaths={changedPaths} errors={errors} revealPath={revealPath} />
                ))
            }
            {editable && (
              <div className="source-row source-add-row">
                {adding ? (
                  <span className="source-add-form" onBlur={(e: any) => {
                    const related = e.relatedTarget as HTMLElement | null;
                    if (!related || !e.currentTarget.contains(related)) {
                      setAdding(false);
                      setAddKey('');
                      setAddVal('');
                    }
                  }}>
                    {!isArray && (
                      <input className="source-edit-input" placeholder="key" value={addKey}
                        onInput={(e) => setAddKey((e.target as HTMLInputElement).value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                        autoFocus />
                    )}
                    <input className="source-edit-input" placeholder="value"  value={addVal}
                      onInput={(e) => setAddVal((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                      autoFocus={isArray} />
                    <button className="source-btn add" onClick={handleAdd}>ok</button>
                    <button className="source-btn" onClick={() => setAdding(false)}>cancel</button>
                  </span>
                ) : (
                  <button className="source-btn add" onClick={() => setAdding(true)}>+ add</button>
                )}
              </div>
            )}
            <div className="source-row">
              <span className="source-bracket">{bracket[1]}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Primitive value
  const typeClass = value === null ? 'source-null'
    : typeof value === 'string' ? 'source-string'
    : typeof value === 'number' ? 'source-number'
    : typeof value === 'boolean' ? 'source-boolean'
    : 'source-unknown';

  const displayValue = value === null ? 'null'
    : typeof value === 'string' ? `"${escapeString(value)}"`
    : String(value);

  return (
    <div className="source-node">
      <div ref={rowRef} className={'source-row' + (revealed ? ' source-revealed' : '')} style={rowStyle}>
        <span className="source-toggle-placeholder" />
        {renderKey()}
        {name !== null && <span className="source-colon">: </span>}
        {editing ? (
          <EditInput
            initial={value === null ? 'null' : typeof value === 'string' ? escapeString(value) : String(value)}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className={typeClass} onClick={editable ? () => setEditing(true) : undefined}
            style={editable ? { cursor: 'pointer' } : undefined}>
            {displayValue}
          </span>
        )}
        {exactFocusPeers.map((p, i) => (
          <span key={i} className="source-peer-dot" style={{ backgroundColor: p.color }} title={`Peer ${p.peerId.slice(0, 8)} is editing`} />
        ))}
        {editable && !editing && (
          <span className="source-actions">
            <button className="source-btn" onClick={() => setEditing(true)} title="Edit">&#9998;</button>
            {name !== null && <button className="source-btn delete" onClick={() => onDelete(path)} title="Delete">×</button>}
          </span>
        )}
      </div>
    </div>
  );
}

const EMPTY_SET: Set<string> = new Set();

export function SourceTree({ data, editable = false, onEdit, onDelete, onAdd, peerFocusedPaths, onFocusPath, errors, revealPath }: SourceTreeProps) {
  const noop = () => {};
  const prevDataRef = useRef(data);
  const [changedPaths, setChangedPaths] = useState<Set<string>>(EMPTY_SET);

  useEffect(() => {
    const prev = prevDataRef.current;
    prevDataRef.current = data;
    if (prev === data) return;
    const paths = new Set<string>();
    collectChangedPaths(prev, data, [], paths);
    if (paths.size === 0) return;
    // Remove root path ('') since root has no key to flash
    paths.delete('');
    setChangedPaths(paths);
    const id = setTimeout(() => setChangedPaths(EMPTY_SET), 600);
    return () => clearTimeout(id);
  }, [data]);

  return (
    <div className="source-tree">
      <SourceNode
        name={null}
        value={data}
        path={[]}
        depth={0}
        editable={editable}
        onEdit={onEdit || noop}
        onDelete={onDelete || noop}
        onAdd={onAdd || noop}
        peerFocusedPaths={peerFocusedPaths || []}
        onFocusPath={onFocusPath || noop}
        changedPaths={changedPaths}
        errors={errors || []}
        revealPath={revealPath ?? null}
      />
    </div>
  );
}
