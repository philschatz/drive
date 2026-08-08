import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';

import type { ValidationError } from '../../../shared/schemas';
import {
  BLOCK_MARKER, markerEditOps, markersFromSpans,
  type BlockValue, type DocMarker, type RichTextOp, type RichTextSpan,
} from '../../../shared/rich-text-ops';
import { MATERIAL_CATEGORICAL } from '../common/categorical-colors';
import { peerDisplayName, peerIdentityKey } from '../common/presence';
import { PeerDot } from '../common/PeerDot';
import { usePeerTransports, type PeerTransport } from '../worker-api';

type Path = (string | number)[];

interface PeerFocus {
  path: Path;
  color: string;
  peerId: string;
  /** User-group id of the peer, if advertised — resolves a contact display name. */
  userGroupId?: string;
}

interface SourceTreeProps {
  data: any;
  editable?: boolean;
  /** path.join('/') → that field's Peritext spans, for fields carrying markers. */
  markerSpans?: Map<string, RichTextSpan[]>;
  onRichTextOps?: (path: Path, ops: RichTextOp[]) => void;
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
  markerSpans: Map<string, RichTextSpan[]>;
  onRichTextOps: (path: Path, ops: RichTextOp[]) => void;
  onEdit: (path: Path, value: any) => void;
  onDelete: (path: Path) => void;
  onAdd: (path: Path, key: string, value: any) => void;
  peerFocusedPaths: PeerFocus[];
  /** Per-peer transport map — one subscription at the tree root, not per node. */
  transports: Record<string, PeerTransport>;
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

/**
 * A block marker is U+FFFC, which renders as nothing (or as tofu) — invisible in
 * the value AND in the edit input, where it silently survives a round trip. So
 * it escapes to `￼`, which is both visible and typeable: adding one to the
 * string inserts a block marker, deleting one removes it.
 */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(new RegExp(BLOCK_MARKER, 'g'), '\\uFFFC');
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
      if (s.slice(i + 1, i + 6).toUpperCase() === 'UFFFC') { result += BLOCK_MARKER; i += 5; continue; }
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

// ---------------------------------------------------------------------------
// Markers
//
// Marks and block markers live inside the Automerge text object and are absent
// from the JSON projection the rest of this tree renders. They arrive as spans
// (see `allRichText`), become discrete markers, and are shown twice: as
// footnoted highlights over the value, and as an editable list beneath it.
// ---------------------------------------------------------------------------

const markerColor = (i: number) => MATERIAL_CATEGORICAL[i % MATERIAL_CATEGORICAL.length];
/** The 1-based reference tying a highlight to its row in the list below. The
 * superscript is CSS, so every index is marked up identically. */
const footnoteLabel = (i: number) => String(i + 1);

const markerStart = (m: DocMarker) => (m.kind === 'block' ? m.index : m.start);
const markerName = (m: DocMarker) => (m.kind === 'block' ? m.block.type : m.name);

/**
 * A mark value typed into the list, read back at the type it already had.
 *
 * The cell shows a string mark value RAW, so a link's `{"href":…}` is editable
 * as the JSON text it is — which is exactly why the edit must not be re-parsed:
 * that would store an object, and an Automerge mark value has to be a scalar.
 * Non-string values (a `strong` of `true`) are shown JSON-encoded, so they are
 * read back the same way, with the raw text as the fallback.
 */
function reparseMarkValue(previous: unknown, raw: string): unknown {
  if (typeof previous === 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? raw : parsed;
  } catch {
    return raw;
  }
}

/**
 * Compact block-type label for the inline chip: `¶h1`, `¶ul`, `¶p`.
 *
 * List nesting is not a separate field — a block's `parents` chain IS its
 * depth, so a twice-indented item is `parents: ['unordered-list-item',
 * 'unordered-list-item']`. The chip shows that as `·N` rather than dropping it,
 * since two list items at different depths are otherwise identical here.
 */
function blockChipLabel(b: BlockValue): string {
  const depth = b.parents?.length ?? 0;
  const suffix = depth > 0 ? `·${depth}` : '';
  const level = (b.attrs as any)?.level;
  if (b.type === 'heading') return `h${level ?? '?'}${suffix}`;
  if (b.type === 'unordered-list-item') return `ul${suffix}`;
  if (b.type === 'ordered-list-item') return `ol${suffix}`;
  if (b.type === 'paragraph') return `p${suffix}`;
  return b.type + suffix;
}

/**
 * The string value with its markers made visible: each mark's range tinted and
 * underlined in its footnote colour, each block marker replaced by a chip
 * naming its type.
 *
 * Overlapping marks are the reason for the stacked underline bars — a
 * background tint alone can only show one of them. Inset shadows paint in
 * declaration order, so the innermost (2px) bar covers the bottom of the next,
 * giving one visible band per covering mark.
 */
function MarkedString({ text, markers }: { text: string; markers: DocMarker[] }) {
  const blocks = new Map<number, { marker: DocMarker; i: number }>();
  const footnotesAt = new Map<number, number[]>();
  const cuts = new Set<number>([0, text.length]);
  markers.forEach((m, i) => {
    const start = markerStart(m);
    footnotesAt.set(start, [...(footnotesAt.get(start) ?? []), i]);
    if (m.kind === 'block') {
      blocks.set(m.index, { marker: m, i });
      cuts.add(m.index); cuts.add(m.index + 1);
    } else {
      cuts.add(m.start); cuts.add(m.end);
    }
  });
  const boundaries = [...cuts].filter(c => c >= 0 && c <= text.length).sort((a, b) => a - b);

  const parts: any[] = [];
  const pushFootnotes = (at: number, skip?: number) => {
    for (const i of footnotesAt.get(at) ?? []) {
      if (i === skip) continue;
      parts.push(
        <sup key={`f${at}-${i}`} className="source-marker-footnote" style={{ color: markerColor(i) }}>
          {footnoteLabel(i)}
        </sup>,
      );
    }
  };

  for (let b = 0; b < boundaries.length - 1; b++) {
    const from = boundaries[b];
    const to = boundaries[b + 1];
    if (to <= from) continue;
    const block = blocks.get(from);
    if (block && to === from + 1) {
      pushFootnotes(from, block.i);
      parts.push(
        <span key={from} className="source-marker-chip" style={{ borderColor: markerColor(block.i), color: markerColor(block.i) }}
          title={`block marker at ${from}: ${block.marker.kind === 'block' ? block.marker.block.type : ''}`}>
          ¶{blockChipLabel((block.marker as Extract<DocMarker, { kind: 'block' }>).block)}
          <sup className="source-marker-footnote">{footnoteLabel(block.i)}</sup>
        </span>,
      );
      continue;
    }
    pushFootnotes(from);
    const covering = markers
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.kind === 'mark' && m.start <= from && m.end >= to);
    parts.push(
      <span key={from} className={covering.length > 0 ? 'source-marked-run' : undefined}
        style={covering.length > 0 ? {
          backgroundColor: markerColor(covering[0].i) + '2b',
          boxShadow: covering.map(({ i }, k) => `inset 0 ${-2 * (k + 1)}px 0 ${markerColor(i)}`).join(', '),
        } : undefined}
        title={covering.length > 0 ? covering.map(({ m }) => markerName(m)).join(', ') : undefined}>
        {escapeString(text.slice(from, to))}
      </span>,
    );
  }
  // A marker sitting at the very end of the text has no following segment.
  pushFootnotes(text.length);

