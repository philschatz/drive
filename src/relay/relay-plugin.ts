import type { Plugin } from 'vite';
import { WebSocketRelay, createRelayWebSocketServer } from './relay';
import { createLogger } from '../shared/logger';

const log = createLogger('relay');

/**
 * Vite plugin that attaches the automerge-repo WebSocket relay
 * to Vite's built-in HTTP server during development.
 */
export function relayPlugin(): Plugin {
  return {
    name: 'automerge-relay',
    configureServer(server) {
      const wss = createRelayWebSocketServer();
      const relay = new WebSocketRelay();
      wss.on('connection', (ws, req) => relay.handleConnection(ws, req));

      server.httpServer!.on('upgrade', (req, socket, head) => {
        // Let Vite handle its own HMR WebSocket upgrades
        if (req.headers['sec-websocket-protocol']?.includes('vite-hmr')) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });

      log.info('WebSocket relay started');
    },
  };
}
