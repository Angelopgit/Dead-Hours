# Dead Hours

A cinematic co-op zombie survival game for the browser. Three.js + TypeScript client, Colyseus authoritative server, shared game data.

## Running

```bash
npm install
npm run dev          # client on http://localhost:5173
npm run dev:server   # game server on http://localhost:2567 (restarts on changes)
npm start            # game server, as deployed
npm run typecheck    # shared + client + server
npm run check:world  # walks a character through the real map collision (doors, stairs, passages)
npm run check:houses # every enterable home: rooms reachable, stairs walkable, basements connected
npm run check:audio  # renders every gun, action and handling sound and the echo responses, checks level and shape
npm run check:sim    # headless combat simulation: navigation, weapons, damage, zombie AI, supplies, death, appearance wire format
npm run check:server # starts a real server and plays it over WebSocket and HTTP: rooms, codes, a night, boards, profiles
npm run build        # production client build into client/dist
```

In development the client finds the server on port 2567 of the same host. A production build needs `VITE_SERVER_URL` (see Online play); without it the online menu items stay disabled and say SERVER OFFLINE, and solo play works as before.

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
  src/audio        procedural Web Audio engine and offline gun synthesis (no external assets)
  src/ui           main menu, settings, loadout, HUD, pause, inventory, weapon table, results,
                   online menu (host, join, lobby) and leaderboards
  tests/           headless world and audio checks (npm run check:world, check:audio)
  dev/lineup.html  dev-only page that renders survivors side by side for checking outfits (not in the build)
server/   Colyseus server
  src/game         the world's collision and navigation (built once), a night of play (Night.ts)
  src/rooms        SurvivalRoom: lobby, host, start, the running night, results
  src/net          HTTP API (health, open games, join codes, leaderboards, profiles, solo runs), input cleaning
  src/store.ts     profiles, runs and boards in Postgres (DATABASE_URL) or a JSON file
  tests/           end-to-end server check (npm run check:server)
