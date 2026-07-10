import express from 'express';
import path from 'path';
import fs from 'fs';
import { WebSocketRelay, createRelayWebSocketServer } from './relay';

const PORT = Number.parseInt(process.env.PORT || '3000');

// Last line of defense: the relay serves untrusted internet clients, and a
// single bad frame or transport error must never take the process down for
// every connected peer. Log and keep serving.
process.on('uncaughtException', (err) => {
  console.error('[serve] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[serve] unhandledRejection:', reason);
});
const distDir = path.resolve(__dirname, '../../dist');

if (!fs.existsSync(distDir)) {
  console.error(`Build directory not found: ${distDir}\nRun "npm run build" first.`);
  process.exit(1);
}

const app = express();
app.use(express.static(distDir));
// SPA fallback: serve index.html for all non-file routes
app.get('{*path}', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const wss = createRelayWebSocketServer();
const relay = new WebSocketRelay();
wss.on('connection', (ws, req) => relay.handleConnection(ws, req));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automerge Documents (production): http://0.0.0.0:${PORT}`);
});

// A listen failure (e.g. EADDRINUSE) is fatal and must exit so the process
// manager can react — the uncaughtException backstop above would otherwise
// swallow it and leave the process idling without a listener.
server.on('error', (err) => {
  console.error('[serve] server error:', err);
  process.exit(1);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const shutdown = () => {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
