/**
 * Night chapter loader — personal flight plans.
 * Wonder-first: data is story, not mission packs.
 */

const BUILTIN = {
  id: "soft-rainy-hold",
  title: "Soft Rainy Hold",
  tone: "quiet recovery — the sky waited",
  status: "ready",
  weather_mood: "soft rainy hold",
  whisper_start:
    "We start from known light. Glide soft. Watch for ✧ drift glows off the ribbon.",
  pins: [
    {
      id: "home-glass",
      label: "Home glass",
      note: "Comfort light. Breathe. The night is not a test.",
      emotion: "safe",
      beat: "sit",
      personal: true,
      view: { ra: 83.8221, dec: -5.3911, fov: 3.5, name: "M42" },
    },
    {
      id: "left-the-day",
      label: "Where I left the day",
      note: "A bright familiar. Name one word for how you arrive.",
      emotion: "release",
      beat: "emotion_word",
      personal: true,
      view: { ra: 279.2347, dec: 38.7837, fov: 2.0, name: "Vega" },
    },
    {
      id: "personal-star",
      label: "Personal star",
      note: "Sit here ~15s if you want. Looking is playing.",
      emotion: "wonder",
      beat: "sit",
      personal: true,
      view: { ra: 210.8023, dec: 54.3489, fov: 1.5, name: "M51" },
    },
  ],
  drift_mysteries: [
    {
      id: "drift-between-1-2",
      story_hook:
        "A pale spark off the path between comfort and the day you left…",
      seed: { ra: 180.0, dec: 20.0, fov: 2.0 },
    },
    {
      id: "drift-between-2-3",
      story_hook:
        "Something quiet near the personal star’s approach — not on the ribbon, not a test.",
      seed: { ra: 245.0, dec: 46.0, fov: 1.8 },
    },
  ],
  mystery: {
    id: "mystery-glow",
    story_hook:
      "Chapter glow unlabeled. Get close. Press P — name it yours.",
    seed: { ra: 41.9672, dec: 21.3918, fov: 1.2 },
    claimed_label: null,
  },
};

/**
 * @returns {Promise<object>}
 */
export async function loadNight(id = "soft-rainy-hold") {
  try {
    const base = import.meta?.url
      ? new URL("../../data/nights/", import.meta.url)
      : null;
    // Prefer fetch from /data when served with monorepo root; fall back to public copy path
    const paths = [
      `../data/nights/${id}.json`,
      `/data/nights/${id}.json`,
      `./data/nights/${id}.json`,
    ];
    for (const p of paths) {
      try {
        const res = await fetch(p, { cache: "no-store" });
        if (res.ok) return await res.json();
      } catch {
        /* try next */
      }
    }
  } catch {
    /* builtin */
  }
  return structuredClone(BUILTIN);
}

export function listBuiltinNights() {
  return [{ id: BUILTIN.id, title: BUILTIN.title, tone: BUILTIN.tone }];
}
