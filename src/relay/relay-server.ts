import http from 'http';
import { WebSocketRelay, createRelayWebSocketServer } from './relay';

const PORT = Number.parseInt(process.env.PORT || '3000');

// Last line of defense: the relay serves untrusted internet clients, and a
// single bad frame or transport error must never take the process down for
// every connected peer. Log and keep serving.
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandledRejection:', reason);
});

// Plain HTTP server: answers non-WebSocket requests with a liveness response so
// Heroku's router (which probes the dyno over HTTP) sees a healthy process. All
// real traffic arrives as WebSocket upgrades, handled below.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('relay ok\n');
});

const wss = createRelayWebSocketServer();
const relay = new WebSocketRelay();
wss.on('connection', (ws, req) => relay.handleConnection(ws, req));

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] WebSocket relay listening on http://0.0.0.0:${PORT}`);
});

// A listen failure (e.g. EADDRINUSE) is fatal and must exit so the process
// manager can react — the uncaughtException backstop above would otherwise
// swallow it and leave the process idling without a listener.
server.on('error', (err) => {
  console.error('[relay] server error:', err);
  process.exit(1);
});

const shutdown = () => {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
