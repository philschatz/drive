import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { WebSocketRelay } from './relay';

/**
 * Vite plugin that attaches the automerge-repo WebSocket relay
 * to Vite's built-in HTTP server during development.
 */
export function relayPlugin(): Plugin {
  return {
    name: 'automerge-relay',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });
      const relay = new WebSocketRelay();
      wss.on('connection', (ws) => relay.handleConnection(ws));

      server.httpServer!.on('upgrade', (req, socket, head) => {
        // Let Vite handle its own HMR WebSocket upgrades
        if (req.headers['sec-websocket-protocol']?.includes('vite-hmr')) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });

      console.log('[relay] WebSocket relay started');
    },
  };
}
