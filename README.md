# Dead Hours

A cinematic co-op zombie survival game for the browser. Three.js + TypeScript client, Colyseus authoritative server, shared game data.

## Running

```bash
npm install
npm run dev          # client on http://localhost:5173
npm run dev:server   # multiplayer server on ws://localhost:2567 (lobbies wire up in Phase 4)
npm run typecheck    # shared + client + server
npm run check:world  # walks a character through the real map collision (doors, stairs, passages)
npm run check:sim    # headless combat simulation: navigation, weapons, damage, zombie AI, supplies, death
npm run build        # production client build into client/dist
```

## Layout

```
shared/   map data, weapons, player tuning, network protocol, combat simulation (used by client and server)
  src/map          Maple Hollow layout, map builder (houses, stairs, walls with openings), prop colliders
  src/sim          authoritative simulation: arsenal, hit zones, zombie AI, navigation grid, events
client/   Vite + Three.js game
  src/core         engine loop, input + rebinding, settings, Rapier physics
  src/rendering    post-processing, materials, procedural textures, static batching
  src/lighting     moonlight rig, lightning, light baker (ray tracer, light field, probes, auto exposure)
  src/environment  neighborhood builder, houses, sky, atmosphere; props/ holds the procedural prop kit
  src/characters   skinned low-poly humanoid (procedural animation, two-bone IK, wounds) and ragdolls
  src/weapons      weapon models, hand poses, reload/melee/bandage animation, recoil
  src/effects      particles, decals (holes, blood), shell casings, muzzle light
  src/zombies      zombie rendering: pooled bodies, interpolation, hit reactions, corpses
  src/gameplay     player controller, shoulder camera, doors, weapon table, menu cinematic, solo session
  src/audio        procedural Web Audio engine (no external assets)
  src/ui           main menu, settings, loadout, HUD, pause, inventory, weapon table, results
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

## Combat

Solo play runs the same authoritative simulation the Phase 4 server will run (`shared/src/sim`). The client only sends intents (fire along the camera ray, reload, switch, melee, bandage, use) and renders the events that come back, so damage, ammunition and health never live in the client.

- Weapons: M4A1 assault rifle, MP5 submachine gun, M870 pump shotgun (shell-by-shell reload, interruptible), MK14 marksman rifle (penetrates one body), M17 pistol, machete. Pick the starting primary in Loadout, swap it at the garage weapon table.
- Ammunition is limited. Ammo crates refill reserves twice each; first aid boxes hold bandages (Q, 2.6 s, +40 HP, interrupted by damage).
- Zombies have head, torso, arm and leg hit zones (head ×2.5). They hear gunfire and footsteps, spot you in their sight cone (crouching shortens it), path through houses, pound and break doors, stagger and get knocked down.
- 45 seconds of preparation, then the outbreak: a growing population of walkers and no waves. Death ends a solo run with the results screen.
- Gore can be set to Off, Reduced or Full in Settings → Graphics.

## Controls

WASD move · Mouse look · Shift sprint · Ctrl or C crouch · Space jump · LMB fire · RMB aim · R reload · E interact · F melee · 1 / 2 / wheel switch weapon · Q bandage · Tab inventory (hold) · V switch shoulder · Esc pause. All bindings are editable in Settings → Controls.

## Roadmap status

- **Phase 1 Foundation**: done.
- **Phase 2 Environment**: done. Maple Hollow, 250 × 250 m: Elm Street and Birch Lane with sidewalks, alleys and fourteen streetlights (a few dead, one flickering); ten houses (eight closed homes, the two-storey safehouse with kitchen, living room, three bedrooms, basement, garage and four ways in, and the enterable Henderson house); the Quik-Stop gas station with an enterable store; a park with playground and gazebo; a police checkpoint with a barrier chicane and floodlights; fenced backyards with sheds and tight side passages; woods around the edge. Baked AO, shadows and bounce light plus fog and dynamic lights.
- **Phase 3 Combat**: done. Six weapons with real models, hand IK, reload animations, recoil and holsters; muzzle flashes, tracers, shell casings and surface impacts; pooled blood, wounds, hit reactions and ragdoll deaths; zombie AI; weapon table, ammo crates and first aid; HUD with weapon panel, dynamic crosshair, hit markers, damage direction, timers and ammunition warning; inventory and results screen.
- Phase 4 Multiplayer · Phase 5 Survival director · Phase 6 Defenses · Phase 7 Helicopter drops · Phase 8 Polish.
