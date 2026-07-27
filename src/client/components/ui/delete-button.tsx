import { cn } from "@/lib/utils";

export interface DeleteButtonProps {
  /** The actual delete/revoke action, called only after the user confirms. */
  onConfirm: () => void;
  /** Text shown in the native confirm() prompt. */
  confirmMessage: string;
  /** Tooltip / aria-label for the trigger button. Default "Delete". */
  tooltip?: string;
  disabled?: boolean;
  /** Overrides for the trigger button (size/color per site). */
  className?: string;
  /** material-symbols icon font size. Default 16. */
  iconSize?: number;
  /** material-symbols icon name. Default "delete" (trash can). */
  icon?: string;
}

/**
 * Reusable trash-can delete button. Always runs a native confirm() prompt
 * before invoking onConfirm. Used across home, members panel, devices list,
 * and friends so destructive actions look and behave the same.
 */
export function DeleteButton({
  onConfirm,
  confirmMessage,
  tooltip = "Delete",
  disabled,
  className,
  iconSize = 16,
  icon = "delete",
}: DeleteButtonProps) {
  const handleClick = () => {
    if (!confirm(confirmMessage)) return;
    onConfirm();
  };

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center h-7 w-7 rounded-md text-destructive hover:bg-destructive/10 cursor-pointer disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      title={tooltip}
      aria-label={tooltip}
      disabled={disabled}
      onClick={handleClick}
    >
      <span className="material-symbols-outlined" style={{ fontSize: iconSize }}>{icon}</span>
    </button>
  );
}
