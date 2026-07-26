import { lazy } from 'preact/compat';
import type { ComponentType, FunctionComponent } from 'preact';

const RELOADED_KEY = 'chunk-reload';

/**
 * Wrap a plugin View (or route component) in a code-split lazy component so
 * the registry stays in the main chunk while each View (and its heavy deps)
 * loads on first render. DocRoute / App provide the Suspense boundary.
 *
 * A tab left open across a redeploy references content-hashed chunks that no
 * longer exist; the only recovery is a reload (once — guarded so a genuinely
 * broken chunk can't cause a reload loop).
 */
// Returns FunctionComponent (which lazy() produces) rather than ComponentType:
// the class-component branch of ComponentType checks props covariantly, which
// rejects Views whose own props are laxer than DocViewProps.
export function lazyView<P>(load: () => Promise<ComponentType<P>>): FunctionComponent<P> {
  // lazy() always yields a function-component wrapper; its typing just echoes T.
  return lazy(() =>
    load().then(
      View => {
        sessionStorage.removeItem(RELOADED_KEY);
        return { default: View };
      },
      err => {
        if (!sessionStorage.getItem(RELOADED_KEY)) {
          sessionStorage.setItem(RELOADED_KEY, '1');
          location.reload();
        }
        throw err;
      },
    ),
  ) as FunctionComponent<P>;
}
