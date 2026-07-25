import * as ToastPrimitive from "@radix-ui/react-toast";
import { useState } from "preact/hooks";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Toast model                                                       */
/* ------------------------------------------------------------------ */

export type ToastTone = "default" | "destructive" | "warning";

export interface ToastSpec {
  message: string;
  tone?: ToastTone;
  /** Material-symbols icon name (e.g. 'error', 'warning', 'update'). */
  icon?: string;
  /** Auto-dismiss delay in ms. `null` = persistent (stays until dismissed). */
  durationMs?: number | null;
  /** Trailing action button. */
  action?: { label: string; onClick: () => void };
  /** Called when the user dismisses (close button / swipe). */
  onDismiss?: () => void;
  /** Optional test id set on the toast root (for E2E locators). */
  testId?: string;
}

interface ToastItem extends ToastSpec {
  id: number;
  /** Stable key for keyed upsert/removal (persistent, state-driven notices). */
  key?: string;
}

const DEFAULT_DURATION_MS = 2000;

/* ------------------------------------------------------------------ */
/*  Imperative API — call from anywhere, no hooks required            */
/*  (requires <Toaster> mounted in the tree)                          */
/* ------------------------------------------------------------------ */

type Mutator = (fn: (prev: ToastItem[]) => ToastItem[]) => void;
let _mutate: Mutator | null = null;
let nextId = 0;

/** Show a transient toast. Back-compatible: `showToast("Saved")`. */
export function showToast(message: string, spec: Omit<ToastSpec, "message"> = {}) {
  _mutate?.((prev) => [...prev, { id: nextId++, message, ...spec }]);
}

/**
 * Create/update (or remove, when `spec` is null) a toast identified by a stable
 * key. Use for persistent, state-driven notices (worker crash, multi-tab, update)
 * so re-renders don't stack duplicates and the notice can be cleared when the
 * underlying condition clears.
 */
export function upsertToast(key: string, spec: ToastSpec | null) {
  _mutate?.((prev) => {
    const rest = prev.filter((t) => t.key !== key);
    return spec ? [...rest, { id: nextId++, key, ...spec }] : rest;
  });
}

/* ------------------------------------------------------------------ */
/*  Declarative component — mount once in App                         */
/* ------------------------------------------------------------------ */

const TONE_CLASSES: Record<ToastTone, string> = {
  default: "border border-border bg-popover text-popover-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  // Amber reads as "warning" independent of the MD3 palette; black text keeps
  // it legible in both light and dark toast contexts.
  warning: "bg-amber-500 text-black",
};

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Register the imperative bridge (idempotent across renders).
  _mutate = setToasts;

  const remove = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastPrimitive.Provider duration={DEFAULT_DURATION_MS}>
      {toasts.map((t) => {
        const tone = t.tone ?? "default";
        return (
          <ToastPrimitive.Root
            key={t.id}
            data-testid={t.testId}
            // `null` → persistent (Radix skips the auto-close timer for Infinity).
            duration={t.durationMs === null ? Infinity : t.durationMs}
            onOpenChange={(open: boolean) => {
              if (!open) {
                t.onDismiss?.();
                remove(t.id);
              }
            }}
            className={cn(
              "group pointer-events-auto relative flex w-full items-center gap-3 overflow-hidden",
              "rounded-lg px-4 py-2.5 shadow-lg",
              TONE_CLASSES[tone],
              "data-[state=open]:animate-[slideIn_150ms_ease-out]",
              "data-[state=closed]:animate-[fadeOut_100ms_ease-in]",
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
              "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform",
              "data-[swipe=end]:animate-[swipeOut_100ms_ease-out]",
            )}
          >
            {t.icon && (
              <span className="material-symbols-outlined shrink-0 text-base">{t.icon}</span>
            )}
            <ToastPrimitive.Description className="min-w-0 flex-1 text-sm">
              {t.message}
            </ToastPrimitive.Description>
            {t.action && (
              <ToastPrimitive.Action altText={t.action.label} asChild>
                <button
                  className="shrink-0 rounded border border-current px-2 py-0.5 text-sm font-medium hover:bg-current/10"
                  onClick={t.action.onClick}
                >
                  {t.action.label}
                </button>
              </ToastPrimitive.Action>
            )}
            <ToastPrimitive.Close
              className="ml-1 shrink-0 opacity-70 hover:opacity-100 focus:outline-none"
              aria-label="Dismiss"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}

      {/* Floating, centered, capped width with a clear gap on both sides so the
          user sees it overlaying — not part of — the page. */}
      <ToastPrimitive.Viewport
        className={cn(
          "fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col gap-2",
          "w-[calc(100%-4rem)] max-w-lg",
        )}
      />
    </ToastPrimitive.Provider>
  );
}
