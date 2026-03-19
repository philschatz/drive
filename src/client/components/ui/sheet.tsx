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
  top: "inset-x-0 top-0 border-b",
  bottom: "inset-x-0 bottom-0 border-t",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
};

interface SheetContentProps {
  side?: Side;
  className?: string;
  children?: any;
}

function SheetContent({ side = "right", className, children }: SheetContentProps) {
  const { onClose } = useContext(SheetCtx);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    contentRef.current?.focus();
    return () => { prev?.focus(); };
  }, []);

  return (
    <>
      <div
        className="overlay fixed inset-0 z-[200] bg-black/80"
        onClick={onClose}
      />
      <div
        ref={contentRef}
        tabIndex={-1}
        className={cn(
          "fixed z-[200] gap-4 bg-background p-6 shadow-lg overflow-y-auto outline-none",
          sideClasses[side],
          className,
        )}
      >
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
