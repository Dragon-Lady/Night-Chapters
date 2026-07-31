# Schema — hooks

| Hook | Trigger | Payload |
|------|---------|---------|
| `on_night_start` | player picks a Night | chapter id, tone, first view |
| `on_glide` | continuous camera motion | heading, fov, throttle |
| `on_pin_arrive` | near story fix | pin, beat |
| `on_pin_create` | P / Pin | pin object → storage + optional thumbnail |
| `on_fly` | pin click / next heading | coords + FOV → glass |
| `on_mystery_near` | approach unlabeled seed | soft cue only |
| `on_mystery_claim` | name + pin | mystery id, player label |
| `on_mystery_revisit` | date window / button | seed + prior snaps |
| `on_rest` | throttle ≈ 0 at pin | refill “fuel of the night” |
| `on_closeout` | end night / goodnight | 3-line left-off (nav log) |
| `on_share` | postcard / X hotkey | image + label (**human approve** on public) |

No combat hooks. No weapons release.
