# Online play

Main menu → Play → **Host game** makes a room on the game server: give it a name, make it public (listed under Join game) or private (code only), and send friends the five-character code. **Join game** lists the open public rooms and takes a code. In the room's lobby everyone marks ready and the host starts the night; up to four survivors.

- The server runs the night: the same simulation as solo, with zombies, damage, ammunition, doors and supply drops decided there. Survivors, shots and damage run at 60 steps a second; zombies and the collision world move every third step (20 a second, with each snapshot), which keeps a busy night near a tenth of a CPU core (see Running many games). It sends a compact snapshot 20 times a second and every event as it happens. Each client draws the others smoothed between snapshots and shows its own shots, reloads and swings at once.
- Hosting means creating the room and starting its nights; the room lives on the game server, not on the host's machine, so the night carries on if the host leaves (the next player who joined becomes host). This is not peer-to-peer.
- The server checks each survivor's movement (speed, climbing, walls, map bounds) and puts them back when it doesn't add up.
- When you die you can watch the others; when everyone is dead, everyone gets the team results and goes back to the lobby together.
- A room is locked while its night is playing, so friends join between nights.
- A connection that drops mid-night reconnects by itself: the server holds the survivor's place for 20 seconds (they stand still meanwhile) and the game shows CONNECTION LOST · RECONNECTING until it is back. After that it returns to the menu.
- The server streams a night to each player only once their scene is built, and allows a few seconds of stalls (a slow machine, a hitch) before it counts a connection as lost.

**Survivors and stats.** Each browser makes a player key (kept in local storage). The survivor's name, look and primary weapon are saved under it on the server whenever they change, along with lifetime stats: runs, kills, headshots, arms torn off, time survived, best time and most kills. Main menu → Leaderboards → Your survivor shows the key; entering it on another device brings the same survivor and stats there.

**Accounts.** Main menu → Account signs in with Google or Discord (whichever the server has keys for). Guests keep playing exactly as before; signing in ties the survivor, stats, places (and unlocks) to the account instead of the browser key, so every device signed in plays as the same survivor.

- Signing in folds the browser's guest profile into the account: the first time it simply becomes the account's survivor; later ones add their totals and keep the better bests, and the account's look stays. A Google and a Discord login with the same verified email are the same account.
- The sign-in runs in a popup (the whole page goes there and back when popups are blocked). The server does the OAuth code exchange itself, so the client never sees the service's tokens; it hands the game a one-time code (a minute, single use, bound to a nonce the game made) that `POST /api/auth/exchange` trades for a session. Sessions last 180 days, are stored hashed, and are sent as `Authorization: Bearer`. Sign-ins only ever return to an address in `CLIENT_ORIGINS`.
- Boards mark signed-in players with ✓. Online rooms count a signed-in player's runs for their account.
- Routes: `GET /auth/{google,discord}/start?return&nonce`, `GET /auth/{provider}/callback`, `GET /api/auth/providers`, `POST /api/auth/exchange`, `POST /api/auth/logout`, `GET /api/me`.

**Voice and text chat.**

- Voice goes straight between the players' browsers (WebRTC); the game server only passes the connection setup along and never hears it. Opus, mono, up to 40 kb/s, with in-band error correction and silence suppression, and the browser's echo cancellation, noise suppression and auto gain (each can be turned off in Settings → Voice).
- Push to talk (hold T) by default, or voice activation with an activation level. Settings → Voice has the microphone list, a mic meter with TEST MIC, the keys, and a list of blocked players.
- In play each voice comes from that survivor's mouth in 3D, gets quieter with distance, fades out between 35 and 50 m and is muffled through walls. Hold B for the team radio: everyone hears it at full level through a narrow radio sound with a squelch, and a survivor who has fallen is heard over it whenever they talk (Settings → Voice → Hear team radio turns it off). In the lobby everyone is heard plainly.
- Speaking lights show in the lobby list, over name tags and in a list at the left of the screen. Each player can be muted, turned down or up (0 to 200 %), have their chat hidden, or be blocked, from the lobby or Esc → Players. These choices stay in the browser by the player's lasting id. Blocking is also enforced by the server: no chat or voice either way.
- Text chat works in the lobby and in play (Enter opens it, Enter sends, Esc closes). The server cleans every line (control, direction and invisible characters, stacked accents), cuts it to 160 characters, allows a burst of 4 lines and then one every 1.5 s, drops a repeat sent within 4 s, and stars out a word list (including spaced-out and number-for-letter spellings). Lines are put on the page as text, never as HTML.
- Players behind strict networks (some offices, schools, mobile carriers) can only connect through a TURN relay: set `TURN_URLS` (see Deploying). Settings → Voice → Relay only sends all voice through it, which also hides a player's address from the others.

**Leaderboards.** Longest survival and most kills, one entry per player (their best run). Online runs are recorded by the server. Solo runs are reported by the browser at the end and marked SOLO: the server refuses ones that can't be right (more kills than the time allows, more hits than shots) and limits how often a key can post, but it cannot replay a solo run, so treat those as honest-player scores.

## Deploying

The client is a static site (`npm run build`, publish `client/dist`; its `_headers` file sets long caching for the hashed files on Cloudflare Pages and Netlify, other hosts should do the same for `assets/`). The server is a Node process (`npm start`); several can share the games (see Running many games).

