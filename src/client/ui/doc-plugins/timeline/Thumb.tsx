/**
 * A photo thumbnail stored in the Timeline document's `thumbs` map.
 *
 * The list query never projects `thumbs` (it is the bulk of the document), so
 * each thumbnail is fetched on its own with a one-shot query and cached by
 * docId + photo id: a thumbnail never changes once written. A missing one is
 * not cached — it may arrive with the next sync.
 */
import { useEffect, useState } from 'preact/hooks';
import { queryDoc } from '../../worker-api';
import { thumbBase64 } from '../../../../shared/schemas/timeline';

const cache = new Map<string, string>();

export function thumbQuery(photoId: string): string {
  return `.thumbs[${JSON.stringify(photoId)}]`;
}

export function useThumb(docId: string | undefined, photoId: string | undefined): string | null {
  const key = docId && photoId ? `${docId}\u0000${photoId}` : '';
  const [src, setSrc] = useState<string | null>(() => (key ? cache.get(key) ?? null : null));
  useEffect(() => {
    if (!key) { setSrc(null); return; }
    const hit = cache.get(key);
    if (hit) { setSrc(hit); return; }
    let live = true;
    setSrc(null);
    queryDoc(docId!, thumbQuery(photoId!), { peek: true }).then(({ result }) => {
      const b64 = thumbBase64(result);
      if (!b64) return;
      const url = `data:image/jpeg;base64,${b64}`;
      cache.set(key, url);
      if (live) setSrc(url);
    }).catch(() => { /* not here yet — the next render retries */ });
    return () => { live = false; };
  }, [key]);
  return src;
}

/** Test hook: forget every cached thumbnail. */
export function __clearThumbCache(): void {
  cache.clear();
}

export function Thumb({ docId, photoId, size = 40, className = '' }: {
  docId?: string;
  photoId?: string;
  size?: number;
  className?: string;
}) {
  const src = useThumb(docId, photoId);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      data-testid="timeline-thumb"
      className={'rounded-lg object-cover shrink-0 ' + className}
      style={{ width: size, height: size }}
    />
  );
}
