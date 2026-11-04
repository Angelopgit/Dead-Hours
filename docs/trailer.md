# Trailer

The cinematic trailer is rendered by the game itself. `?trailer=1` on the dev server starts a solo night with four computer-driven survivors (`shared/src/sim/Squad.ts`: sim players walked along paths that pick targets, fire in bursts and reload, drawn like online teammates) and a director (`client/src/gameplay/Trailer.ts`) that steps the engine frame by frame through a list of shots (`TrailerShots.ts`: each places the cast, spawns the dead, starts a car, throws a Molotov, calls the raid or a supply drop, and moves the camera along keys). Nothing plays in real time, so a software GL is fine:

```bash
npm run dev                                                   # the dev server the renderer loads
npm run trailer -- --out /tmp/trailer [--every 15] [--shots street,horde]   # frames (JPEG), manifest.json, audio.wav
npm run trailer:cut -- --out /tmp/trailer --url play.example.com           # title cards, score, fades: dead-hours-trailer.mp4
```

A whole render takes about two hours on a software GL, so it goes in parts: `--shots` a few at a time, each to its own folder, then `node client/tools/trailer/join.mjs --out /tmp/trailer --parts /tmp/trailer/a,/tmp/trailer/b` puts the frames and sound together for the cut (a crash costs one part, and `--seed` makes every part the same night).

`render.mjs` drives headless Chromium (Playwright) and writes a frame per step; `--every N` draws one frame in N for a quick look at the shots. Every sound the frames make is logged with the camera and played again, offline, through the game's own audio engine into `audio.wav`, in sync. `assemble.mjs` draws the title cards (`card.html`, the game's typefaces), synthesizes the score to the cut (`score.py`, numpy) and runs ffmpeg. Don't edit `client/src` while a render runs: the dev server reloads the page.

