import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocketServer } from 'ws';
import { Repo } from '@automerge/automerge-repo';
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { scanStorage, listByType } from './doc-store';
import { CalDAVHandler } from './caldav-handler';
import { createApiRoutes } from './routes/api';
import { createUiRoutes } from './routes/ui';
import { createDavRoutes } from './routes/dav';

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000');
const isProd = process.env.NODE_ENV === 'production';
const dataDir = process.env.AUTOMERGE_DATA_DIR || './.data';
fs.mkdirSync(dataDir, { recursive: true });

// WebSocket server (noServer mode — Express handles the HTTP upgrade)
const wss = new WebSocketServer({ noServer: true });

// Create automerge-repo with filesystem storage and WebSocket networking
const repo = new Repo({
  network: [new WebSocketServerAdapter(wss) as any],
  storage: new NodeFSStorageAdapter(dataDir),
  peerId: `calendar-server-${os.hostname()}` as any,
  sharePolicy: async () => false,
});

const caldavHandler = new CalDAVHandler(repo);

// Body parsers
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ['text/calendar', 'text/plain', 'application/xml'] }));

// Initialize store and Vite, then mount routes
export const ready = (async () => {
  await scanStorage(repo, dataDir);

  // Create a default calendar if none exist
  if (listByType(repo, 'Calendar').length === 0) {
    const handle = repo.create();
    handle.change((d: any) => {
      d['@type'] = 'Calendar';
      d.name = 'Default Automerge Calendar';
      d.description = 'Default Automerge Calendar for events';
      d.events = {};
    });
  }

  // Create Vite dev server or serve production build
  let vite: any = null;
  const distDir = path.resolve(__dirname, '../../dist');

  if (!process.env.JEST_WORKER_ID && !isProd) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      server: { middlewareMode: true, hmr: { port: PORT + 1 } },
      appType: 'custom',
    });
  }

  // Request logging
  app.use((req: Request, res: Response, next) => {
    const startTime = Date.now();
    const { method, url } = req;
    process.stdout.write(`→ ${method} ${url}\n`);
    next();
  });

  // Vite middleware first — serves JS/CSS/assets before UI catch-all routes
  if (vite) {
    app.use(vite.middlewares);
  } else if (isProd && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
  }

  // Mount routes
  app.use(createApiRoutes(repo, dataDir));
  app.use(createUiRoutes(vite, isProd ? distDir : null));
  app.use(createDavRoutes(caldavHandler));

  // Error handling middleware
  app.use((err: Error, req: Request, res: Response, next: any) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', message: `Route ${req.method} ${req.path} not found` });
  });
})();

// Start server (not in test environment)
if (!process.env.JEST_WORKER_ID) {
  (async () => {
    await ready;

    const server = app.listen(PORT, '0.0.0.0', () => {
      const mode = isProd ? 'production' : 'development';
      console.log(`Automerge Calendar (${mode}): http://localhost:${PORT}`);
      if (isProd) console.log('Serving production build');
    });

    // Wire up WebSocket upgrade for automerge-repo
    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

    // Graceful shutdown
    const shutdown = () => {
      wss.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })();
}

export default app;
