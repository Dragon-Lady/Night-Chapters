# Game loop — Night Chapters v0.2

## States

```
BOOT → MENU → FLIGHT ⇄ ARRIVE
                ⇄ MYSTERY (drift or chapter)
                ⇄ REST (throttle ≈ 0, spoons recover)
              → CLOSEOUT → MENU
```

| State | Glass | Player |
|-------|--------|--------|
| **BOOT** | Load Aladin windshield + catalogs | Wait for sky |
| **MENU** | Parked; overlays show story/mystery seeds | Begin night |
| **FLIGHT** | Soft glide toward heading bug | Throttle; notice ✧ drift glows |
| **ARRIVE** | FOV on story pin | Beat (sit / emotion) · Next / Skip |
| **MYSTERY** | Near drift or chapter glow | **P** to name & save pin · or keep gliding |
| **REST** | Throttle ≈ 0 | Spoons recover; no failure |
| **CLOSEOUT** | Nav log + wonder score | Begin again optional |

## FLIGHT phase (expanded)

Each animation frame while gliding (`throttle > 0.04` and spoons > 0):

1. **tickSpoons(dt)** — drain scales with throttle.  
2. **glideStep** toward current waypoint (next story pin, then chapter mystery).  
3. **Drift mysteries** — if within notice radius (~4°), mark noticed; within near radius (~1.35°) enter **MYSTERY** with drift hook (optional claim).  
4. If angular distance to story pin < arrive threshold → **ARRIVE**.  
5. Update instruments: heading, spoons bar, wonder score, discoveries, ribbon.

Leaving a drift field returns to FLIGHT without penalty.

## MYSTERY phase (expanded)

Two kinds:

| Kind | When | Claim |
|------|------|--------|
| **Drift** | Mid-path glows from `night.drift_mysteries[]` | P → name → house pin `kind: drift` · +25 score |
| **Chapter** | After story ribbon; `night.mystery` | P → name → house pin `kind: chapter` · +40 score |

- Claim is optional. Keep gliding / Next heading always allowed.  
- Reticle soft-pulses gold in MYSTERY.  
- Catalog markers: gold for mysteries, blue for story/personal pins.

## Spoon fuel

| Action | Effect |
|--------|--------|
| Glide | Deplete (faster at high throttle) ~90s full→empty at max continuous glide |
| Rest / Space / throttle ~0 | Recover ~45s empty→full continuous rest |
| Spoons ≈ 0 | Auto rest; whisper; **no game over** |

Wonder-first: empty spoons mean *rest*, not fail.

## Personal pins (visual + save)

- **localStorage** key `night-chapters.personalPins.v1`  
- Aladin catalog overlays + **House pins** panel (fly-to / delete)  
- Kinds: `personal` · `drift` · `chapter`  
- Free **P** away from mystery → personal pin · +5 score  

## Wonder score (pins discovered)

Not a combat score — curiosity only.

| Discovery | Points |
|-----------|--------|
| Story pin arrived | +10 |
| Drift mystery claimed | +25 |
| Chapter mystery claimed | +40 |
| Free personal pin | +5 |
| Skip story pin | +0 (allowed) |

**Pins discovered** count = story + drift + chapter + free pins.  
**Best wonder** saved in localStorage across nights.

## Events (schema hooks)

- `on_night_start` · `on_glide` · `on_pin_arrive` · `on_fly`  
- `on_mystery_near` (drift or chapter) · `on_mystery_claim`  
- `on_rest` · `on_closeout`  

## Wonder-first rules in code

- Default throttle low.  
- Rest never costs progress or score.  
- Skip pin allowed (no score for that pin).  
- Score is discovery, not time pressure.  
- Spoons empty → rest, never crash.  
