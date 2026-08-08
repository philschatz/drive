/**
 * One level of the document, as a Material list.
 *
 * The inspector used to render the whole document as a recursive indented tree.
 * That cannot work on a phone: indentation grows ~26px per level without bound,
 * nothing wrapped, the expand arrow was 16px wide, and the edit/delete buttons
 * were `opacity: 0` until `:hover` — which never happens on touch. So the tree is
 * navigated one level at a time instead, and each child is a full-width row big
 * enough to hit.
 *
 * A row's chevron is the honest signal for what a tap does: **chevron =
 * navigates** (a container, or a rich-text field with its own screen), no chevron
 * = opens a sheet.
 *
 * Beyond that a row does exactly one thing — delete — so it wears a trash icon
 * rather than a kebab, and a hold (or right-click, or Shift+F10) runs it. There
 * used to be an actions sheet here offering Open/Edit value alongside Delete, but
 * that first item was just what tapping the row already did. Both routes go
 * through the caller's confirmation, so nothing is destroyed by one gesture, and
 * a document you may only read gets neither the icon nor the hold.
 */
import { useMemo, useState } from 'preact/hooks';
import { MdTextField } from '@/components/ui/md-text-field';
import { Button } from '@/components/ui/button';
import { PeerDot } from '../common/PeerDot';
import { peerDisplayName, peerIdentityKey } from '../common/presence';
import { ListRow } from '../common/ListRow';
import { usePeerTransports, type PeerTransport } from '../worker-api';
import type { ValidationError } from '../../../shared/schemas';
import {
  KIND_ICON, KIND_LABEL, containerSummary, isContainer, nodeKind, valuePreview,
  isPrefix, pathsEqual, type NodeKind, type Path,
} from './source-nodes';
import './source.css';

/** A level this big gets a filter field; below it, scrolling is faster. */
const FILTER_THRESHOLD = 30;
/** Rows rendered before the "show all" cap. The count is always on screen, so
 * nothing is silently truncated. */
const ROW_CAP = 200;

export interface PeerFocus {
  path: Path;
  peerId: string;
  userGroupId?: string;
}

/** The colour class for a value's type — the secondary cue behind the glyph. */
const KIND_CLASS: Partial<Record<NodeKind, string>> = {
  string: 'src-string',
  richtext: 'src-string',
  number: 'src-number',
  boolean: 'src-boolean',
  null: 'src-null',
};

export interface RowTarget {
  path: Path;
  key: string | number;
  kind: NodeKind;
  value: any;
}

interface RowProps {
  target: RowTarget;
  editable: boolean;
  /** Marker count for a rich-text field, shown as a badge. */
  markerCount: number;
  changed: boolean;
  revealed: boolean;
  error?: ValidationError;
  hasDescendantError: boolean;
  peer?: PeerFocus;
  transports: Record<string, PeerTransport>;
  onPrimary: (t: RowTarget) => void;
  onDelete: (t: RowTarget) => void;
}

function NodeRow({
  target, editable, markerCount, changed, revealed, error, hasDescendantError,
  peer, transports, onPrimary, onDelete,
}: RowProps) {
  const { key, kind, value } = target;
  const navigates = isContainer(value) || kind === 'richtext';

  const summary = isContainer(value) ? containerSummary(value) : valuePreview(value);

  return (
    <ListRow
      data-testid="source-row"
      data-row-key={String(key)}
      data-kind={kind}
      className={(changed ? 'src-flash' : '') + (revealed ? ' src-revealed' : '')}
      // Greyed while a peer is in it, but never disabled — Automerge merges
      // concurrent edits, so the dot informs rather than locks.
      style={{ opacity: peer && pathsEqual(peer.path, target.path) ? 0.5 : undefined }}
      onTap={() => onPrimary(target)}
      // Empty on a read-only document, which is what leaves such a row with no
      // hold at all — the gesture used to fire regardless of `editable` and open
      // a sheet whose Delete then silently did nothing.
      actions={editable
        ? [{ icon: 'delete', label: 'Delete', title: `Delete ${key}`,
             testId: 'row-delete', onSelect: () => onDelete(target) }]
        : []}
      end={
        <>
          {markerCount > 0 && (
            <span
              className="md-label-large text-on-secondary-container bg-secondary-container rounded-full px-2"
              data-testid="marker-count"
              title={`${markerCount} rich-text ${markerCount === 1 ? 'marker' : 'markers'}`}
            >
              {markerCount}
            </span>
          )}
          {/* The message itself is in the problem list at the top of the page — this
              is the pointer to it, not the only place it exists. Dimmed when the
              problem is further down, so "wrong here" and "wrong inside" differ.
              Warnings take the yellow, the same language the problem list wears. */}
          {(error || hasDescendantError) && (
            <span
              className="material-symbols-outlined"
              data-testid="row-error"
              style={{
                fontSize: 20,
                opacity: error ? 1 : 0.45,
                color: error && (!error.kind || error.kind === 'schema')
                  ? 'var(--md-sys-color-error)'
                  : 'var(--src-warn-edge)',
              }}
              aria-label={error?.message ?? 'Contains validation problems'}
              title={error?.message ?? 'Contains validation problems'}
            >
              {error && (!error.kind || error.kind === 'schema') ? 'error' : 'warning'}
            </span>
          )}
          {peer && (
            <PeerDot
              identityKey={peerIdentityKey(peer.peerId, peer.userGroupId)}
              direct={transports[peer.peerId] === 'direct'}
              label={`${peerDisplayName(peer.peerId, peer.userGroupId)} is editing`}
            />
          )}
          {navigates && <md-icon aria-hidden="true">chevron_right</md-icon>}
        </>
      }
    >
      <md-icon slot="start" aria-label={KIND_LABEL[kind]} title={KIND_LABEL[kind]}>
        {KIND_ICON[kind]}
      </md-icon>
      <div slot="headline" className="src-mono truncate">{key}</div>
      <div slot="supporting-text" className={`src-mono truncate ${KIND_CLASS[kind] ?? ''}`}>
        {summary}
      </div>
    </ListRow>
  );
}

