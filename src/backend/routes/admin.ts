import { Router, Request, Response } from 'express';
import { decodeInvitePayload, parseInviteUrl } from '../invite-codec';
import type { CaldavKeyhive } from '../caldav-keyhive';

/**
 * Admin routes for managing the CalDAV server's keyhive identity and invites.
 *
 * @param getCaldavKeyhive - getter that returns the CaldavKeyhive instance (null if not yet initialized)
 */
export function createAdminRoutes(getCaldavKeyhive: () => CaldavKeyhive | null): Router {
  const router = Router();

  // ── Admin page ────────────────────────────────────────────────────────────

  router.get('/admin/caldav', (_req: Request, res: Response) => {
    const kh = getCaldavKeyhive();
    const identity = kh ? kh.khOps.getIdentity().device : '(not initialized)';
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

  router.post('/admin/caldav-claim-invite', async (req: Request, res: Response) => {
    const kh = getCaldavKeyhive();
    if (!kh) {
      res.status(503).json({ error: 'Keyhive not initialized' });
      return;
    }

    try {
      let { invitePayload, docId } = req.body as { invitePayload?: string; docId?: string };

      // Support passing a full invite URL — extract docId and payload from it
      if (invitePayload && invitePayload.includes('#/invite/')) {
        const parsed = parseInviteUrl(invitePayload);
        docId = docId || parsed.docId;
        invitePayload = parsed.payload;
      }

      if (!invitePayload || !docId) {
        res.status(400).json({ error: 'Missing invitePayload or docId' });
        return;
      }

      const { seed, archive } = decodeInvitePayload(invitePayload);
      const result = await kh.khOps.claimInvite(
        Array.from(seed),
        Array.from(archive),
        docId,
      );

      console.log(`[admin] Invite claimed for doc ${docId}, khDocId: ${result.khDocId}`);
      res.json({ success: true, khDocId: result.khDocId, docId });
    } catch (err: any) {
      console.error('[admin] Failed to claim invite:', err);
      res.status(500).json({ error: err.message || 'Failed to claim invite' });
    }
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

  <h2>Claim Invite</h2>
  <form id="claim-form">
    <label for="invite">Invite URL or payload</label>
    <textarea id="invite" name="invitePayload" placeholder="Paste invite URL or base64url payload..." required></textarea>
    <label for="docId">Document ID (optional if URL contains it)</label>
    <input id="docId" name="docId" placeholder="automerge document ID">
    <button type="submit">Claim Invite</button>
  </form>
  <div id="result" class="result" style="display:none"></div>

  <h2>Accessible Documents</h2>
  <ul>${docList}</ul>

  <script>
    const form = document.getElementById('claim-form');
    const result = document.getElementById('result');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      result.style.display = 'none';
      const btn = form.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Claiming...';
      try {
        const body = Object.fromEntries(new FormData(form));
        const resp = await fetch('/admin/caldav-claim-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (resp.ok) {
          result.className = 'result ok';
          result.textContent = 'Invite claimed! khDocId: ' + data.khDocId;
          setTimeout(() => location.reload(), 1500);
        } else {
          result.className = 'result err';
          result.textContent = data.error || 'Unknown error';
        }
      } catch (err) {
        result.className = 'result err';
        result.textContent = err.message;
      } finally {
        result.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Claim Invite';
      }
    });
  </script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
