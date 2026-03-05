import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Repo, DocumentId } from '@automerge/automerge-repo';
import { getHandle, listAll } from '../doc-store';
import { deepAssign } from '../../shared/deep-assign';

export function createApiRoutes(repo: Repo, dataDir: string): Router {
  const router = Router();

  // Health check endpoint
  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Document patch (deep merge JSON into Automerge document)
  router.patch('/docs/:documentId', (req: Request, res: Response) => {
    const documentId = req.params.documentId as string;
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }
    const handle = getHandle(repo, documentId);
    if (!handle) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    handle.change((d: any) => { deepAssign(d, patch); });
    res.json(Object.assign({}, handle.doc(), { documentId }));
  });

  // List all documents
  router.get('/api/docs', (_req: Request, res: Response) => {
    const docs = listAll(repo).map(d => ({
      documentId: d.documentId,
      type: d.doc?.['@type'] || null,
      name: d.doc?.name || null,
    }));
    res.json(docs);
  });

  // Delete a document
  router.delete('/api/docs/:documentId', (req: Request, res: Response) => {
    const documentId = req.params.documentId as string;
    const handle = getHandle(repo, documentId);
    if (!handle) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    repo.delete(documentId as DocumentId);
    const docDir = path.join(dataDir, documentId.substring(0, 2), documentId.substring(2));
    fs.rmSync(docDir, { recursive: true, force: true });
    res.status(204).send();
  });

  // Reset a calendar: clear all events, keep metadata
  router.post('/api/docs/:documentId/reset', (req: Request, res: Response) => {
    const documentId = req.params.documentId as string;
    const handle = getHandle(repo, documentId, 'Calendar');
    if (!handle) {
      res.status(404).json({ error: 'Calendar not found' });
      return;
    }
    handle.change((d: any) => {
      for (const key of Object.keys(d.events || {})) {
        delete d.events[key];
      }
    });
    res.json(Object.assign({}, handle.doc(), { documentId }));
  });

  return router;
}
