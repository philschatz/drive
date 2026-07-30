import { useEffect, useRef, useCallback, useContext } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { createContext } from 'preact';
import { cn } from "@/lib/utils";

const SheetCtx = createContext<{ onClose: () => void }>({ onClose: () => {} });

interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Chance to consume Escape before it closes the sheet — return true to keep
   * the sheet open (e.g. PropertySheet pops its detail pane back to the list).
   */
  onEscape?: () => boolean;
  children?: any;
}

/** Currently-open sheets, innermost last — so Escape only closes the topmost
 * one when sheets are layered (e.g. a colour picker over a formatting sheet). */
const openSheets: object[] = [];

function Sheet({ open, onOpenChange, onEscape, children }: SheetProps) {
  const handleClose = useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);

  const tokenRef = useRef({});
  // Kept in a ref so a fresh inline callback each render doesn't resubscribe.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    openSheets.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openSheets[openSheets.length - 1] !== token) return; // a sheet is on top of us
      // Something inside already handled it. `md-menu` (the select popup)
      // preventDefaults Escape to close itself but does NOT stopPropagation,
      // and keydown is composed — without this, dismissing an open select
      // would tear down the whole sheet underneath it.
      if (e.defaultPrevented) return;
      if (escapeRef.current?.()) {
        e.preventDefault();
        return;
      }
      handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = openSheets.indexOf(token);
      if (i !== -1) openSheets.splice(i, 1);
    };
  }, [open, handleClose]);

  if (!open) return null;

  return createPortal(
    <SheetCtx.Provider value={{ onClose: handleClose }}>
      {children}
    </SheetCtx.Provider>,
    document.body,
  );
}

type Side = "top" | "bottom" | "left" | "right";

const sideClasses: Record<Side, string> = {
  top: "inset-x-0 top-0 border-b bg-background rounded-b-none",
  // Material bottom sheet: rounded top, elevation, safe-area inset, slide-up
  // entrance. `max-h-[85vh]` is the common per-consumer default. `bg-sheet` is a
  // step above the grey page (`bg-page`) in both modes — near-white in light, dark
  // grey in dark — which is what makes it read as raised. (It is NOT `bg-surface`:
  // dark `surface` is the *dimmest* role, so that made the sheet darker than the
  // page. See --md-app-sheet in globals.css.)
  bottom:
    "inset-x-0 bottom-0 bg-sheet rounded-t-[28px] elevation-3 " +
    "pb-[env(safe-area-inset-bottom)] animate-[slideUp_220ms_cubic-bezier(0.05,0.7,0.1,1)]",
  left: "inset-y-0 left-0 h-full w-3/4 border-r bg-background sm:max-w-sm",
  right: "inset-y-0 right-0 h-full w-3/4 border-l bg-background sm:max-w-sm",
};

interface SheetContentProps {
  side?: Side;
  className?: string;
  /** Show the drag handle (bottom sheets only). Default true for `side="bottom"`. */
  showHandle?: boolean;
  children?: any;
}

function SheetContent({ side = "right", className, showHandle, children }: SheetContentProps) {
  const { onClose } = useContext(SheetCtx);
  const contentRef = useRef<HTMLDivElement>(null);
  const isBottom = side === "bottom";
  const handleVisible = showHandle ?? isBottom;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Child effects run first — if a field inside already grabbed focus
    // (e.g. TaskEditor's title), don't steal it back to the container.
    if (!contentRef.current?.contains(document.activeElement)) {
      contentRef.current?.focus();
    }
    return () => { prev?.focus(); };
  }, []);

  return (
    <>
      <div
        className="overlay fixed inset-0 z-[200] bg-black/50"
        onClick={onClose}
      />
      <div
        ref={contentRef}
        tabIndex={-1}
        // Marks this as overlay content: shared behaviours that react to page
        // scrolling (e.g. useHideOnScroll's toolbar hiding) ignore scrolling
        // that happens inside a sheet.
        data-overlay-content=""
        className={cn(
          "fixed z-[200] gap-4 p-6 overflow-y-auto outline-none",
          sideClasses[side],
          className,
        )}
      >
        {handleVisible && (
          <div className="mx-auto -mt-2 mb-3 h-1 w-8 rounded-full bg-outline-variant" aria-hidden="true" />
        )}
        {/* Same 40px circular target as the app-bar icon buttons. */}
        <button
          aria-label="Close"
          className="absolute right-2 top-2 inline-flex items-center justify-center h-10 w-10 rounded-full state-layer focus:outline-none"
          onClick={onClose}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>close</span>
        </button>
        {children}
      </div>
    </>
  );
}

function SheetHeader({ className, ...props }: any) {
  return (
    <div
      className={cn("flex flex-col space-y-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: any) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: any) {
  return (
    <h2
      className={cn("text-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: any) {
  return (
    <p
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
