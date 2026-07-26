/**
 * Top bar shown while a cell is selected (focus mode). Replaces the shared
 * EditorTitleBar: a checkmark returns to overview mode, undo/redo mirror the
 * overview bar, and the trailing button opens the text-formatting sheet.
 * Matches EditorTitleBar's metrics (56px bar, 40px circular state-layer
 * buttons, Material Symbols icons).
 */

export function BarIconButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  size = 24,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  size?: number;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={
        'inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0 disabled:opacity-30' +
        (active ? ' bg-secondary-container text-on-secondary-container' : '')
      }
    >
      <span className="material-symbols-outlined" style={{ fontSize: size }}>{icon}</span>
    </button>
  );
}

export function FocusTopBar({
  cellLabel,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDone,
  onOpenFormat,
}: {
  /** A1-style address of the selection (e.g. "B2" or "A1:C3"). */
  cellLabel: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Commit any pending edit and return to overview mode. */
  onDone: () => void;
  /** Open the text-formatting sheet (absent while it isn't wired up). */
  onOpenFormat?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 pl-1 pr-2 min-h-14 w-full" data-testid="focus-top-bar">
      <BarIconButton icon="check" label="Done" onClick={onDone} />
      <BarIconButton icon="undo" label="Undo" onClick={onUndo} disabled={!canUndo} size={22} />
      <BarIconButton icon="redo" label="Redo" onClick={onRedo} disabled={!canRedo} size={22} />
      <span className="md-body-medium font-mono text-on-surface-variant truncate flex-1 min-w-0 text-center">
        {cellLabel}
      </span>
      {onOpenFormat && (
        <BarIconButton icon="format_color_text" label="Text formatting" onClick={onOpenFormat} size={22} />
      )}
    </div>
  );
}
