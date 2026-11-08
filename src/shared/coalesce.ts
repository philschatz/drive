/**
 * Coalesce a burst of calls into a few deliveries: the latest value goes out
 * once the calls pause for `wait` ms, and at least every `maxWait` ms while they
 * keep coming — a debounce that cannot starve. A scrub (slider drag, version
 * list scroll) calls once per pixel; the consumer wants the version the user is
 * looking at, not every one they passed.
 */
export interface Coalescer<T> {
  (value: T): void;
  /** Deliver a pending value now (no-op when nothing is pending). */
  flush(): void;
  /** Drop a pending value. */
  cancel(): void;
  readonly pending: boolean;
}

export function coalesce<T>(
  deliver: (value: T) => void,
  { wait, maxWait }: { wait: number; maxWait: number },
): Coalescer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let latest: T | undefined;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    if (deadline !== null) clearTimeout(deadline);
    timer = deadline = null;
  };
  const fire = () => {
    clear();
    if (!pending) return;
    pending = false;
    const value = latest as T;
    latest = undefined;
    deliver(value);
  };

  const fn = ((value: T) => {
    latest = value;
    pending = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, wait);
    // The deadline is armed by the first call of a burst and only cleared by a
    // delivery, so a burst that never pauses still delivers every `maxWait`.
    if (deadline === null) deadline = setTimeout(fire, maxWait);
  }) as Coalescer<T>;
  fn.flush = fire;
  fn.cancel = () => { clear(); pending = false; latest = undefined; };
  Object.defineProperty(fn, 'pending', { get: () => pending });
  return fn;
}
