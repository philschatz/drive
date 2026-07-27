import type { ValidationError } from '../../../shared/schemas';
import { docUrl, encodeRestPath } from './doc-urls';
import './validation-panel.css';

interface ValidationPanelProps {
  errors: ValidationError[];
  onClickError?: (error: ValidationError) => void;
  /** When provided, errors link to the editor at the error's automerge path */
  docId?: string;
  variant?: 'light' | 'dark';
}

function kindIcon(kind: ValidationError['kind']) {
  return kind === 'dependency' || kind === 'warning' ? '\u26A0\uFE0F' : '\u274C';
}

export function ValidationPanel({ errors, onClickError, docId, variant = 'light' }: ValidationPanelProps) {
  if (errors.length === 0) return null;

  const label = `${errors.length} validation ${errors.length === 1 ? 'error' : 'errors'}`;
  const clickable = !!onClickError;

  if (variant === 'dark') {
    return (
      <div className="validation-panel-dark">
        <div className="validation-panel-header">{label}</div>
        <ul className="validation-panel-list">
          {errors.map((err, i) => (
            <li
              key={i}
              className="validation-panel-item"
              onClick={() => onClickError?.(err)}
              style={clickable ? undefined : { cursor: 'default' }}
            >
              <span className="validation-panel-kind">{kindIcon(err.kind)}</span>
              <span className="validation-panel-path">{err.path.join(' > ')}</span>
              <span className="validation-panel-msg">{err.message}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 text-sm mb-2" style={{ maxHeight: '20rem', display: 'flex', flexDirection: 'column' }}>
      <div className="px-3 py-2 font-semibold text-amber-700 bg-amber-100/50 border-b border-amber-200 shrink-0">
        {label}
      </div>
      <ul className="divide-y divide-amber-200 overflow-y-auto" style={{ minHeight: 0 }}>
        {errors.map((err, i) => {
          const href = docId ? docUrl(docId, encodeRestPath(err.path)) : undefined;
          return (
            <li
              key={i}
              className="flex gap-2 px-3 py-1.5 hover:bg-amber-100/50 text-amber-900"
              onClick={() => onClickError?.(err)}
              style={{ cursor: clickable || href ? 'pointer' : 'default' }}
            >
              <span className="shrink-0 text-xs">{kindIcon(err.kind)}</span>
              {href ? (
                <a href={href} className="shrink-0 font-mono text-xs text-amber-600 underline">{err.path.join(' > ')}</a>
              ) : (
                <span className="shrink-0 font-mono text-xs text-amber-600">{err.path.join(' > ')}</span>
              )}
              <span className="text-amber-800">{err.message}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
