import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { createServer } from 'node:http';
import { GAME, ROOMS } from '@dead-hours/shared';
import { SurvivalRoom } from './rooms/SurvivalRoom';

const port = Number(process.env.PORT ?? GAME.defaultPort);
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define(ROOMS.survival, SurvivalRoom).enableRealtimeListing();

await gameServer.listen(port);
console.log(`[dead-hours] server listening on ws://localhost:${port}`);

const shutdown = async () => {
  await gameServer.gracefullyShutdown(false);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
