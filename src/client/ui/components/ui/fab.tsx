/**
 * Material Design 3 Floating Action Button.
 *
 * Wraps `@material/web`'s `md-fab` and pins it to the bottom-right of the viewport
 * (safe-area aware). Used on every list screen that can add items (Home, Tasks,
 * Counters, Calendar). `z-30` sits below the Sheet overlay (`z-[200]`) and Toaster
 * (`z-[100]`) so an open bottom sheet correctly covers the FAB.
 *
 * Icons are passed as slotted `.material-symbols-outlined` spans (light-DOM slotted
 * content is styled by the outer document, so it reuses the app's icon-font setup).
 */
import type { JSX } from 'preact';
import { cn } from '@/lib/utils';

interface FabProps {
  /** Material Symbols icon name (e.g. 'add'). */
  icon: string;
  /** Accessible label — required (the FAB has no visible text unless `label` is set). */
  'aria-label': string;
  onClick?: (e: MouseEvent) => void;
  /** Extended-FAB text label shown beside the icon. */
  label?: string;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'surface';
  size?: 'small' | 'medium' | 'large';
  /** Extra classes on the fixed positioning wrapper. */
  className?: string;
  style?: JSX.CSSProperties;
}

export function Fab({
  icon,
  'aria-label': ariaLabel,
  onClick,
  label,
  variant = 'primary',
  size = 'medium',
  className,
  style,
}: FabProps) {
  return (
    <div
      className={cn('fixed z-30', className)}
      style={{
        right: 'calc(1rem + env(safe-area-inset-right))',
        bottom: 'calc(1rem + env(safe-area-inset-bottom))',
        ...style,
      }}
    >
      <md-fab
        variant={variant}
        size={size}
        label={label}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        <span slot="icon" className="material-symbols-outlined" style={{ fontSize: 24 }}>
          {icon}
        </span>
      </md-fab>
    </div>
  );
}
