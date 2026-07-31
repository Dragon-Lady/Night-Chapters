# Soft audio — Night Chapters

**Web Audio API only · no samples · no npm deps · wonder-first**

Module: `public/js/audio.js` · wired from `game-loop.js`.

## Unlock

Browsers require a gesture. AudioContext starts / resumes on **Begin night** (and Mute toggle).

## Chapter ambients

Synthesized loops (drone + filtered noise + slow LFO):

| Mood | Chapter | Character |
|------|---------|-----------|
| `rain` | Soft Rainy Hold | Soft rain-band noise, cool low sine |
| `warm` | Gumdrop Summer | Warmer triangle drone, less noise |
| `cold` | Clear Cold Glass | Thin high noise, sparse low sine |
| `rose` | First Love Sky | Gentle mid drones, blush filter |

Starts on **Begin night**; fades out on closeout / return to MENU.

## Cues

| Event | Sound |
|-------|--------|
| Story pin **ARRIVE** | Soft two-note chime (C5 + E5) |
| Enter **MYSTERY** | Low glow hum (throttled ≥2.5s) |
| **Throttle glide** | High-pass wind whoosh (level ∝ throttle) |
| **REST** / Space | Ambient fades to silence; wind off |
| Leave rest | Ambient returns |
| Chapter card select | Tiny UI tap |

## Mute

- Header **Sound on / off**
- Persisted: `localStorage` key `night-chapters.audioMuted.v1`
- Mute silences master + cues; state still runs silently

## Design rules

- Low gains; long fades; no alarms or stingers  
- Rest is **silence**, not a “penalty” sound  
- Never autoplay before Begin  

## Future (optional)

- Per-pin custom notes  
- Companion whisper SFX  
- Optional user-supplied ambient URLs (still not required)
