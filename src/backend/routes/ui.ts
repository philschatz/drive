import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const clientRoot = path.resolve(__dirname, '../../../src/client');

async function serveHtml(vite: any, distDir: string | null, req: Request, res: Response) {
  let html: string;
  if (distDir) {
    html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
  } else {
    html = fs.readFileSync(path.join(clientRoot, 'index.html'), 'utf-8');
    if (vite) {
      html = await vite.transformIndexHtml(req.originalUrl, html);
    }
  }
  res.status(200).set('Content-Type', 'text/html').send(html);
}

export function createUiRoutes(vite: any, distDir: string | null = null): Router {
  const router = Router();

  // CalDAV discovery redirect for calendar clients probing HEAD /
  router.head('/', (req: Request, res: Response) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/calendar')) {
      res.redirect(302, '/dav/cal/');
    } else {
      res.set('DAV', '1, 2, 3, calendar-access');
      res.status(200).end();
    }
  });

  // SPA entry point — all navigation is hash-based so only GET / is needed
  router.get('/', (req: Request, res: Response) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/calendar')) {
      res.redirect(302, '/dav/cal/');
      return;
    }
    serveHtml(vite, distDir, req, res);
  });

  return router;
}
