import { BarIconButton } from '../../shared/DocumentTitleBar';

/**
 * Top bar shown while a cell is selected (focus mode). Replaces the shared
 * DocumentTitleBar: a checkmark returns to overview mode, undo/redo mirror the
 * overview bar, and the trailing button opens the text-formatting sheet.
 * Matches DocumentTitleBar's metrics (56px bar, 40px circular state-layer
 * buttons, Material Symbols icons).
 */
export function FocusTopBar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDone,
  onOpenFormat,
}: {
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
      <BarIconButton icon="check" label="Done" onClick={onDone} size={24} />
      {/* Right cluster mirrors the overview bar: undo/redo then the trailing action. */}
      <div className="flex items-center gap-1 sm:gap-1.5 ml-auto shrink-0">
        <BarIconButton icon="undo" label="Undo" onClick={onUndo} disabled={!canUndo} />
        <BarIconButton icon="redo" label="Redo" onClick={onRedo} disabled={!canRedo} />
        {onOpenFormat && (
          <BarIconButton icon="text_format" label="Text formatting" onClick={onOpenFormat} />
        )}
      </div>
    </div>
  );
}
