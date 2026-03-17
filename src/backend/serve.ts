import express from 'express';
import path from 'path';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { WebSocketRelay } from './relay';

const PORT = Number.parseInt(process.env.PORT || '3000');
const distDir = path.resolve(__dirname, '../../dist');

if (!fs.existsSync(distDir)) {
  console.error(`Build directory not found: ${distDir}\nRun "npm run build" first.`);
  process.exit(1);
}

const app = express();
app.use(express.static(distDir));
// SPA fallback: serve index.html for all non-file routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const wss = new WebSocketServer({ noServer: true });
const relay = new WebSocketRelay();
wss.on('connection', (ws) => relay.handleConnection(ws));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automerge Documents (production): http://localhost:${PORT}`);
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
