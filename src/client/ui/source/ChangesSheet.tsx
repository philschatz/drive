/**
 * The Changes sheet: every version, and the operations inside one of them.
 *
 * These are two halves of one job — "what changed, and where" — so they are two
 * panes of one sheet rather than a sheet and a panel. Picking a version previews
 * it live behind the sheet (the worker pins the subscription) *and* loads its
 * operations, because on this screen those are the same act. Tapping an operation
 * navigates the document to its path and closes the sheet, which is what makes
 * the op log a way to get somewhere rather than a wall of text.
 *
 * The predecessor put the operations in a three-column `<table>` under the tree,
 * styled by a stylesheet nothing imported — so it shipped as an unstyled
 * light-theme table beneath a hard-coded dark tree. There is no table here: an op
 * is a list row whose value wraps.
 *
 * Not `common/VersionHistorySheet`: that one is the shared surface for every other
 * editor and has no second pane. Bending it for the one caller that needs
 * operations would cost more than the version list it duplicates.
 */
import { useCallback, useState } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useConfirm } from '../common/ConfirmSheet';
import { cn } from '@/lib/utils';
import { relativeTime } from '../../../shared/relative-time';
import type { DocumentHistory } from '../common/useDocumentHistory';
import type { Path } from './source-nodes';

// ---------------------------------------------------------------------------
// Patch formatting
// ---------------------------------------------------------------------------

export function formatPatchPath(path: Path): string {
  if (path.length === 0) return '(root)';
  return path.map(p => typeof p === 'number' ? `[${p}]` : p).join('.');
}

function formatPatchValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return Array.isArray(value) ? '[]' : '{}';
  return JSON.stringify(value);
}

/**
 * An `insert` into a text field whose value is a map IS a block marker —
 * Automerge inserts an empty map at the marker's position and fills it in with
 * later `put` patches. Only in that position, though: a `put` of a map is an
 * ordinary object (a block's own `attrs`, say), and labelling those as markers
 * too is worse than saying nothing.
 */
function formatInsertedValue(value: unknown): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? '¶ block marker'
    : formatPatchValue(value);
}

/** `strong=true, link={"href":…}` — the mark set riding along with an insert. */
function formatMarkSet(marks: Record<string, unknown> | undefined): string {
  if (!marks) return '';
  const entries = Object.entries(marks);
  if (entries.length === 0) return '';
  return entries.map(([name, v]) => `${name}=${formatPatchValue(v)}`).join(', ');
}

/**
 * What one patch did, as one line.
 *
 * Automerge reports a mark and an unmark as their own patch actions carrying a
 * range, and inserted text can carry an inherited mark set — none of which the
 * generic value formatter can show, so a formatting change used to appear as a
 * bare row with an empty value. Block markers need the same treatment: they
 * arrive as an `insert` of a map, which reads as `{}`.
 */
export function formatPatchDetail(p: any): string {
  switch (p.action) {
    case 'put':
      return formatPatchValue(p.value);
    case 'del':
      return p.length > 1 ? `×${p.length}` : '';
    case 'insert': {
      const values = (p.values ?? []).map((v: unknown) => formatInsertedValue(v)).join(', ');
      const marks = formatMarkSet(p.marks);
      return marks ? `${values} (${marks})` : values;
    }
    case 'splice': {
      // Show the block-marker character rather than letting it render as tofu.
      const text = JSON.stringify(String(p.value ?? '')).replace(/￼/g, '\\uFFFC');
      const marks = formatMarkSet(p.marks);
      return marks ? `${text} (${marks})` : text;
    }
    case 'mark':
      return (p.marks ?? [])
        .map((m: any) => `${m.name}=${formatPatchValue(m.value)} [${m.start}, ${m.end})`)
        .join(', ');
    case 'unmark':
      return `${p.name} [${p.start}, ${p.end})`;
    case 'inc':
      return p.value > 0 ? `+${p.value}` : String(p.value);
    default:
      return '';
  }
}

/** Glyph + colour role per patch action, so a scan reads as adds vs removes. */
const ACTION_STYLE: Record<string, { icon: string; role: string }> = {
  put: { icon: 'edit', role: 'primary' },
  del: { icon: 'delete', role: 'error' },
  insert: { icon: 'add', role: 'primary' },
  splice: { icon: 'text_fields', role: 'tertiary' },
  mark: { icon: 'format_ink_highlighter', role: 'tertiary' },
  unmark: { icon: 'format_clear', role: 'tertiary' },
  inc: { icon: 'exposure_plus_1', role: 'primary' },
};

// ---------------------------------------------------------------------------

