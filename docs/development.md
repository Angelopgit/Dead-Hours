# Development

## Running locally

```bash
npm install
npm run dev            # client on http://localhost:5173
npm run dev:server     # game server on http://localhost:2567 (restarts on changes)
npm start              # game server, as deployed
npm run build          # production client build into client/dist
npm run typecheck      # shared + client + server
```

Headless checks (run the ones that touch what you changed, and `typecheck`, before pushing):

| Script | What it checks |
| --- | --- |
| `check:sim` | combat simulation: navigation, weapons, damage, zombie AI, supplies, death, lulls, appearance wire format |
| `check:world` | walks a character through the real map collision (doors, stairs, passages) |
| `check:houses` | every enterable home: rooms reachable, stairs walkable, basements connected |
| `check:audio` | renders the synthesized sounds and echo responses, checks the recorded takes and their credits |
| `check:server` | starts a real server and plays it over WebSocket and HTTP |
| `check:cluster` | the game cap, then two servers sharing Redis behind a balancer (needs `redis-server`) |
| `check:render`, `check:trees`, `check:grass` | FPS limiter and the light-loop shader patch, tree models and LOD budgets, where lawn grass grows |
| `check:controls`, `check:sights`, `check:melee` | aim assist and stick curves, aim-down-sights alignment, melee grips |
| `check:raid`, `check:explosives`, `check:windows`, `check:boosts` | van raid, grenades and Molotovs, window vaulting, boost syringes |
| `check:skate`, `check:bike`, `check:vehicles` | skateboards, bicycles, cars (shared sim, server and client) |

Benches: `npm run load -w server` (bot lobbies against real server processes, CPU per lobby count; `SERVERS=3` for several), `npm run bench -w server` (one game's server work without the network), `npm run bench:physics -w server`, `npm run spawns -w server`, `npm run balance -w server` and `npm run balance:guns`.

In development the client finds the server on port 2567 of the same host. A production build needs `VITE_SERVER_URL` (see [online.md](online.md)); without it the online menu items stay disabled and say SERVER OFFLINE, and solo play works as before.

## Layout

```
shared/   map data, weapons, player tuning, network protocol, combat simulation (used by client and server)
  src/config       weapons, zombies, player tuning, survivor appearance catalog (appearance.ts)
  src/map          Maple Hollow layout, map builder (houses, stairs, walls with openings), prop colliders
  src/sim          authoritative simulation: arsenal, hit zones, zombie AI, navigation grid, events
  src/protocol     room messages, compact snapshots and the client's mirror of the server's simulation
client/   Vite + Three.js game
  src/core         engine loop, input + rebinding, settings, Rapier physics
  src/rendering    post-processing, materials, procedural textures, static batching
  src/lighting     moonlight rig, lightning, light baker (ray tracer, light field, probes, auto exposure)
  src/environment  neighborhood builder, houses, sky, atmosphere; props/ holds the procedural prop kit
  src/characters   skinned low-poly humanoid (procedural animation, two-bone IK, wounds, eyes) and ragdolls;
                   Outfit.ts builds faces, hair, clothes and accessories, CharacterPreview.ts is the dressing room
  src/weapons      weapon models, hand poses, reload/melee/bandage animation, recoil
  src/effects      particles, decals (holes, blood), shell casings, muzzle light
  src/zombies      zombie rendering: pooled bodies, interpolation, hit reactions, corpses
  src/gameplay     player controller, shoulder camera, doors, weapon table, menu cinematic, the game session
                   (solo and online) and the other survivors online (RemoteSurvivors.ts)
  src/network      server address and health (Net.ts), the room connection (NetLink.ts), player key and saved survivor (Account.ts)
  src/audio        Web Audio engine: recorded gun and flesh-hit sounds (recorded/, CC0, see the sound credits in the README), synthesized everything else
  src/ui           main menu, settings, loadout, HUD, pause, inventory, weapon table, results,
                   online menu (host, join, lobby) and leaderboards
  tests/           headless checks (world collision, houses, audio, controls, sights, melee, trees, grass...)
  dev/             dev-only pages and scripts for tuning and measuring (outfit lineup, gun clips, HUD audit...),
                   served by the dev server, never part of the build
  tools/textures   generates and encodes the KTX2 texture sets in public/textures
  tools/trailer    the cinematic trailer: render.mjs draws its frames and sound from the game (see docs/trailer.md), join.mjs puts parts together, assemble.mjs cuts the MP4
server/   Colyseus server
  src/game         the world's collision and navigation (built once), a night of play (Night.ts)
  src/rooms        SurvivalRoom: lobby, host, start, the running night, results
  src/net          HTTP API (health, open games, join codes, leaderboards, profiles, solo runs), input cleaning
  src/store.ts     profiles, runs, boards and accounts in Postgres (DATABASE_URL) or a JSON file
  src/net/auth.ts  Google and Discord sign-in, sessions, whose profile a request plays as
  tests/           end-to-end server check (npm run check:server), cluster check, load and balance benches
```

The map is authored as data in `shared/src/map/maple-hollow.ts`. The client builds both visuals and Rapier collision from it (`propColliders` in `shared/src/map/colliders.ts` gives every prop its boxes), and the server builds identical collision from the same source.