export function LevelList({
  levelPath, value, editable, richPaths, markerCounts, selectedKey,
  changedPaths, errors, peerFocusedPaths, onPrimary, onDelete,
}: {
  levelPath: Path;
  value: any;
  editable: boolean;
  /** Path keys of the string fields that carry rich-text markers. */
  richPaths: Set<string>;
  markerCounts: Map<string, number>;
  selectedKey: string | number | null;
  changedPaths: Set<string>;
  errors: ValidationError[];
  peerFocusedPaths: PeerFocus[];
  onPrimary: (t: RowTarget) => void;
  onDelete: (t: RowTarget) => void;
}) {
  const transports = usePeerTransports();
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  const isArray = Array.isArray(value);

  const targets = useMemo<RowTarget[]>(() => {
    const keys: Array<string | number> = isArray
      ? (value as any[]).map((_, i) => i)
      : Object.keys(value ?? {});
    return keys.map((key) => {
      const path = [...levelPath, key];
      const child = (value as any)[key];
      return {
        path, key,
        kind: nodeKind(child, richPaths.has(path.join('/'))),
        value: child,
      };
    });
  }, [value, levelPath, richPaths, isArray]);

  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? targets.filter(t => String(t.key).toLowerCase().includes(needle)
        || valuePreview(t.value, 200).toLowerCase().includes(needle))
    : targets;
  const shown = showAll ? filtered : filtered.slice(0, ROW_CAP);

  /** The peer to dot on this row: one editing it, or anything inside it. */
  const peerFor = (path: Path) =>
    peerFocusedPaths.find(p => pathsEqual(p.path, path))
    ?? peerFocusedPaths.find(p => isPrefix(path, p.path));

  const errorFor = (path: Path) => errors.find(e => pathsEqual(e.path, path));
  const descendantError = (path: Path) => errors.some(e => isPrefix(path, e.path));

  return (
    <div data-testid="source-level">
      {targets.length >= FILTER_THRESHOLD && (
        <div className="mt-2 mb-1">
          <MdTextField
            label={`Filter ${targets.length} ${isArray ? 'items' : 'keys'}`}
            value={filter}
            data-testid="level-filter"
            onInput={setFilter}
          />
        </div>
      )}

      <md-list style={{ background: 'transparent' }}>
        {shown.map(t => (
          <NodeRow
            key={String(t.key)}
            target={t}
            editable={editable}
            markerCount={markerCounts.get(t.path.join('/')) ?? 0}
            changed={changedPaths.has(t.path.join('/'))}
            revealed={selectedKey !== null && t.key === selectedKey}
            error={errorFor(t.path)}
            hasDescendantError={!errorFor(t.path) && descendantError(t.path)}
            peer={peerFor(t.path)}
            transports={transports}
            onPrimary={onPrimary}
            onDelete={onDelete}
          />
        ))}
      </md-list>

      {filtered.length > shown.length && (
        <div className="px-2 py-2">
          <Button variant="outline" data-testid="level-show-all" onClick={() => setShowAll(true)}>
            Show all {filtered.length}
          </Button>
        </div>
      )}

      {targets.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 px-2">
          {isArray ? 'Empty array.' : 'No properties.'}
        </p>
      )}
      {targets.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 px-2">Nothing matches “{filter}”.</p>
      )}
    </div>
  );
}