export function ChangesSheet({
  open, history, patches, canRestore, onClose, onNavigate,
}: {
  open: boolean;
  history: DocumentHistory;
  /** Patches for `history.version` — the caller loads them as the version changes. */
  patches: any[];
  /**
   * Write access to the document — deliberately NOT `history.editable`, which
   * means "the version on screen is writable" and is therefore false exactly when
   * a past version is being previewed, i.e. the only time Restore has anything to
   * offer.
   */
  canRestore: boolean;
  onClose: () => void;
  /** Go to a patch's path in the document (and close). */
  onNavigate: (path: Path) => void;
}) {
  const { entries, version, changeCount, restoreToVersion, onSliderChange } = history;
  // Which pane: the version list, or one version's operations.
  const [detail, setDetail] = useState(false);
  const { confirm, confirmSheet } = useConfirm();

  const latestVersion = entries.length - 1;
  const time = entries[version]?.time;

  const handleRestore = useCallback(async (target: number) => {
    if (!await confirm({
      title: `Restore to version ${target + 1}?`,
      body: 'This adds a new change that reverts everything after it. Nothing is erased.',
      confirmLabel: 'Restore',
    })) return;
    await restoreToVersion(target);
    onClose();
  }, [confirm, restoreToVersion, onClose]);

  // Escape pops operations → the version list, rather than closing outright.
  const handleEscape = useCallback(() => {
    if (!detail) return false;
    setDetail(false);
    return true;
  }, [detail]);

  if (!open) return null;

  return (
    <>
      <Sheet open onOpenChange={(o: boolean) => { if (!o) onClose(); }} onEscape={handleEscape}>
        <SheetContent side="bottom" className="max-h-[85vh] p-4 flex flex-col">
          <SheetHeader>
            <div className="flex items-center gap-1 pr-8">
              {detail && (
                <button
                  aria-label="Back to versions"
                  data-testid="ops-back"
                  className="inline-flex items-center justify-center h-10 w-10 -ml-2 rounded-full state-layer shrink-0 focus:outline-none"
                  onClick={() => setDetail(false)}
                >
                  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 24 }}>
                    arrow_back
                  </span>
                </button>
              )}
              <SheetTitle className="truncate">
                {detail
                  ? `Version ${version + 1}${time ? ` · ${relativeTime(new Date(time * 1000))}` : ''}`
                  : `Version history (${changeCount})`}
              </SheetTitle>
            </div>
          </SheetHeader>

          {detail ? (
            <div className="min-h-0 flex-1 overflow-y-auto mt-2" data-testid="changes-ops">
              <div className="flex items-center gap-2 px-2">
                <span className="md-body-medium text-on-surface-variant flex-1">
                  {patches.length} {patches.length === 1 ? 'operation' : 'operations'}
                </span>
                {canRestore && version !== latestVersion && (
                  <Button
                    size="sm" variant="outline" data-testid="ops-restore"
                    onClick={() => handleRestore(version)}
                  >
                    Restore
                  </Button>
                )}
              </div>

              <md-list style={{ background: 'transparent' }}>
                {patches.map((p, i) => {
                  const style = ACTION_STYLE[p.action] ?? { icon: 'change_history', role: 'on-surface-variant' };
                  const detailText = formatPatchDetail(p);
                  return (
                    <md-list-item
                      key={i}
                      type="button"
                      data-testid="op-row"
                      data-action={p.action}
                      // The path is where this op landed, so it is also where to go.
                      onClick={() => onNavigate(p.path ?? [])}
                    >
                      <md-icon slot="start" style={{ color: `var(--md-sys-color-${style.role})` }}>
                        {style.icon}
                      </md-icon>
                      <div slot="headline" className="src-mono">
                        <span className="uppercase text-xs font-semibold mr-2" style={{ color: `var(--md-sys-color-${style.role})` }}>
                          {p.action}
                        </span>
                        {formatPatchPath(p.path ?? [])}
                      </div>
                      {detailText && (
                        <div slot="supporting-text" className="src-mono break-all">{detailText}</div>
                      )}
                      <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
                    </md-list-item>
                  );
                })}
              </md-list>
              {patches.length === 0 && (
                <p className="text-sm text-muted-foreground py-4 px-2">
                  No operations recorded for this version.
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Scrubbing and tapping a row drive the same `version`, so the two
                  never disagree about what is being previewed. */}
              {changeCount > 1 && (
                <div className="mt-3 flex items-center">
                  <input
                    type="range"
                    className="flex-1 min-w-0 h-1 accent-primary"
                    aria-label="Version"
                    min={0}
                    max={changeCount - 1}
                    value={version}
                    onInput={(e: any) => onSliderChange(parseInt(e.target.value))}
                  />
                </div>
              )}

              <div
                className="mt-3 -mx-2 min-h-0 flex-1 overflow-y-auto divide-y divide-border"
                data-testid="changes-versions"
              >
                {/* Newest first — copy before reversing (entries is shared state). */}
                {[...entries].reverse().map((entry) => {
                  const isCurrent = entry.version === version;
                  const isLatest = entry.version === latestVersion;
                  return (
                    <div
                      key={entry.version}
                      className={cn('flex items-center gap-2 px-2', isCurrent && 'bg-muted/50 rounded')}
                    >
                      <button
                        className="flex-1 text-left py-3 min-w-0"
                        data-testid="version-row"
                        data-version={entry.version}
                        // One tap: preview this version and read what it did.
                        onClick={() => { onSliderChange(entry.version); setDetail(true); }}
                      >
                        <span className="md-body-large font-medium tabular-nums">{entry.version + 1}</span>
                        {isLatest && <span className="ml-2 text-xs text-muted-foreground">(latest)</span>}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {relativeTime(new Date(entry.time * 1000))}
                        </span>
                      </button>
                      <md-icon aria-hidden="true" className="text-muted-foreground">chevron_right</md-icon>
                    </div>
                  );
                })}
                {entries.length === 0 && (
                  <p className="text-sm text-muted-foreground py-4 px-2">No history yet.</p>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      {confirmSheet}
    </>
  );
}
