# src/

v0 playable shell lives under **`public/`** (static Aladin + ES modules):

| Path | Role |
|------|------|
| `public/index.html` | Cockpit chrome |
| `public/js/windshield.js` | Aladin glass |
| `public/js/flight.js` | Soft throttle / heading / fuel-of-night |
| `public/js/game-loop.js` | BOOT→MENU→FLIGHT→…→CLOSEOUT |
| `public/js/pins.js` | Personal waypoints (localStorage) |
| `public/js/nights.js` | Chapter loader |
| `public/data/nights/` | Night JSON |
| `docs/GAME_LOOP.md` | Loop sketch |

Run: `npm start` → http://localhost:4343
