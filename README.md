# Night Chapters

**Gentle night flight through a personal sky.**

> **I want to see. I play.**

Not a military sim. Not a tracker. A soft aviation daydream on an observatory glass: you glide between **story pins**, discover **mystery** objects, and let the sky tell the chapter.

**Live repo:** [github.com/Dragon-Lady/Night-Chapters](https://github.com/Dragon-Lady/Night-Chapters)

---

## Play instructions

### Run locally

```bash
cd night-chapters          # clone path, e.g. ~/Projects/night-chapters
npm start
# → http://localhost:4343
```

### How to fly

1. Wait for the **canvas sky glass**.  
2. **Choose a night** (or press `1`–`4`).  
3. **Begin night** (`Enter` / `B`) — soft ambient starts.  
4. Raise **throttle** (`W`/`S` or `↑`/`↓`) — stars and scenery glide toward the heading bug; **spoons** drain.  
5. **`Space`** — rest; spoons recover; silence.  
6. On a story pin — read the whisper · **`N`** next · **`X`** skip (allowed).  
7. Near **✧** drift or **✦** chapter mystery — **`P`** to name it (saved to house pins + score).  
8. **`C`** closeout → **wonder reflection** · Back to nights or Fly again.  

### Keyboard

| Key | Action |
|-----|--------|
| `?` / `H` | Help |
| `E` | Export / share |
| `M` | Mute |
| `1`–`4` | Select chapter (menu) |
| `Enter` / `B` | Begin night |
| `W` / `↑` | Throttle up (+0.1) |
| `S` / `↓` | Throttle down (−0.1) |
| `N` | Next heading |
| `X` | Skip fix |
| `Space` | Rest |
| `P` | Pin / claim |
| `C` | Closeout |
| `Esc` | Close overlays |

### Export & share

- **Export** (header or `E`): download pins JSON, reflections JSON, full house backup, copy JSON, or share a short text summary.  
- Data is **local only** (this browser). Use export for backup/move.

### Chapters

| Night | Mood |
|-------|------|
| Soft Rainy Hold | rain |
| Gumdrop Summer | warm |
| Clear Cold Glass | cold |
| First Love Sky | rose |

---

## Deploy (Netlify)

Publish folder is **`public/`** (see `netlify.toml`).

1. Connect the GitHub repo in Netlify.  
2. **Publish directory:** `public`  
3. **Build command:** none required.  
4. Deploy → `https://<your-site>.netlify.app`

CLI:

```bash
netlify deploy --prod --dir=public
```

Full notes: [`docs/DEPLOY.md`](./docs/DEPLOY.md)

---

## Working feel

| It is | It isn’t |
|-------|----------|
| Light aviation *metaphor* | Weapons, dogfight, kill-chain |
| Story pins as meaning | Mission targets |
| Mystery as *oh* | Threat alerts |
| Bedtime glass cockpit | Full sim punishment |
| Personal / private layers | Competitive leaderboard |

---

## Stack

- Vanilla JS (ES modules)  
- Custom canvas night sky (`windshield.js`) — throttle pans stars & scenery  
- Web Audio ambients (no sample files)  
- localStorage progress / pins / reflections  

Docs: [`VISION`](./docs/VISION.md) · [`GAME_LOOP`](./docs/GAME_LOOP.md) · [`PROGRESS`](./docs/PROGRESS.md) · [`AUDIO`](./docs/AUDIO.md) · [`DEPLOY`](./docs/DEPLOY.md)

---

## Layout

```
public/           # deployed site root
  index.html
  css/  js/  data/nights/
docs/             # design + deploy notes
schema/           # entities + hooks
netlify.toml
```

---

## Lineage

| Project | Role |
|---------|------|
| **Dragon Eye** | Military / aviation tracking |
| **Dragon Lady’s Observatory** | Wonder-first free-glide + personal pins |
| **Night Chapters** | Chapter = flight plan of feeling |

---

## License

All rights reserved until an open license is chosen (see `LICENSE`).
