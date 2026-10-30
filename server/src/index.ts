import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'node:http';
import { GAME, ROOMS } from '@dead-hours/shared';
import { SurvivalRoom } from './rooms/SurvivalRoom';
import { handleApi } from './net/api';
import { initWorld } from './game/world';
import { openStore } from './store';
import { services } from './services';

const port = Number(process.env.PORT ?? GAME.defaultPort);

const world = await initWorld();
console.log(`[dead-hours] navigation grid ready (${world.nodes} nodes, ${world.ms.toFixed(0)} ms)`);
services.store = await openStore();
console.log(`[dead-hours] profiles and leaderboards: ${services.store.kind}`);
if (services.debug) console.log('[dead-hours] DEAD_HOURS_DEBUG=1: test commands are enabled in rooms');

// Colyseus answers its own matchmaking routes (with cross-origin headers) before this handler.
const httpServer = createServer((req, res) => {
  void handleApi(req, res).then((handled) => {
    if (handled) return;
    res.writeHead(404);
    res.end();
  });
});

const gameServer = new Server({ transport: new WebSocketTransport({
  server: httpServer,
  // A browser that stalls (building the night's scene, a slow machine) stops reading its socket for a
  // few seconds; it is dropped only after about 12-16 s without answering.
  pingInterval: 4000,
  pingMaxRetries: 3,
  // Voice negotiation passes WebRTC descriptions (a few kB) through the room.
  maxPayload: 16 * 1024,
}), greet: false });
gameServer.define(ROOMS.survival, SurvivalRoom);

await gameServer.listen(port);
console.log(`[dead-hours] server listening on port ${port}`);

// Colyseus closes rooms on SIGINT/SIGTERM; the store is closed after them.
gameServer.onShutdown(() => services.store?.close());
