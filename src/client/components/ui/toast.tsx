import * as ToastPrimitive from "@radix-ui/react-toast";
import { useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Imperative API — call from anywhere, no hooks required            */
/* ------------------------------------------------------------------ */

type ToastFn = (message: string) => void;
let _show: ToastFn | null = null;

/** Register the callback (called once by <Toaster>). */
export function _registerShow(fn: ToastFn) {
  _show = fn;
}

/** Show a toast from any module. Requires <Toaster> mounted in the tree. */
export function showToast(message: string) {
  if (_show) _show(message);
}

/* ------------------------------------------------------------------ */
/*  Declarative component — mount once in App                         */
/* ------------------------------------------------------------------ */

interface ToastItem {
  id: number;
  message: string;
}

let nextId = 0;

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const durMs = useRef(2000);

  const add = useCallback((message: string) => {
    setToasts((prev) => [...prev, { id: nextId++, message }]);
  }, []);

  // Register the imperative bridge once
  _registerShow(add);

  const remove = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastPrimitive.Provider duration={durMs.current}>
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          className={cn(
            "group pointer-events-auto relative flex w-full items-center justify-between gap-2 overflow-hidden",
            "rounded-lg border border-border bg-background px-4 py-3 shadow-lg",
            "data-[state=open]:animate-[slideIn_150ms_ease-out]",
            "data-[state=closed]:animate-[fadeOut_100ms_ease-in]",
            "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
            "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
            "data-[swipe=end]:animate-[swipeOut_100ms_ease-out]",
          )}
          onOpenChange={(open: boolean) => {
            if (!open) remove(t.id);
          }}
        >
          <ToastPrimitive.Description className="text-sm text-foreground">
            {t.message}
          </ToastPrimitive.Description>
          <ToastPrimitive.Close
            className="ml-2 shrink-0 rounded-md p-1 opacity-50 hover:opacity-100 focus:outline-none"
            aria-label="Close"
          >
            <span className="text-xs">&times;</span>
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}

      <ToastPrimitive.Viewport
        className={cn(
          "fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col gap-2",
          "w-auto max-w-[min(420px,calc(100vw-32px))]",
        )}
      />
    </ToastPrimitive.Provider>
  );
}
