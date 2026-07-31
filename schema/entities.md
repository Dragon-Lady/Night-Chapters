# Schema — core entities

Lightweight v0 from cottage Weekend Build Schemas (Observatory sequel) + Night Chapters flight layer.

## Chapter (Night)

| Field | Notes |
|-------|--------|
| `id` | stable slug |
| `title` | e.g. Soft Rainy Hold |
| `tone` | quiet / wonder / recovery / play |
| `status` | draft · ready · archived |
| `pins[]` | ordered story fixes (3–5 typical) |
| `mystery` | one unlabeled discovery seed |
| `weather_mood?` | rain hold, clear cold, soft haze (cosmetic + pace) |

A **Night** is a Chapter you can *fly*.

## SkyView

| Field | Notes |
|-------|--------|
| `ra`, `dec` | coordinates |
| `fov` | field of view (“altitude of attention”) |
| `survey?` | sky survey / layer |
| `epoch?` | when relevant |

Camera / glass state — Aladin spine when wired.

## Pin (story fix)

| Field | Notes |
|-------|--------|
| `id` | |
| `label` | human name |
| `note?` | whisper / card text |
| `view` | SkyView |
| `emotion?` | personal label |
| `starred` | bool |
| `beat?` | tiny arrive action (name, sit, answer soft prompt) |
| `created_at` | |
| `personal` | true → house mythology; easy delete |

## Mystery

| Field | Notes |
|-------|--------|
| `id` | |
| `seed_coords` | RA/Dec or reticle seed |
| `story_hook` | soft prompt, no spoiler dump |
| `revisits[]` | prior visits / names claimed |

Victory condition: **player names it** (pin), not wiki-first.

## Flight (session)

| Field | Notes |
|-------|--------|
| `night_id` | Chapter being flown |
| `heading_bug?` | next pin advisory |
| `throttle` | sky drift speed (rest ≈ park) |
| `fixes_visited[]` | progress without score |
| `nav_log` | 3-line closeout crumb |
| `ended_at?` | |

## Lane (mythology)

| Field | Notes |
|-------|--------|
| public vs private | public name stays soft; intimate layers stay private |
