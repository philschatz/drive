/**
 * Validation problems, scoped to where you are in the document.
 *
 * Two things were wrong with the shared panel this replaces. It was an amber
 * Tailwind card with `text-xs` paths and hover-only affordances — the one surface
 * on the page that ignored the MD3 palette, so it did not follow the OS theme and
 * its rows were too small to hit. And it listed *every* error in the document at
 * every level, so on a document with twenty problems it buried the one you had
 * navigated to.
 *
 * So: Material rows sized for a thumb, the message as real wrapping text rather
 * than a tooltip, and a list that contains **only** the problems in the subtree on
 * screen — no toggle, no exceptions, so the count can be read as "problems here"
 * without checking what mode the list is in. What lies outside is one row away and
 * counted, and that row goes to the root, where the subtree is the whole document
 * and every problem is therefore in scope.
 */
import { useMemo } from 'preact/hooks';
import type { ValidationError } from '../../../shared/schemas';
import { isPrefix, pathsEqual, type Path } from './source-nodes';
import './source.css';

/**
 * Severity, as the icon. The surface is yellow either way — it says "there is a
 * problem here"; the icon says how bad: red for a violation, amber for a warning
 * or a soft dependency check.
 */
function tone(kind: ValidationError['kind']): { icon: string; color: string } {
  return kind === 'warning' || kind === 'dependency'
    ? { icon: 'warning', color: 'var(--src-warn-edge)' }
    : { icon: 'error', color: 'var(--md-sys-color-error)' };
}

/** How to name an error's location from where the reader is standing. */
function relativeLabel(errPath: Path, here: Path): string {
  if (pathsEqual(errPath, here)) return 'here';
  const rest = errPath.slice(here.length);
  return (rest.length ? rest : errPath).join(' / ') || 'here';
}

export function ValidationList({
  errors, path, onNavigate,
}: {
  errors: ValidationError[];
  /** The level (or field) currently on screen — the filter. */
  path: Path;
  onNavigate: (path: Path) => void;
}) {
  const here = useMemo(
    () => errors.filter(e => pathsEqual(e.path, path) || isPrefix(path, e.path)),
    [errors, path],
  );
  const elsewhere = errors.length - here.length;

  if (errors.length === 0) return null;

  /**
   * The way to the rest of them: the document root, where the subtree in scope is
   * the whole document. Navigation rather than a mode, so this list only ever
   * shows one thing.
   */
  const elsewhereRow = (
    <md-list-item type="button" data-testid="validation-elsewhere" onClick={() => onNavigate([])}>
      <md-icon slot="start" style={{ color: 'var(--src-warn-edge)' }}>warning</md-icon>
      <div slot="headline">
        {elsewhere} {elsewhere === 1 ? 'problem' : 'problems'} elsewhere in this document
      </div>
      <md-icon slot="end" aria-hidden="true">chevron_right</md-icon>
    </md-list-item>
  );

  // Nothing wrong in this subtree: stay quiet. The yellow surface means "there is a
  // problem *here*", so wearing it where there isn't one would cry wolf.
  if (here.length === 0) {
    return (
      <div className="mt-2" data-testid="validation-list">
        <md-list style={{ background: 'transparent' }}>{elsewhereRow}</md-list>
      </div>
    );
  }

  const worst = here.some(e => !e.kind || e.kind === 'schema')
    ? { icon: 'error', color: 'var(--md-sys-color-error)' }
    : { icon: 'warning', color: 'var(--src-warn-edge)' };

  return (
    <div className="src-warn mt-2 overflow-hidden" data-testid="validation-list">
      <div className="flex items-center gap-2 px-3 pt-2">
        <span
          className="material-symbols-outlined"
          aria-hidden="true"
          style={{ fontSize: 20, color: worst.color }}
        >
          {worst.icon}
        </span>
        <span className="md-label-large flex-1" data-testid="validation-count">
          {here.length} {here.length === 1 ? 'problem' : 'problems'}
          {path.length ? ` in ${path.join(' / ')}` : ' in this document'}
        </span>
      </div>

      <md-list>
        {here.map((err, i) => {
          const t = tone(err.kind);
          return (
            <md-list-item
              key={i}
              type="button"
              data-testid="validation-row"
              // The path is where the problem is, so it is also where to go.
              onClick={() => onNavigate(err.path)}
            >
              <md-icon slot="start" style={{ color: t.color }}>{t.icon}</md-icon>
              <div slot="headline" className="src-mono" style={{ color: 'var(--src-warn-fg)' }}>
                {relativeLabel(err.path, path)}
              </div>
              {/* The message itself, wrapping — it used to be a `title` tooltip,
                  which on touch means it did not exist. */}
              <div slot="supporting-text" style={{ whiteSpace: 'normal', color: 'var(--src-warn-muted)' }}>
                {err.message}
              </div>
              <md-icon slot="end" aria-hidden="true" style={{ color: 'var(--src-warn-muted)' }}>
                chevron_right
              </md-icon>
            </md-list-item>
          );
        })}
      </md-list>

      {elsewhere > 0 && (
        <md-list>
          <md-divider role="separator" />
          {elsewhereRow}
        </md-list>
      )}
    </div>
  );
}
