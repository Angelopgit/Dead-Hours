# Changelog

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