| Variable | Where | What |
| --- | --- | --- |
| `VITE_SERVER_URL` | client build | The server's address, `https://…` or `wss://…` (both work). |
| `PORT` | server | Port to listen on (default 2567). |
| `DATABASE_URL` | server | Postgres connection string. Tables are created on start. TLS is used for remote hosts unless `sslmode` or `PGSSLMODE` says otherwise. |
| `DATA_FILE` | server | Without `DATABASE_URL`: the JSON file for profiles and boards (default `server/data/dead-hours.json`). |
| `STUN_URLS` | server | Comma-separated STUN servers given to browsers for voice. Unset: Google's public `stun:stun.l.google.com:19302`. Set empty: none. |
| `TURN_URLS` | server | Comma-separated TURN relays for voice, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp`. Needs one of the two logins below. |
| `TURN_SECRET` | server | coturn's `static-auth-secret` (`use-auth-secret`): each player gets their own TURN login that expires after 24 hours. |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | server | A fixed TURN login instead of `TURN_SECRET`. |
| `REDIS_URL` | server | Redis shared by several server instances (Railway Redis, Render Key Value...), `redis://…` or `rediss://…`. Unset: one process on its own. |
| `MAX_ROOMS` | server | Games one server process runs before new ones go to another or are refused (default 8). |
| `SELF_HOSTNAME` | server | With `REDIS_URL`: this instance's private address, only if it can't find it itself. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | server | Google sign-in (an OAuth client of type Web application). Redirect URI: `<server address>/auth/google/callback`. |
| `AUTH_DISCORD_ID`, `AUTH_DISCORD_SECRET` | server | Discord sign-in (an application's OAuth2 client id and secret). Redirect: `<server address>/auth/discord/callback`. |
| `CLIENT_ORIGINS` | server | Comma-separated addresses the game is played from, e.g. `https://play.example.com,https://deadhours.pages.dev`. Sign-ins return only to these (localhost works when it is unset). |
| `AUTH_SECRET` | server | A long random string that signs sign-in state. Needed with several instances; one process makes its own on start. |
| `PUBLIC_URL` | server | The server's public `https://` address for the redirect URIs. When unset: Railway's `RAILWAY_PUBLIC_DOMAIN`, Render's `RENDER_EXTERNAL_URL`, else the request's forwarded host. Set it when the server has its own domain. |
| `DEAD_HOURS_DEBUG` | server | `1` enables test commands in rooms (skip preparation, spawn zombies, hurt, full health). Never in production. |

Accounts need a store (Postgres, or the data file on a single server). Sign-in is off until a provider's id and secret are set; the menu then says sign-in isn't available and guests play as before.

`GET /health` answers `{ ok, version, store, games, maxGames, forwarded }` (the last three for this process). The server logs one line per room event (opened, joined, left, lost connection, reconnected, night started, night over with each survivor's time and kills). The HTTP API sends CORS headers for any origin, and Colyseus answers `/matchmake` with its own. Messages to the game server are capped at 16 kB (voice setup needs a few kB). A TURN relay needs open UDP ports, which web app hosts such as Render don't offer: run coturn on a small VPS or use a managed TURN service, and keep the secret out of the client. The server builds the map's navigation once at start (about two seconds) and each room builds its own physics.

## Running many games

A busy game (four survivors, two dozen zombies) takes about a tenth of one CPU core on the server, and a game waiting in its lobby next to nothing. Measured with `npm run load -w server` (bots playing real nights, four to a game, each with 24 extra zombies) on a 4-core machine:

| Games | Server processes | Server CPU | Snapshots per player per second (20 is full rate) |
| --- | --- | --- | --- |
| 3 | 1, version 0.3.9 | 104 % of a core | 18.8 |
| 5 | 1 | 47 % | 20 |
| 10 | 1 | 91 % | 18.4 |
| 15 | 1 | 103 % (out of CPU) | 7.5 |
| 25 | 3 | 256 % (85 + 78 + 92) | 19.3 |

- One process runs all its games on one core, so a second CPU on the same instance goes unused: pick 1-CPU instances and add more of them rather than bigger ones.
- `MAX_ROOMS` (default 8) caps the games in one process, so a full process still has CPU to spare for its busiest nights. A new game goes to the process running the fewest; when every process is at its cap, Host game shows SERVERS ARE FULL with Try again, Join a game and Play solo. Players can still join the games that exist.
- Several instances: give the service `REDIS_URL` (a Render Key Value in the same region, its internal URL) and `DATABASE_URL` (a data file isn't shared between instances), then raise the instance count. Each game lives on one instance; Redis shares matchmaking, the game list, join codes and each instance's game count. Render's load balancer hands each connection to any instance, so one for a game elsewhere is passed through to that instance over the private network. Each instance finds its private address through `RENDER_DISCOVERY_SERVICE` (or `SELF_HOSTNAME`). This needs paid instances (free ones can't receive private traffic) and no persistent disk on the service (a service with one can't run several instances).
- Without `REDIS_URL` the server runs on its own as before.
- A deploy or a stopped instance ends the games on it, as with one server; games on the other instances carry on.
- `GET /health` gives `games`, `maxGames` and `forwarded` (connections passed to another instance) for the instance that answered.