assets/   reserved for models, textures, audio, lightmaps
```

The map is authored as data in `shared/src/map/maple-hollow.ts`. The client builds both visuals and Rapier collision from it (`propColliders` in `shared/src/map/colliders.ts` gives every prop its boxes), and the server builds identical collision from the same source.

## Lighting

Static lighting is baked in the browser on first load and cached in IndexedDB (about 3 seconds on a laptop, instant afterwards). A small BVH ray tracer over the map's boxes computes, per vertex and for a 512² ground lightmap:

- ambient occlusion (cosine-weighted hemisphere rays),
- direct light from every static lamp with ray-traced shadows (same falloff as Three.js physical lights),
- one bounce of indirect light, gathered from virtual point lights scattered off the first hits.

The bake is injected into the standard materials' irradiance, so realtime lights (moon with shadows, the flickering streetlight, police strobes, the muzzle flash later) still shade on top. Characters and door leaves are lit by light probes sampled from the same light field, and exposure adapts between indoors and out. Baked light has no highlights of its own, so puddles get the nearest unoccluded static lamps as mirror-like reflections (`patchPuddle` in `client/src/lighting/BakeShader.ts`); the night-sky environment map holds only the sky and the moon, never stand-in lamp glints. Bump `BAKE_VERSION` in `client/src/lighting/LightBaker.ts` when the baker changes; map edits invalidate the cache automatically.

## Combat

Solo play runs the same authoritative simulation the game server runs online (`shared/src/sim`). The client only sends intents (fire along the camera ray, reload, switch, melee, bandage, use) and renders the events that come back, so damage, ammunition and health never live in the client.

- Weapons: M4A1 assault rifle, MP5 submachine gun, M870 pump shotgun (shell-by-shell reload, interruptible), MK14 marksman rifle (penetrates one body), M17 pistol, machete. Pick the starting primary in Loadout, swap it at the garage weapon table.
- Ammunition is limited. Ammo crates refill reserves twice each; first aid boxes hold bandages (Q, 2.6 s, +40 HP, interrupted by damage).
- Zombies have head, torso, arm and leg hit zones (head ×2.5). They hear gunfire and footsteps, spot you in their sight cone (crouching shortens it), path through houses, pound and break doors, stagger and get knocked down.
- 45 seconds of preparation, then the outbreak: a growing population of walkers and no waves. Death ends a solo run with the results screen.
- Gore can be set to Off, Reduced or Full in Settings → Graphics.
- Gun sounds are modeled per weapon and rendered into buffers at startup (`client/src/audio/GunSynth.ts`): the muzzle blast pressure wave, the gas jet, the supersonic crack for the rifles, the steel ringing, a ground bounce and an overload stage. The M4A1 is sharp with a hard crack, the MP5 a rounder bark with the roller bolt clacking, the M870 a long deep boom, the MK14 the biggest crack and report, the M17 a short snappy pop with the slide snapping. Each gun has four takes picked at random with slight pitch variation, the action cycling under each shot (buffer spring, roller bolt, op-rod, slide), and its own reload, pump, charging handle and dry fire sounds. These are synthesized, not recordings: the free sound and impulse-response libraries (freesound.org, openairlib.net) are blocked from the build environment, so nothing here is measured against real recordings yet.
- Where a shot is heard decides how it sounds (`client/src/audio/Acoustics.ts`). Raycasts against the map sort each spot into street, room, hall (garages and the store, by their concrete floors) or basement, and each space has its own echo: on the street the facades slap a shot back one by one for about two seconds, a living room rings short and dull (0.8 s), a garage or the store longer (1.1 s), the concrete basement booms (1.5 s). A shot fired indoors also leaks, muffled, into the street echo, and a street shot leaks into the room you are in.
- Every shot that is not your own plays from where it was fired with 3D (HRTF) panning, late by its distance at 343 m/s and with less of its direct sound the farther it is. Walls between you and the gun muffle it by what they are made of (glass a little, wood and plaster a lot, brick and concrete almost entirely; `Physics.crossings` lists every surface on the line). A supersonic round passing within 10 m cracks from the point where it passed you, ahead of the report: loud for the M4A1 and MK14, faint for 9 mm and buckshot, none for the M17. At most 10 shots from others play at once; a nearer one takes over from the farthest. Online, other survivors' shots go through this same path from their positions.
- To hear or measure the gun sound, run `npm run dev` and open `/dev/gunclips.html`: **Render clips** plays each gun in each space and the distance, wall and fly-by cases through the game's own audio graph, with a save link per clip. `python3 -I client/dev/analyze_gunclips.py CLIPDIR OUTDIR` measures saved clips (C50, ring time, spectral centroid, crack and report timing), draws spectrogram sheets and joins each gun's four spaces into one A/B file.
- Aiming looks down the sights in first person: the camera moves into the survivor's eye and the weapon's sights line up with it. The M4A1 has a red dot, the MP5 a peep sight and hooded post, the M870 a fiber-optic bead, the M17 three-dot night sights and the MK14 a scope (zoomed view with a duplex reticle). Settings → Controls → Aim view switches back to the over-the-shoulder zoom.

## Survivors

Main menu → **Survivor** opens the character creator: a lit turntable preview (drag to turn, scroll to zoom, the camera frames the part you are editing) and twelve tabs.

- Body: 10 skin tones, slim / average / broad build. Face: 6 eye shapes (round, almond, wide, narrow, sleepy, fierce), 10 eye colors, 7 facial hair styles. Hair: 14 styles, 16 colors.
- Headwear: 31 pieces in three groups. Hats (caps, beanies, bucket, cowboy, fedora, flat cap, bandana, sweatband), helmets (hard hat, army, motorcycle, football, bike, firefighter, knight) and funny hats (traffic cone, party hat, propeller cap, chef hat, top hat, viking, cooking pot, tinfoil, crown, bunny ears, pirate, sombrero, rubber duck, lampshade).
- Tops: 18, from T-shirts, tank tops, button-ups, striped, Hawaiian and flannel shirts (buttoned or open over a tee) to sweaters, hoodies and denim, leather, varsity, track, puffer, rain and camo jackets. Fabrics are drawn in the shader (plaid, stripes, camo, floral, knit, denim) with a separate accent color.
- Bottoms (7), shoes (5), gloves (4), eyewear and masks (11), neck pieces (6), back items (backpack, hiking pack, messenger bag, katana, guitar) and gear (tactical and hi-vis vests, bandolier, utility belt, fanny pack, knee pads), each with a color from a 20-color cloth palette.
- Randomize, Reset and the survivor name live in the creator header. Choices save with the profile and the slung weapon sits on top of whatever is on your back.

The look is plain data (`shared/src/config/appearance.ts`): catalog ids plus palette indices, sent as a short versioned string (`"1.4.1.2…"`) in the join options. The simulation stores the sanitized string per player and the server sends it to everyone in the room, so other players see your survivor. Catalogs and palettes are append-only: never reorder or remove entries, because indices are the wire format. Zombies are dressed from the same catalog, with muddied clothes and glowing eyes.

## Online play

Main menu → Play → **Host game** makes a room on the game server: give it a name, make it public (listed under Join game) or private (code only), and send friends the five-character code. **Join game** lists the open public rooms and takes a code. In the room's lobby everyone marks ready and the host starts the night; up to four survivors.

- The server runs the night: the same simulation as solo, at 60 steps a second, with zombies, damage, ammunition, doors and supply drops decided there. It sends a compact snapshot 20 times a second and every event as it happens. Each client draws the others smoothed between snapshots and shows its own shots, reloads and swings at once.
- Hosting means creating the room and starting its nights; the room lives on the game server, not on the host's machine, so the night carries on if the host leaves (the next player who joined becomes host). This is not peer-to-peer.
- The server checks each survivor's movement (speed, climbing, walls, map bounds) and puts them back when it doesn't add up.
- When you die you can watch the others; when everyone is dead, everyone gets the team results and goes back to the lobby together.
- A room is locked while its night is playing, so friends join between nights.
- A connection that drops mid-night reconnects by itself: the server holds the survivor's place for 20 seconds (they stand still meanwhile) and the game shows CONNECTION LOST · RECONNECTING until it is back. After that it returns to the menu.
- The server streams a night to each player only once their scene is built, and allows a few seconds of stalls (a slow machine, a hitch) before it counts a connection as lost.

**Survivors and stats.** Each browser makes a player key (kept in local storage). The survivor's name, look and primary weapon are saved under it on the server whenever they change, along with lifetime stats: runs, kills, headshots, arms torn off, time survived, best time and most kills. Main menu → Leaderboards → Your survivor shows the key; entering it on another device brings the same survivor and stats there.

**Leaderboards.** Longest survival and most kills, one entry per player (their best run). Online runs are recorded by the server. Solo runs are reported by the browser at the end and marked SOLO: the server refuses ones that can't be right (more kills than the time allows, more hits than shots) and limits how often a key can post, but it cannot replay a solo run, so treat those as honest-player scores.

### Deploying

The client is a static site (`npm run build`, publish `client/dist`). The server is one Node process (`npm start`).

| Variable | Where | What |
| --- | --- | --- |
| `VITE_SERVER_URL` | client build | The server's address, `https://…` or `wss://…` (both work). |
| `PORT` | server | Port to listen on (default 2567). |
| `DATABASE_URL` | server | Postgres connection string. Tables are created on start. TLS is used for remote hosts unless `sslmode` or `PGSSLMODE` says otherwise. |
| `DATA_FILE` | server | Without `DATABASE_URL`: the JSON file for profiles and boards (default `server/data/dead-hours.json`). |
| `DEAD_HOURS_DEBUG` | server | `1` enables test commands in rooms (skip preparation, spawn zombies, hurt, full health). Never in production. |

