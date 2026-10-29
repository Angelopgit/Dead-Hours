# Dead Hours

A cinematic co-op zombie survival game for the browser. Three.js + TypeScript client, Colyseus authoritative server, shared game data.

## Running

```bash
npm install
npm run dev          # client on http://localhost:5173
npm run dev:server   # multiplayer server on ws://localhost:2567 (lobbies wire up in Phase 4)
npm run typecheck    # shared + client + server
npm run check:world  # walks a character through the real map collision (doors, stairs, passages)
npm run build        # production client build into client/dist
```

## Layout

```
shared/   map data, weapons, player tuning, network protocol (used by client and server)
  src/map          Maple Hollow layout, map builder (houses, stairs, walls with openings), prop colliders
client/   Vite + Three.js game
  src/core         engine loop, input + rebinding, settings, Rapier physics
  src/rendering    post-processing, materials, procedural textures, static batching
  src/lighting     moonlight rig, lightning, light baker (ray tracer, light field, probes, auto exposure)
  src/environment  neighborhood builder, houses, sky, atmosphere; props/ holds the procedural prop kit
  src/characters   procedural low-poly humanoid + animation
  src/gameplay     player controller, shoulder camera, doors, menu cinematic, solo session
  src/audio        procedural Web Audio engine (no external assets)
  src/ui           main menu, settings, loadout, HUD, pause
  tests/           headless world checks (npm run check:world)
server/   Colyseus server
  src/rooms        SurvivalRoom + schema
assets/   reserved for models, textures, audio, lightmaps
```

The map is authored as data in `shared/src/map/maple-hollow.ts`. The client builds both visuals and Rapier collision from it (`propColliders` in `shared/src/map/colliders.ts` gives every prop its boxes), and the server will build identical collision from the same source in Phase 4.

## Lighting

Static lighting is baked in the browser on first load and cached in IndexedDB (about 3 seconds on a laptop, instant afterwards). A small BVH ray tracer over the map's boxes computes, per vertex and for a 512² ground lightmap:

- ambient occlusion (cosine-weighted hemisphere rays),
- direct light from every static lamp with ray-traced shadows (same falloff as Three.js physical lights),
- one bounce of indirect light, gathered from virtual point lights scattered off the first hits.

The bake is injected into the standard materials' irradiance, so realtime lights (moon with shadows, the flickering streetlight, police strobes, the muzzle flash later) still shade on top. Characters and door leaves are lit by light probes sampled from the same light field, and exposure adapts between indoors and out. Bump `BAKE_VERSION` in `client/src/lighting/LightBaker.ts` when the baker changes; map edits invalidate the cache automatically.

## Controls

WASD move · Mouse look · Shift sprint · Ctrl or C crouch · Space jump · E interact · V switch shoulder · Right mouse aim · Esc pause. All bindings are editable in Settings → Controls.

## Roadmap status

- **Phase 1 Foundation**: done.
- **Phase 2 Environment**: done. Maple Hollow, 250 × 250 m: Elm Street and Birch Lane with sidewalks, alleys and fourteen streetlights (a few dead, one flickering); ten houses (eight closed homes, the two-storey safehouse with kitchen, living room, three bedrooms, basement, garage and four ways in, and the enterable Henderson house); the Quik-Stop gas station with an enterable store; a park with playground and gazebo; a police checkpoint with a barrier chicane and floodlights; fenced backyards with sheds and tight side passages; woods around the edge. Baked AO, shadows and bounce light plus fog and dynamic lights.
- Phase 3 Combat · Phase 4 Multiplayer · Phase 5 Survival director · Phase 6 Defenses · Phase 7 Helicopter drops · Phase 8 Polish.
