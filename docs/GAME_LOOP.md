# Game loop — Night Chapters **core complete** v1.1 (multi-chapter)

**Status:** Core loop + chapters + **persistent progress & reflection**.  
**Version:** `CORE_LOOP_VERSION = 1.2.0`  
**Tagline:** *I want to see. I play.*  
**Progress docs:** [`PROGRESS.md`](./PROGRESS.md)

## Guided chapters (MENU)

Pick a night before **Begin**:

| Id | Title | Sky mood | Route feel |
|----|--------|----------|------------|
| `soft-rainy-hold` | Soft Rainy Hold | rain | M42 → Vega → M51 |
| `gumdrop-summer` | Gumdrop Summer | warm | Altair → Vega → Deneb (Mellinger) |
| `clear-cold-glass` | Clear Cold Glass | cold | Cassiopeia → Polaris → M31 |
| `first-love-sky` | First Love Sky | rose | Pleiades → Hyades → Double Cluster |

Each chapter has unique story pins, 2 drift mysteries, 1 chapter mystery, and a `score` table + `sky` FX profile.  
JSON: `public/data/nights/*.json` · catalog: `nights.js` `CHAPTER_INDEX`.

---

## State machine

```
BOOT → MENU → FLIGHT ⇄ ARRIVE
                ⇄ MYSTERY   (drift glow or chapter mystery)
                ⇄ REST      (Space / Rest · spoons recover)
              → CLOSEOUT → MENU (Begin night again)
```

| State | Glass | Player |
|-------|--------|--------|
| **BOOT** | Load Aladin + FX + catalogs | Wait for sky |
| **MENU** | Parked; pin/mystery overlays | **Begin night** |
| **FLIGHT** | Soft throttle glide to heading bug | Throttle · notice ✧ · Space rest |
| **ARRIVE** | Docked on story pin | Beat · **Next** / **Skip** / Rest |
| **MYSTERY** | Near drift or chapter glow | **P** claim (optional) · keep gliding |
| **REST** | Throttle forced ~0 | Spoons recover · throttle/Space to resume |
| **CLOSEOUT** | Score + **wonder reflection** overlay | Back to nights / Fly again |

---

## FLIGHT (fully implemented)

Each frame while `FLIGHT` or `MYSTERY`, throttle > 0.04, spoons > 0, not resting:

1. **`tickSpoons(dt)`** — drain scales with throttle.  
2. **`glideStep(target, throttle)`** — eased Aladin move toward heading bug (next story pin, then chapter mystery).  
3. **Drift mysteries** — `night.drift_mysteries[]`: notice ~4°, enter MYSTERY ~1.35°.  
4. **Story arrive** — dist < 0.35° → **ARRIVE** · score +10 · pin marked discovered.  
5. Instruments: heading, spoons bar, wonder score, discoveries, ribbon, FX throttle.

**Controls**

| Input | Action |
|-------|--------|
| Throttle slider | Glide speed (default soft) |
| **Space** / Rest | Enter **REST** (toggle resume if spoons ok) |
| Next heading | Leave ARRIVE/MYSTERY/REST → FLIGHT toward current bug |
| Skip fix | Skip story pin (allowed, +0 score) |
| Closeout | End night anytime after start |

---

## REST + spoon fuel (fully implemented)

| Action | Effect |
|--------|--------|
| Glide | Deplete (~90s full→empty at continuous max throttle) |
| **REST** / Space / throttle ≈ 0 | Recover (~45s empty→full continuous rest) |
| Spoons ≈ 0 | Auto **REST**; whisper; **no game over** |
| Throttle up after rest | Resume prior flight-like state when spoons > 2% |

Wonder-first: empty spoons mean *rest*, not fail.

---

## MYSTERY (fully implemented)

| Kind | Source | Claim |
|------|--------|--------|
| **Drift** | Mid-path `drift_mysteries` during FLIGHT | P → name → localStorage pin `kind: drift` · **+25** |
| **Chapter** | After story ribbon `night.mystery` | P → name → pin `kind: chapter` · **+40** |

- Objects **appear** as catalog markers + ribbon chips when noticed.  
- Claim optional; Next / glide always allowed.  
- Reticle gold pulse in MYSTERY.  
- Leaving drift field returns to FLIGHT (unless on chapter target).

---

## Personal pins + scoring (fully implemented)

### Save / visuals

- **localStorage** `night-chapters.personalPins.v1`  
- Aladin catalog overlays (blue story/house · gold mystery)  
- **House pins** panel: fly-to, delete  
- Free **P** (not near mystery) → personal pin · **+5**

### Wonder score (pins discovered)

Defaults (overridden per chapter via `night.score`):

| Discovery | Default | Notes |
|-----------|---------|--------|
| Story pin arrived | +10 | e.g. First Love +14 |
| Drift mystery claimed | +25 | varies by chapter |
| Chapter mystery claimed | +40 | varies |
| Free personal pin | +5 | varies |
| Perfect chapter bonus | +15 | all story + all drift + chapter mystery |
| Skip story pin | +0 | allowed |

- **Pins discovered** = story + drift + chapter + free count  
- **House best** → `night-chapters.bestWonderScore.v1`  
- **Chapter best** → `night-chapters.chapterBest.v1` (map by night id)  

Not a combat score — curiosity only.

---

## Frame order (reference)

```
rAF tick:
  if no session → meters only
  if ACTIVE night:
    tickSpoons
    if empty → enterRest
    if REST → recover, maybe leaveRest
    if ARRIVE → parked
    if FLIGHT|MYSTERY && throttle:
      glideStep
      notice/near drift → MYSTERY
      near chapter mystery → MYSTERY
      near story pin → ARRIVE
    renderMeters
```

---

## Files

| Module | Role |
|--------|------|
| `game-loop.js` | States, tick, controls, claim flows |
| `flight.js` | Session, spoons, score, drift helpers |
| `pins.js` | localStorage pins + house UI |
| `windshield.js` | Aladin + glide + overlays + FX |
| `fx-layer.js` | Particles / sky veil |
| `nights.js` + `data/nights/*.json` | Chapters |

---

## Wonder-first rules (locked)

- Default throttle low  
- Rest never costs progress or score  
- Skip allowed  
- Score = discovery, not speedrun  
- Spoons empty → rest, never crash  
- No weapons, no fail state  

---

## Play smoke (manual)

1. `npm start` → http://localhost:4343  
2. Begin night · raise throttle · glass glides  
3. Space → REST · spoons climb · throttle again → FLIGHT  
4. Pass near ✧ · P to name · house pin appears  
5. Finish ribbon · chapter ✦ · claim · closeout score  

Core loop **done**. Later: more nights, companion voice, postcard share.
