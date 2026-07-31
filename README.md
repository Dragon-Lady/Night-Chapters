# Night Chapters

**Gentle night flight through a personal sky.**

> **I want to see. I play.**

Not a military sim. Not a tracker. A soft aviation daydream on an observatory glass: you glide between **story pins**, discover **mystery** objects, and let the sky tell the chapter.

---

## Working feel

| It is | It isn’t |
|-------|----------|
| Light aviation *metaphor* — heading, soft bank, glide | Weapons, IFF, dogfight, kill-chain |
| Story pins as waypoints of meaning | Mission targets / threat rings |
| Mystery as *oh* at the reticle | T1 alerts |
| Bedtime glass cockpit | Full sim punishment model |
| Personal / private layers | Public scoreboard of who flew best |

**Tone:** low light, rain optional, dogs allowed on the seat. Speed is glide, not afterburner. Failure is soft: drift, re-center, try another heading.

---

## Lineage

| Project | Role |
|---------|------|
| **Dragon Eye** | Military / aviation *tracking* |
| **Dragon Lady’s Observatory** | Wonder-first free-glide + personal pins (Aladin spine) |
| **Night Chapters** | Same soul — **chapter = flight plan of feeling** |

Born from cottage weekend build schemas (Observatory sequel track) and the Night Chapters design brief: story arcs as playable sky, with a gentle flight layer on top.

---

## Core loop

```
Pick a Night → Glide → Arrive pin → Tiny beat → Next heading
                ↘ Mystery claim (name it yours)
                ↘ Rest / leave anytime
End → Optional postcard · personal pin · soft closeout
```

---

## Mechanics (high level)

1. **Glide camera** — the craft *is* attention; throttle is how fast the sky drifts; “rest” almost parks you.  
2. **Story pins** — nav fixes with a heart (place, label, emotion, one tiny beat).  
3. **Chapter ribbon** — constellation path between pins, not an airway chart.  
4. **Mystery reticle** — one unlabeled glow per night; **pin / name** is the win.  
5. **Soft instruments** — optional: altitude of attention (FOV depth), fuel of the night (spoons/time), nav log for closeout.  
6. **Companion** (optional) — quiet right-seat crumbs; mute always; never ATC drill.

See [`docs/VISION.md`](./docs/VISION.md) and [`schema/`](./schema/) for entities and hooks.

---

## Status

**v0.2** — Aladin windshield, Soft Rainy Hold, **FLIGHT/MYSTERY expanded**: drift mysteries during glide, spoon fuel drain/recover, pin overlays + house pin panel, wonder score from discoveries.

### Run locally

```bash
cd ~/Projects/night-chapters   # or your clone
npm start
# → http://localhost:4343
```

Or serve `public/` with any static server.

### Play (gentle)

1. Wait for the sky glass (Aladin).  
2. **Begin night** — Soft Rainy Hold.  
3. Nudge **throttle**; glass glides toward the heading bug.  
4. On arrive: read whisper · **Next heading** or **Skip fix** (allowed).  
5. **Rest** / `Space` — no failure.  
6. Near mystery: **P** or **Pin / Claim** to name it yours.  
7. **Closeout** — nav log three-liner.

### Layout

```
public/           # playable static app
  index.html
  css/night.css
  js/             # game-loop, windshield, flight, pins, nights
  data/nights/    # chapter JSON
data/nights/      # same chapters (repo source copy)
docs/             # VISION, GAME_LOOP, example night
schema/           # entities + hooks
```

Cottage continuity (private): `~/cottage/` · Observatory: Dragon-Lady-Observatory.  
This repo is the **Night Chapters** public home.

---

## License

TBD by owner. All rights reserved until stated otherwise.
