# Progress & pin house — Night Chapters

**Vanilla JS · localStorage only · wonder-first**

## Keys

| Key | Contents |
|-----|----------|
| `night-chapters.personalPins.v1` | House pins (label, view, kind, nightId, …) |
| `night-chapters.bestWonderScore.v1` | Lifetime best wonder score (number) |
| `night-chapters.chapterBest.v1` | `{ [nightId]: bestScore }` |
| `night-chapters.progress.v1` | Completed chapters, flight count, discoveries |
| `night-chapters.reflections.v1` | Last ~20 wonder reflections |

## Progress object (`progress.v1`)

```json
{
  "completed": {
    "soft-rainy-hold": {
      "nightId": "soft-rainy-hold",
      "title": "Soft Rainy Hold",
      "times": 2,
      "bestScore": 120,
      "lastScore": 95,
      "perfect": true,
      "lastAt": "ISO",
      "lastDiscoveries": 6
    }
  },
  "flights": 5,
  "totalDiscoveries": 18,
  "updated_at": "ISO"
}
```

- Written on **closeout** via `recordChapterComplete`.
- MENU chapter cards show **✓** / “flown” when `times > 0`.
- Progress strip: nights completed · flights · lifetime discoveries.

## House pins UI

- Panel **House pins**: count, clear-all, list with **Fly** + **delete**.
- Fly → hard goto Aladin coords.
- Delete / clear only pins — **does not** wipe chapter progress.
- Pins store `chapterTitle` when claimed during a night.

## Wonder reflection (closeout)

After each chapter:

1. Score + perfect bonus applied.  
2. Progress + chapter best + house best saved.  
3. `buildReflection` soft lines → overlay dialog.  
4. **Back to nights** or **Fly again**.  
5. Reflection also appended to `reflections.v1` (last 20).

No failure language. Rest and partial flights still reflect kindly.
