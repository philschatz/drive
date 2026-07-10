import { useState, useEffect, useCallback } from 'preact/hooks';
import { type ComponentChildren } from 'preact';
import { openDoc } from '../worker-api';
import { Progress } from '../components/ui/progress';

export type DocStatus = 'loading' | 'ready' | 'error';

/**
 * Client-side backstop: if a document hasn't loaded within this window it is most
 * likely unavailable (no online peer has it) — the worker's `open-doc` awaits
 * readiness/unavailability but a truly-offline doc would otherwise leave the UI on
 * an infinite progress bar. We surface an "unavailable / retry" state instead. The
 * underlying openDoc promise keeps running, so a merely-slow (large) doc that
 * eventually resolves still flips to ready.
 */
const OPEN_DOC_TIMEOUT_MS = 30_000;

export function useDocument(docId: string | undefined) {
  const [status, setStatus] = useState<DocStatus>('loading');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    if (!docId) {
      setStatus('error');
      setError('No document ID');
      return;
    }
    setStatus('loading');
    setProgress(0);
    setMessage('Connecting…');
    setError(null);

    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setStatus('error');
        setError('This document is taking too long to load. It may be unavailable (no one online has it yet). Check your connection and try again.');
      }
    }, OPEN_DOC_TIMEOUT_MS);

    openDoc(docId, {
      onProgress: (pct, msg) => { if (!cancelled) { setProgress(pct); setMessage(msg); } },
    })
      .then(() => {
        if (!cancelled) {
          clearTimeout(timeout);
          setProgress(100); setMessage('Ready'); setStatus('ready'); setError(null);
          // The worker owns the doc list: an opened/shared doc enters it via
          // reconcileHomeDocs once keyhive access syncs (no explicit registration here).
        }
      })
      .catch((err) => { if (!cancelled) { clearTimeout(timeout); setStatus('error'); setError(err.message); } });

    return () => { cancelled = true; clearTimeout(timeout); };
  }, [docId, reloadKey]);

  return { status, progress, message, error, retry };
}

/**
 * Wrapper component that fires openDoc and renders children immediately
 * so their subscribeQuery effects can serve cached data while the doc syncs.
 * Shows a thin fixed progress bar at the top during loading.
 */
export function DocLoader({ docId, children }: { docId: string | undefined; children: ComponentChildren }) {
  const { status, progress, error, retry } = useDocument(docId);

  if (status === 'error') return (
    <div className="p-6 max-w-sm mx-auto mt-12 flex items-start gap-3">
      <a href="#/" className="text-muted-foreground hover:text-foreground shrink-0">
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>arrow_back</span>
      </a>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={retry}
          className="self-start rounded border border-current px-3 py-1 text-sm font-medium text-foreground hover:bg-muted"
        >
          Try again
        </button>
      </div>
    </div>
  );

  return (
    <>
      {status === 'loading' && (
        <div className="fixed top-0 left-0 right-0 z-50">
          <Progress value={progress} />
        </div>
      )}
      {children}
    </>
  );
}
