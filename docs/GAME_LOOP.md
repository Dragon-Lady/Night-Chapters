# Game loop sketch — Night Chapters v0

## States

```
BOOT → MENU → FLIGHT → (ARRIVE | MYSTERY | REST)* → CLOSEOUT → MENU
```

| State | Glass | Player |
|-------|--------|--------|
| **BOOT** | Load Aladin windshield | Wait for sky |
| **MENU** | Parked at chapter start | Pick Night / Begin flight |
| **FLIGHT** | Soft glide toward heading bug | Throttle, next, rest |
| **ARRIVE** | FOV settles on pin | Do beat (sit / emotion / skip) |
| **MYSTERY** | Near unlabeled seed | P to claim name |
| **REST** | Throttle ≈ 0 | Spoons refill; no failure |
| **CLOSEOUT** | Optional postcard later | Nav log 3 lines |

## Frame tick (soft flight)

Each animation frame while `state === FLIGHT` and `throttle > 0`:

1. Read current RA/Dec/FOV from windshield.  
2. Interpolate toward **heading bug** (next pin or mystery) with ease — never snap-punish.  
3. Cap step by throttle × base_rate (glide, not afterburner).  
4. If angular distance < arrive_threshold → **ARRIVE** (or mystery prompt).  
5. Update soft instruments: heading, fuel of the night, fixes visited.

No combat tick. No damage model. Leaving mid-night is always allowed.

## Events (schema hooks)

- `on_night_start` · `on_glide` · `on_pin_arrive` · `on_fly`  
- `on_mystery_near` · `on_mystery_claim` · `on_rest` · `on_closeout`  

## Wonder-first rules in code

- Default throttle low.  
- Rest never costs progress.  
- Skip pin allowed.  
- Score is absent — only fixes visited + nav log.  
