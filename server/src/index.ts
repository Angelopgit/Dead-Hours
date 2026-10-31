import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'node:http';
import { GAME, ROOMS } from '@dead-hours/shared';
import { SurvivalRoom } from './rooms/SurvivalRoom';
import { handleApi } from './net/api';
import { initWorld } from './game/world';
import { openStore } from './store';
import { services } from './services';
import { MAX_ROOMS, chooseProcess, dropLoad, forwardGameConnections, reportLoad, setupScale } from './net/scale';

const port = Number(process.env.PORT ?? GAME.defaultPort);
const scale = await setupScale(port);

const world = await initWorld();
console.log(`[dead-hours] navigation grid ready (${world.nodes} nodes, ${world.ms.toFixed(0)} ms)`);
services.store = await openStore();
console.log(`[dead-hours] profiles and leaderboards: ${services.store.kind}`);
if (services.debug) console.log('[dead-hours] DEAD_HOURS_DEBUG=1: test commands are enabled in rooms');
if (scale.address) {
  console.log(`[dead-hours] sharing games through Redis; this process is reached at ${scale.address}`);
  if (services.store.kind !== 'postgres') console.warn('[dead-hours] several servers need DATABASE_URL: a data file is not shared between them');
}
console.log(`[dead-hours] up to ${MAX_ROOMS} games on this process`);

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
}), presence: scale.presence, driver: scale.driver, selectProcessIdToCreateRoom: chooseProcess, greet: false });
gameServer.define(ROOMS.survival, SurvivalRoom);
forwardGameConnections(httpServer, scale);

await gameServer.listen(port);
reportLoad();
console.log(`[dead-hours] server listening on port ${port}`);

// Colyseus closes rooms on SIGINT/SIGTERM; the store is closed after them.
gameServer.onShutdown(async () => {
  await dropLoad();
  await services.store?.close();
});
