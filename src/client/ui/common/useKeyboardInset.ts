import { useEffect, useState } from 'preact/hooks';

/**
 * Height (px) of the part of the layout viewport covered by the on-screen
 * keyboard, from the visualViewport API. 0 when the keyboard is closed or the
 * browser resizes the layout viewport instead (Android Chrome default) —
 * bottom-anchored chrome only needs an offset where the layout viewport keeps
 * its size while the visual viewport shrinks (iOS Safari).
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
}
