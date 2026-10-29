# Dead Hours

A cinematic co-op zombie survival game for the browser. Three.js + TypeScript client, Colyseus authoritative server, shared game data.

## Running

```bash
npm install
npm run dev          # client on http://localhost:5173
npm run dev:server   # multiplayer server on ws://localhost:2567 (lobbies wire up in Phase 4)
npm run typecheck    # shared + client + server
npm run build        # production client build into client/dist
```

## Layout

```
shared/   map data, weapons, player tuning, network protocol (used by client and server)
client/   Vite + Three.js game
  src/core         engine loop, input + rebinding, settings, Rapier physics
  src/rendering    post-processing, materials, procedural textures, static batching
  src/lighting     moonlight rig, lightning
  src/environment  neighborhood builder, houses, props, sky, atmosphere
  src/characters   procedural low-poly humanoid + animation
  src/gameplay     player controller, shoulder camera, doors, menu cinematic, solo session
  src/audio        procedural Web Audio engine (no external assets)
  src/ui           main menu, settings, loadout, HUD, pause
server/   Colyseus server
  src/rooms        SurvivalRoom + schema
assets/   reserved for models, textures, audio, lightmaps
```

The map is authored as data in `shared/src/config/map.ts`. The client builds both visuals and Rapier collision from it, and the server will build identical collision from the same source in Phase 4.

## Controls

WASD move · Mouse look · Shift sprint · Ctrl or C crouch · Space jump · E interact · V switch shoulder · Right mouse aim · Esc pause. All bindings are editable in Settings → Controls.

## Roadmap status

- **Phase 1 Foundation**: done. See below.
- Phase 2 Environment: gas station, park, police checkpoint, backyards, baked lightmaps, safehouse garage/basement/upstairs.
- Phase 3 Combat · Phase 4 Multiplayer · Phase 5 Survival director · Phase 6 Defenses · Phase 7 Helicopter drops · Phase 8 Polish.