  return <span className="source-string">"{parts}"</span>;
}

/** One click-to-edit cell of a marker row. */
function MarkerCell(
  { value, title, editable, onSave }:
  { value: string; title: string; editable: boolean; onSave: (v: string) => void },
) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <EditInput initial={value}
        onSave={(v) => { setEditing(false); onSave(v); }}
        onCancel={() => setEditing(false)} />
    );
  }
  return (
    <span className="source-marker-cell" title={title}
      onClick={editable ? () => setEditing(true) : undefined}
      style={editable ? { cursor: 'pointer' } : undefined}>
      {value}
    </span>
  );
}

/**
 * The markers of one field, listed under its row and editable a cell at a time.
 *
 * Every marker is listed as it is stored, with no notion of which the document
 * type allows: this inspector renders what the document actually contains, and
 * whether that is legal is the validator's answer, arriving as the same
 * `errors` every other row here uses.
 */
function MarkerList(
  { path, text, markers, editable, errors, onRichTextOps }: {
    path: Path; text: string; markers: DocMarker[];
    editable: boolean; errors: ValidationError[];
    onRichTextOps: (path: Path, ops: RichTextOp[]) => void;
  },
) {
  const apply = (prev: DocMarker, next: DocMarker | null) => {
    try {
      onRichTextOps(path, markerEditOps(prev, next));
    } catch (err: any) {
      console.warn('[source] marker edit rejected:', err?.message ?? err);
    }
  };
  /** A position typed into a range cell: null if it isn't one, else in bounds. */
  const position = (raw: string): number | null => {
    const n = Number(raw.trim());
    if (raw.trim() === '' || !Number.isInteger(n)) return null;
    return Math.max(0, Math.min(text.length, n));
  };

  const errorFor = (m: DocMarker): ValidationError | undefined => {
    const name = markerName(m);
    return errors.find(e =>
      (e.path.length === path.length + 1 && pathsEqual(e.path.slice(0, -1), path) && e.path[path.length] === name) ||
      (pathsEqual(e.path, path) && e.message.includes(`"${name}"`)));
  };

  return (
    <div className="source-marker-list">
      {markers.map((m, i) => {
        const err = errorFor(m);
        return (
          <div className="source-marker-row" key={`${markerName(m)}-${markerStart(m)}-${i}`}>
            <span className="source-marker-footnote" style={{ color: markerColor(i) }}>{footnoteLabel(i)}</span>
            <MarkerCell value={m.kind === 'block' ? `¶ ${m.block.type}` : m.name}
              title={m.kind === 'block' ? 'Block type' : 'Mark name'} editable={editable}
              onSave={(v) => {
                const name = v.replace(/^¶\s*/, '').trim();
                if (!name) return;
                apply(m, m.kind === 'block'
                  ? { ...m, block: { ...m.block, type: name } }
                  : { ...m, name });
              }} />
            {m.kind === 'block' ? (
              <MarkerCell value={String(m.index)} title="Position in the flat text" editable={editable}
                onSave={(v) => {
                  const n = position(v);
                  if (n === null || n === m.index) return;
                  apply(m, { ...m, index: n });
                }} />
            ) : (
              <span className="source-marker-range">
                [<MarkerCell value={String(m.start)} title="Range start" editable={editable}
                  onSave={(v) => { const n = position(v); if (n !== null && n <= m.end) apply(m, { ...m, start: n }); }} />
                , <MarkerCell value={String(m.end)} title="Range end" editable={editable}
                  onSave={(v) => { const n = position(v); if (n !== null && n >= m.start) apply(m, { ...m, end: n }); }} />)
              </span>
            )}
            {m.kind === 'block' ? (
              <>
                {/* A block's nesting depth IS its `parents` chain, so leaving it
                    out would hide the entire encoding of a nested list. */}
                <MarkerCell value={JSON.stringify(m.block.parents ?? [])}
                  title="Block parents — the nesting chain (JSON array)" editable={editable}
                  onSave={(v) => {
                    let parents: any;
                    try { parents = JSON.parse(v); } catch { return; }
                    if (!Array.isArray(parents) || parents.some(p => typeof p !== 'string')) return;
                    apply(m, { ...m, block: { ...m.block, parents } });
                  }} />
                <MarkerCell value={JSON.stringify(m.block.attrs ?? {})} title="Block attrs (JSON)" editable={editable}
                  onSave={(v) => {
                    let attrs: any;
                    try { attrs = JSON.parse(v); } catch { return; }
                    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return;
                    apply(m, { ...m, block: { ...m.block, attrs } });
                  }} />
              </>
            ) : (
              <MarkerCell value={typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}
                title="Mark value" editable={editable}
                onSave={(v) => apply(m, { ...m, value: reparseMarkValue(m.value, v) })} />
            )}
            {err && (
              <span className={'source-error-icon' + (err.kind === 'warning' ? '' : ' schema')} title={err.message}>
                {err.kind === 'warning' ? '⚠️' : '❌'}
              </span>
            )}
            {editable && (
              <button className="source-btn delete" title="Delete marker" onClick={() => apply(m, null)}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
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

function SourceNode({ name, value, path, depth, editable, markerSpans, onRichTextOps, onEdit, onDelete, onAdd, peerFocusedPaths, transports, onFocusPath, changedPaths, errors, revealPath }: NodeProps) {
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
            <PeerDot key={i} identityKey={peerIdentityKey(p.peerId, p.userGroupId)}
              direct={transports[p.peerId] === 'direct'}
              label={`${peerDisplayName(p.peerId, p.userGroupId)} is editing`}
              sizeClass="w-2 h-2 ml-1.5 align-middle" />
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
                    editable={editable} markerSpans={markerSpans} onRichTextOps={onRichTextOps}
                    onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
                    peerFocusedPaths={peerFocusedPaths} transports={transports} onFocusPath={onFocusPath} changedPaths={changedPaths} errors={errors} revealPath={revealPath} />
                ))
              : Object.keys(value).map((key) => (
                  <SourceNode key={key} name={key} value={value[key]} path={[...path, key]} depth={depth + 1}
                    editable={editable} markerSpans={markerSpans} onRichTextOps={onRichTextOps}
                    onEdit={onEdit} onDelete={onDelete} onAdd={onAdd}
                    peerFocusedPaths={peerFocusedPaths} transports={transports} onFocusPath={onFocusPath} changedPaths={changedPaths} errors={errors} revealPath={revealPath} />
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

  // Markers, if this field carries any. They are re-derived from spans rather
  // than read off the projection, which cannot see them at all.
  const spans = typeof value === 'string' ? markerSpans.get(pathKey) : undefined;
  const markers = useMemo(() => (spans ? markersFromSpans(spans) : []), [spans]);

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
        ) : markers.length > 0 ? (
          <span onClick={editable ? () => setEditing(true) : undefined}
            style={editable ? { cursor: 'pointer' } : undefined}>
            <MarkedString text={value} markers={markers} />
          </span>
        ) : (
          <span className={typeClass} onClick={editable ? () => setEditing(true) : undefined}
            style={editable ? { cursor: 'pointer' } : undefined}>
            {displayValue}
          </span>
        )}
        {exactFocusPeers.map((p, i) => (
          <PeerDot key={i} identityKey={peerIdentityKey(p.peerId, p.userGroupId)}
            direct={transports[p.peerId] === 'direct'}
            label={`${peerDisplayName(p.peerId, p.userGroupId)} is editing`}
            sizeClass="w-2 h-2 ml-1.5 align-middle" />
        ))}
        {editable && !editing && (
          <span className="source-actions">
            <button className="source-btn" onClick={() => setEditing(true)} title="Edit">&#9998;</button>
            {name !== null && <button className="source-btn delete" onClick={() => onDelete(path)} title="Delete">×</button>}
          </span>
        )}
      </div>
      {markers.length > 0 && (
        <MarkerList path={path} text={value} markers={markers}
          editable={editable} errors={errors} onRichTextOps={onRichTextOps} />
      )}
    </div>
  );
}

const EMPTY_SET: Set<string> = new Set();
const EMPTY_SPANS: Map<string, RichTextSpan[]> = new Map();

export function SourceTree({ data, editable = false, markerSpans, onRichTextOps, onEdit, onDelete, onAdd, peerFocusedPaths, onFocusPath, errors, revealPath }: SourceTreeProps) {
  const transports = usePeerTransports();
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
        markerSpans={markerSpans ?? EMPTY_SPANS}
        onRichTextOps={onRichTextOps || noop}
        onEdit={onEdit || noop}
        onDelete={onDelete || noop}
        onAdd={onAdd || noop}
        peerFocusedPaths={peerFocusedPaths || []}
        transports={transports}
        onFocusPath={onFocusPath || noop}
        changedPaths={changedPaths}
        errors={errors || []}
        revealPath={revealPath ?? null}
      />
    </div>
  );
}
