import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { Repo } from '@automerge/automerge-repo';
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { WebSocketRelay, createRelayWebSocketServer } from './relay';
import { CalDAVHandler } from './caldav-handler';
import { createDavRoutes } from './routes/dav';
import { createAdminRoutes } from './routes/admin';
import { initCaldavKeyhive, type CaldavKeyhive } from './caldav-keyhive';

const app = express();
const PORT = Number.parseInt(process.env.CALDAV_PORT || process.env.PORT || '3001');
const dataDir = process.env.AUTOMERGE_DATA_DIR || './.data';
fs.mkdirSync(dataDir, { recursive: true });

const wss = createRelayWebSocketServer();

let relay: WebSocketRelay | null = null;
let caldavKeyhive: CaldavKeyhive | null = null;

let resolveRepo: (repo: Repo) => void;
const repoPromise = new Promise<Repo>((resolve) => { resolveRepo = resolve; });

if (process.env.JEST_WORKER_ID) {
  // Test environment: plain Repo so Jest can sync documents for CalDAV tests.
  const storageAdapter = new NodeFSStorageAdapter(dataDir);
  const wsAdapter = new WebSocketServerAdapter(wss);
  resolveRepo!(new Repo({
    network: [wsAdapter],
    storage: storageAdapter,
    peerId: 'test-server' as any,
    sharePolicy: async () => true,
  } as any));
} else {
  relay = new WebSocketRelay();
  wss.on('connection', (ws, req) => relay!.handleConnection(ws, req));
  console.log('[relay] WebSocket relay started');

  // Last line of defense: the relay serves untrusted internet clients, and a
  // single bad frame or transport error must never take the process down for
  // every connected peer. Log and keep serving. (Not registered under Jest so
  // test failures still surface normally.)
  process.on('uncaughtException', (err) => {
    console.error('[caldav] uncaughtException:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[caldav] unhandledRejection:', reason);
  });
}

// Body parsers
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ['text/calendar', 'text/plain', 'application/xml'] }));

// CalDAV discovery redirects
app.head('/', (req: Request, res: Response) => {
  res.set('DAV', '1, 2, 3, calendar-access');
  res.status(200).end();
});

app.get('/', (req: Request, res: Response) => {
  const accept = req.headers.accept || '';
  if (accept.includes('text/calendar')) {
    res.redirect(302, '/dav/cal/');
    return;
  }
  res.redirect(302, '/admin/caldav');
});

// Initialize routes
export const ready = (async () => {
  const repo = await repoPromise;
  const caldavHandler = new CalDAVHandler(repo);

  app.use(createAdminRoutes(() => caldavKeyhive));
  app.use(createDavRoutes(caldavHandler));

  // Error handling
  app.use((err: Error, req: Request, res: Response, next: any) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', message: `Route ${req.method} ${req.path} not found` });
  });
})();

// Start server (not in test environment)
if (!process.env.JEST_WORKER_ID) {
  (async () => {
    const server = app.listen(PORT, '0.0.0.0', async () => {
      console.log(`CalDAV server: http://localhost:${PORT}`);
      console.log(`Admin: http://localhost:${PORT}/admin/caldav`);

      // Now the relay is listening — initialize the keyhive repo.
      try {
        const khDataDir = path.join(dataDir, 'caldav-keyhive');
        fs.mkdirSync(khDataDir, { recursive: true });
        caldavKeyhive = await initCaldavKeyhive(khDataDir, `ws://localhost:${PORT}`);
        resolveRepo!(caldavKeyhive.repo);
        console.log('[caldav-keyhive] repo ready');
      } catch (err) {
        console.error('[caldav-keyhive] failed to initialize:', err);
        const storageAdapter = new NodeFSStorageAdapter(dataDir);
        resolveRepo!(new Repo({
          network: [],
          storage: storageAdapter,
          peerId: 'caldav-server' as any,
          sharePolicy: async () => false,
        } as any));
      }
    });

    server.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });

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