`GET /health` answers `{ ok, version, store }`. The server logs one line per room event (opened, joined, left, lost connection, reconnected, night started, night over with each survivor's time and kills). The HTTP API sends CORS headers for any origin, and Colyseus answers `/matchmake` with its own. The server builds the map's navigation once at start (about two seconds) and each room builds its own physics.

## Controls

WASD move · Mouse look · Shift sprint · Ctrl or C crouch · Space jump · LMB fire · RMB aim down sights · R reload · E interact · F melee · 1 / 2 / wheel switch weapon · Q bandage · Tab inventory (hold) · V switch shoulder · Esc pause. All bindings are editable in Settings → Controls.

## Roadmap status

- **Phase 1 Foundation**: done.
- **Phase 2 Environment**: done. Maple Hollow, 250 × 250 m: Elm Street and Birch Lane with sidewalks, alleys and fourteen streetlights (a few dead, one flickering); ten houses (eight closed homes, the two-storey safehouse with kitchen, living room, three bedrooms, basement, garage and four ways in, and the enterable Henderson house); the Quik-Stop gas station with an enterable store; a park with playground and gazebo; a police checkpoint with a barrier chicane and floodlights; fenced backyards with sheds and tight side passages; woods around the edge. Baked AO, shadows and bounce light plus fog and dynamic lights.
- **Phase 3 Combat**: done. Six weapons with real models, hand IK, reload animations, recoil and holsters; muzzle flashes, tracers, shell casings and surface impacts; pooled blood, wounds, hit reactions and ragdoll deaths; zombie AI; weapon table, ammo crates and first aid; HUD with weapon panel, dynamic crosshair, hit markers, damage direction, timers and ammunition warning; inventory and results screen.
- **Character customization**: done (see Survivors).
- **Phase 4 Multiplayer**: done (see Online play). Hosted rooms with codes and a public list, the night run on the server, leaderboards and saved survivors.
- Phase 5 Survival director · Phase 6 Defenses · Phase 7 Helicopter drops · Phase 8 Polish.
