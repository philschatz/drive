import http from 'http';
import { WebSocketServer } from 'ws';
import { WebSocketRelay } from './relay';

const PORT = Number.parseInt(process.env.PORT || '3000');

// Plain HTTP server: answers non-WebSocket requests with a liveness response so
// Heroku's router (which probes the dyno over HTTP) sees a healthy process. All
// real traffic arrives as WebSocket upgrades, handled below.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('relay ok\n');
});

const wss = new WebSocketServer({ noServer: true });
const relay = new WebSocketRelay();
wss.on('connection', (ws) => relay.handleConnection(ws));

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] WebSocket relay listening on http://0.0.0.0:${PORT}`);
});

const shutdown = () => {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
