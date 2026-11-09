# Changelog

## Unreleased

### Downtown

- Court Street, Vesper's downtown, runs east off Pell Lane a block north of Hale Street. Eight stores you can go into face each other across it: the savings bank with its columns and vault, the hardware store, Dot's Diner, the coin laundry, the corner drugstore, Kline's Market, the army surplus and the Lamplighter tavern.
- Each store has its own sign, plate glass you can break and climb through, a back door onto a service alley, and things worth the walk: ammunition in the bank vault and the surplus, first aid in the drugstore, melee weapons in the hardware store and the surplus.
- Court Square sits at the end of the street: lawns, benches, lamps and a flagpole, with a parking lot across from it.
- The town's water tower stands past the square with VESPER on its tank and a red light on top that shows through the fog. Two paths lead back to the alley behind Hale Street.
- Three more cars you can drive are parked downtown.

### Controllers

- Button prompts are drawn as the buttons on your pad: Xbox, PlayStation (DualSense and DualShock), Nintendo or a generic pad, picked from the one plugged in or set by hand in Settings.
- A bar along the bottom of every menu says what the buttons do there. A Nintendo pad confirms with A on the right and goes back with B, as its own menus do.
- Every menu works with a pad alone, including the menu's folded sections, the armory, the creator and the settings. The right stick turns the gun or the survivor on screen.
- Every action in a night has a button. Hold LB to ready a grenade and press Y while it is held to switch to a Molotov. Hold Y for the gunsmith, hold B to go prone, hold D-pad up to switch shoulders, and hold D-pad down at a window to board it up.
- Move any button to another in Settings, or pick the Standard, Tactical or Southpaw layout. You can also swap sticks, set each stick's dead zone with a live meter, set look speed, and invert look apart from the mouse.
- Rumble on shots, hits, blasts, hard landings, going down and dying, with a strength slider and a test button.
- A short note when a pad is plugged in or goes away. Unplugging the pad you play with pauses the night.
- Moving the mouse or touching the screen hands control back, and any button or a firm push on a stick takes it again. A button held when a menu closes no longer acts in play.
- Chat from the pause menu with the on-screen keyboard in online nights.

### Loading

- The game opens to the menu about twice as fast on a first visit. The lighting is worked out on every core of your computer instead of one, and what only a night needs (its code and the zombies' paths) is got ready while you are on the menu. The online client loads when you first go online.
- The page downloads less than half as much script before the menu, and a host that reads `_headers` keeps the files cached between visits.

## 0.5.0 (2026-11-04)

### A night with a point

- Every night now has three goals, picked from the night's seed. Boarding up always comes first, and the other two change from night to night: head shots, kills up close, torn-off arms, screamers, brutes, hordes held off, supply drops emptied, the raiders, kills with grenades or fire. Goals grow with the team and pay 150 XP each to everyone in the night.
- Your first two nights walk you through the hour before they come: board a window, pick up supplies, check your gear.

### How it looks

- A new logo: HOURS with a clock for its O, set in Big Shoulders Display, worn at the edges.
- New type throughout: Big Shoulders Display for titles, Barlow Semi Condensed for text, and Special Elite for the one typewritten line on a screen.
- Panels are warm black card stock with a fine grain and an orange top rule. Checkboxes are square boxes with a tick, and choices are rows of stamped boxes.
- The loading screen shows the street you are about to play on, with a tip that is true.
- Survivors and zombies are smooth shaded, and sofas, armchairs and beds have soft, rounded cushions.
- Armory labels wait for the gun before they appear, so they no longer pile up in one spot.

### How it sounds

- A theme, "Count the Hours", played on piano over the drone in the menu. During a night, pieces of it come back in the quiet stretches.

### How it reads

- The town is Vesper, Ohio. The safehouse is on Hale Street, with Pell Lane and Kinney Street nearby. The corner store is Rudy's, the house across the road is the Mercer house, the rare serum is Halberg serum, and the rare rifle is the LR-338.
- New tagline: "Board the windows. Count the hours."
- Every notice, hint and tag was rewritten in plain sentences. See `docs/style.md`.

### Under the hood

- ESLint, an `.editorconfig`, a LICENSE, and `npm run check`, which runs every check in one go.
- A CI workflow that runs the typecheck, lint, checks and build on every push.
- Sounds for skateboards, bikes and cars live in `WheelSounds.ts`, supply drops in `Airdrops.ts`, and the head and outfit kit in `OutfitHead.ts` and `OutfitKit.ts`.

## 0.4.1 and earlier

See the git history.
