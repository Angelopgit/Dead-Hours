# Dead Hours

Co-op zombie survival that runs in the browser. Hold a house in a small town through the night, alone or with up to three friends. No install, and solo play needs no server.

![A horde of walkers, runners and brutes coming down Elm Street](docs/screenshots/hero.jpg)

| | |
| --- | --- |
| ![Main menu over the night street](docs/screenshots/menu.jpg) | ![Firing the M4A1 as the horde closes in](docs/screenshots/firing.jpg) |
| ![A basement under one of the homes](docs/screenshots/basement.jpg) | ![Character creator](docs/screenshots/creator.jpg) |

## What's in it

- **One town, one night.** Three streets, a gas station, a park and a police checkpoint. Every house can be entered and some have basements. You get 45 seconds to gear up, then the dead keep coming, with horde waves, a raider van and short lulls when a supply helicopter comes in.
- **Guns.** Ten of them, from the M17 pistol to a .50 cal and a rocket launcher, plus found melee weapons. Aim down real sights, attachments unlocked by levelling up, recorded gunshots and reloads, and sound that changes with the room you're in.
- **Zombies you can take apart.** Walkers, runners, brutes, screamers, bloaters and crawlers. Shoot off arms and legs, pick an arm up and club with it, blow heads apart.
- **Hold the house.** Board up doors and windows, shoot through glass and wooden doors, vault out of windows when it goes wrong.
- **Get around.** Skateboards, bicycles with pegs for a passenger, and a few cars with limited gas.
- **Play together.** Host a room and share a five-character code, or join an open one. Proximity voice, team radio, text chat, revives, leaderboards, and Google or Discord sign-in.
- **Your survivor.** A character creator with dozens of hats, tops, hairstyles and bits of gear. Zombies wear the same clothes, muddied.

Works with mouse and keyboard, a gamepad, or touch on a phone held sideways.

## Running it

```bash
npm install
npm run dev          # client on http://localhost:5173
npm run dev:server   # game server on http://localhost:2567, for online play
npm run build        # production client into client/dist
```

Node 22. Solo play works with just the client. See [docs/development.md](docs/development.md) for the code layout and the headless checks, and [docs/online.md](docs/online.md) for deploying the server.

## Controls

| | Keyboard and mouse | Gamepad |
| --- | --- | --- |
| Move, look | WASD, mouse | sticks |
| Fire, aim down sights | left / right mouse | RT / LT |
| Reload, use | R, E | X, RB |
| Sprint, jump | Shift, Space | L3, A |
| Crouch, prone | C, Z | tap B, hold B |
| Melee, bandage | F, Q | R3, LB |
| Switch weapon | 1 / 2, wheel | Y |
| Grenade, Molotov | 3, 4 | |
| Board up (hold) | G | D-pad down |
| Flashlight | L | D-pad up |
| Gunsmith in the field | H | |
| Push to talk, team radio | T, B | D-pad left, right |
| Chat | Enter | |

Everything can be rebound in Settings → Controls. On a skateboard, Space ollies and a direction with it does a flip trick; on a bike, fire rings the bell.

## Docs

- [docs/development.md](docs/development.md): running, checks and benches, code layout
- [docs/gameplay.md](docs/gameplay.md): combat, gore, sound, barricades, vehicles, progression, survivors
- [docs/rendering.md](docs/rendering.md): baked lighting, volumetric fog, rain, post-processing
- [docs/online.md](docs/online.md): rooms, accounts, voice and chat, deploying, running many games
- [docs/trailer.md](docs/trailer.md): rendering the trailer from the game
- [docs/screenshots.md](docs/screenshots.md): more screenshots

## Credits

Made by Angelo. Built on [three.js](https://threejs.org), [Rapier](https://rapier.rs), [Colyseus](https://colyseus.io), [GSAP](https://gsap.com) and [Vite](https://vite.dev). Typefaces: Oswald (Vernon Adams) and Inter (Rasmus Andersson), SIL Open Font License.

### Sound

All recordings are CC0 (public domain dedication) from [Freesound](https://freesound.org); credit is not required but given. The game uses the high-quality previews, cut and processed by `client/dev/make_recorded_sounds.py`.

| Used for | Recording | Author |
| --- | --- | --- |
| M17, MP5 | [9mm Pistol Gunshots](https://freesound.org/s/731942/) | DledeSOUND |
| M4A1, M249 | [AR15 pistol shot](https://freesound.org/s/427598/) | michorvath |
| MK14 | [gun lee enfield 303 rifle clean shot](https://freesound.org/s/450853/) | kyles |
| M870 | [Shot Gun - 12 Gauge- Fire Four Shots Quickly](https://freesound.org/s/619041/) | mrrap4food |
| SCAR-H | [FN SCAR-H](https://freesound.org/s/702225/) | areniporgen |
| M107 | [50CaliberOnePigRoast2012](https://freesound.org/s/169170/) | kvgarlic |
| M107 | [50 cal shot](https://freesound.org/s/668071/) | ajhartman42295 |
| Flesh hits | [VisceralBulletImpacts](https://freesound.org/s/423301/) | u1769092 |
| Flesh hits (wet) | [Wet Splat 1](https://freesound.org/s/495118/) | nebulasnails |
| Flesh hits (wet) | [GROSS IMPACT](https://freesound.org/s/641040/) | magnuswaker |
| Headshots | [Headshot](https://freesound.org/s/511194/) | Pablobd |
| Heavy and melee hits | [Major punch](https://freesound.org/s/399183/) | janbezouska |
| Flashlight switch | [flashlight click](https://freesound.org/s/629008/) | realgtro |

Reloads (magazines out and in, bolts and slides going home, shells into the tube, the pump, the M249's feed cover) are cut from [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney, released CC0: its raw 192 kHz tracks, from the [GitHub mirror](https://github.com/buddingmonkey/FreeFirearmsSFXLibrary) at commit beb2f40. AR-15 for the M4A1, SCAR-H and M249; Walther PPQ for the M17; Benelli Nova and Winchester Model 12 for the M870; Carl Gustav M45, AK-47 and SKS for the MP5; AK-47, Tikka T3 and SKS for the MK14 and M107; Mosin Nagant and Arisaka hatches for the M249's cover.

