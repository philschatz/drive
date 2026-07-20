import { useEffect, useState } from 'preact/hooks';
import { openDoc, subscribeQuery } from './worker-api';
import { getDocPlugin } from './doc-plugins';
import { DocLoader } from './shared/useDocument';
import { useAccess } from './shared/useAccess';
import { sourceUrl } from './shared/doc-urls';
import { buttonVariants } from '@/components/ui/button';

/**
 * The single document route: `#/d/:docId[/:rest*]`. Resolves the document's
 * `@type` and dispatches to the registered plugin's View; documents with no
 * registered plugin are handed to the source inspector.
 */
export function DocRoute({ docId, rest }: { docId?: string; rest?: string; path?: string }) {
  return (
    <DocLoader docId={docId}>
      {docId && <DocViewResolver docId={docId} rest={rest} />}
    </DocLoader>
  );
}

function DocViewResolver({ docId, rest }: { docId: string; rest?: string }) {
  // undefined = not yet known; null = document has no string @type
  const [docType, setDocType] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setDocType(undefined);
    return subscribeQuery(docId, '.["@type"]',
      r => setDocType(typeof r === 'string' ? r : null));
  }, [docId]);

  // A still-syncing doc also queries to null — only treat a MISSING @type as
  // authoritative once openDoc reports the doc ready (idempotent; DocLoader
  // already fired it). An unknown-but-present @type needs no such wait.
  const [docReady, setDocReady] = useState(false);
  useEffect(() => {
    setDocReady(false);
    let cancelled = false;
    openDoc(docId).then(() => { if (!cancelled) setDocReady(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, [docId]);

  const { canEdit, loaded } = useAccess(docId);
  const plugin = getDocPlugin(docType);
  const unsupported = docType !== undefined && !plugin && (docType !== null || docReady);

  // No plugin renders this @type → keep the URL and explain, offering the
  // universal source inspector instead.
  if (unsupported) {
    return (
      <div className="p-6 max-w-sm mx-auto mt-12 flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          {docType === null
            ? 'This document has no "@type" field, so no editor can open it.'
            : `Document type "${docType}" is not supported by any editor.`}
        </p>
        <a href={sourceUrl(docId)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>code</span>
          View / edit source
        </a>
      </div>
    );
  }

  // Hold until @type and access are both known so the view mounts exactly once,
  // with the right readOnly state (no flash of editing chrome on read-only docs).
  // Cached docs resolve synchronously, so the spinner is imperceptible for them.
  if (docType === undefined || !loaded || !plugin) {
    return (
      <div className="flex justify-center mt-24">
        <span className="material-symbols-outlined animate-spin text-muted-foreground">progress_activity</span>
      </div>
    );
  }

  return <plugin.View docId={docId} rest={rest} readOnly={!canEdit} />;
}
