import { useEffect, useRef, useCallback, useContext } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { createContext } from 'preact';
import { cn } from "@/lib/utils";

const SheetCtx = createContext<{ onClose: () => void }>({ onClose: () => {} });

interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: any;
}

function Sheet({ open, onOpenChange, children }: SheetProps) {
  const handleClose = useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
  // Material bottom sheet: rounded top, raised surface tone, elevation, safe-area
  // inset, slide-up entrance. `max-h-[85vh]` is the common per-consumer default.
  bottom:
    "inset-x-0 bottom-0 bg-surface-container-low rounded-t-[28px] elevation-3 " +
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
        className={cn(
          "fixed z-[200] gap-4 p-6 overflow-y-auto outline-none",
          sideClasses[side],
          className,
        )}
      >
        {handleVisible && (
          <div className="mx-auto -mt-2 mb-3 h-1 w-8 rounded-full bg-outline-variant" aria-hidden="true" />
        )}
        <button
          className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          onClick={onClose}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          <span className="sr-only">Close</span>
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
