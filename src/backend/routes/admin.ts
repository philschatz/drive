import { Router, Request, Response } from 'express';
import type { CaldavKeyhive } from '../caldav-keyhive';

/**
 * Admin routes for inspecting the CalDAV server's keyhive identity and documents.
 *
 * @param getCaldavKeyhive - getter that returns the CaldavKeyhive instance (null if not yet initialized)
 */
export function createAdminRoutes(getCaldavKeyhive: () => CaldavKeyhive | null): Router {
  const router = Router();

  // ── Admin page ────────────────────────────────────────────────────────────

  router.get('/admin/caldav', async (_req: Request, res: Response) => {
    const kh = getCaldavKeyhive();
    const identity = kh ? (await kh.khOps.getIdentity()).deviceId : '(not initialized)';
    const docs = kh ? Array.from(kh.khOps.khDocuments.keys()) : [];

    res.type('html').send(adminPageHtml(identity, docs));
  });

  // ── API endpoints ─────────────────────────────────────────────────────────

  router.get('/admin/caldav-identity', (_req: Request, res: Response) => {
    const kh = getCaldavKeyhive();
    if (!kh) {
      res.status(503).json({ error: 'Keyhive not initialized' });
      return;
    }
    res.json(kh.khOps.getIdentity());
  });

  return router;
}

// ── Admin page HTML ───────────────────────────────────────────────────────────

function adminPageHtml(identity: string, docs: string[]): string {
  const docList = docs.length > 0
    ? docs.map(d => `<li><code>${escHtml(d)}</code></li>`).join('\n')
    : '<li class="empty">No documents claimed yet</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CalDAV Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
    .identity { background: #f5f5f5; padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.85rem; word-break: break-all; margin-bottom: 1.5rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; }
    label { font-weight: 500; font-size: 0.9rem; }
    input, textarea { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-family: monospace; font-size: 0.85rem; }
    textarea { min-height: 80px; resize: vertical; }
    button { padding: 0.5rem 1.25rem; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; align-self: flex-start; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #94a3b8; cursor: not-allowed; }
    .result { margin-top: 0.75rem; padding: 0.75rem; border-radius: 4px; font-size: 0.85rem; }
    .result.ok { background: #dcfce7; color: #166534; }
    .result.err { background: #fee2e2; color: #991b1b; }
    ul { list-style: none; padding: 0; }
    ul li { padding: 0.25rem 0; font-size: 0.85rem; }
    ul li.empty { color: #6b7280; font-style: italic; }
    code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>CalDAV Server Admin</h1>

  <h2>Server Identity</h2>
  <div class="identity">${escHtml(identity)}</div>

  <h2>Accessible Documents</h2>
  <ul>${docList}</ul>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
