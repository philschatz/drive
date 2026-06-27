import { useState, useEffect } from 'preact/hooks';
import { type ComponentChildren } from 'preact';
import { openDoc } from '../worker-api';
import { addDocId } from '../doc-storage';
import { Progress } from '../components/ui/progress';

export type DocStatus = 'loading' | 'ready' | 'error';

export function useDocument(docId: string | undefined) {
  const [status, setStatus] = useState<DocStatus>('loading');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('Connecting\u2026');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docId) {
      setStatus('error');
      setError('No document ID');
      return;
    }
    setStatus('loading');
    setProgress(0);
    setMessage('Connecting\u2026');
    setError(null);

    let cancelled = false;
    openDoc(docId, {
      onProgress: (pct, msg) => { if (!cancelled) { setProgress(pct); setMessage(msg); } },
    })
      .then(() => {
        if (!cancelled) {
          setProgress(100); setMessage('Ready'); setStatus('ready');
          // Ensure the doc appears in the home page doc list (e.g. when visiting a shared URL)
          addDocId(docId);
        }
      })
      .catch((err) => { if (!cancelled) { setStatus('error'); setError(err.message); } });

    return () => { cancelled = true; };
  }, [docId]);

  return { status, progress, message, error };
}

/**
 * Wrapper component that fires openDoc and renders children immediately
 * so their subscribeQuery effects can serve cached data while the doc syncs.
 * Shows a thin fixed progress bar at the top during loading.
 */
export function DocLoader({ docId, children }: { docId: string | undefined; children: ComponentChildren }) {
  const { status, progress, error } = useDocument(docId);

  if (status === 'error') return (
    <div className="p-6 max-w-sm mx-auto mt-12 flex items-start gap-3">
      <a href="#/" className="text-muted-foreground hover:text-foreground shrink-0">
        <span className="material-symbols-outlined" style={{ fontSize: 20 }}>arrow_back</span>
      </a>
      <p className="text-sm text-destructive">{error}</p>
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
