/**
 * Night chapter catalog + loader.
 * Wonder-first flight plans — not mission packs.
 */

/** Lightweight MENU cards (full route loads on select / begin) */
export const CHAPTER_INDEX = [
  {
    id: "soft-rainy-hold",
    title: "Soft Rainy Hold",
    tone: "quiet recovery — the sky waited",
    blurb: "Rain on the glass. Start from known light.",
    weather_mood: "rain",
    order: 1,
  },
  {
    id: "gumdrop-summer",
    title: "Gumdrop Summer",
    tone: "playful warmth — sticky-sweet night air",
    blurb: "Milky ribbon, summer triangle, candy wonder.",
    weather_mood: "warm",
    order: 2,
  },
  {
    id: "clear-cold-glass",
    title: "Clear Cold Glass",
    tone: "crisp quiet — frost on the edges",
    blurb: "Winter-clear. Cassiopeia, pole, deep galaxy.",
    weather_mood: "cold",
    order: 3,
  },
  {
    id: "first-love-sky",
    title: "First Love Sky",
    tone: "tender rose — the night that remembered you",
    blurb: "Pleiades, soft clusters, a shy chapter glow.",
    weather_mood: "rose",
    order: 4,
  },
];

/** Fallback if fetch fails (Soft Rainy Hold only, minimal) */
const FALLBACK = {
  id: "soft-rainy-hold",
  title: "Soft Rainy Hold",
  tone: "quiet recovery",
  weather_mood: "rain",
  sky: { mood: "rain", hue: 210, warmth: 0.1, starDensity: 0.9, cloudDensity: 1.6 },
  score: { story: 10, drift: 25, chapter: 40, free: 5, perfect_bonus: 15 },
  whisper_start: "We start from known light.",
  pins: [
    {
      id: "home-glass",
      label: "Home glass",
      note: "Comfort light.",
      emotion: "safe",
      beat: "sit",
      view: { ra: 83.8221, dec: -5.3911, fov: 3.5 },
    },
  ],
  drift_mysteries: [],
  mystery: {
    id: "mystery-rain",
    story_hook: "Name this glow.",
    seed: { ra: 41.9672, dec: 21.3918, fov: 1.2 },
  },
};

export function listNights() {
  return CHAPTER_INDEX.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** @deprecated use listNights */
export function listBuiltinNights() {
  return listNights();
}

/**
 * Load full chapter route by id.
 * @returns {Promise<object>}
 */
export async function loadNight(id = "soft-rainy-hold") {
  const paths = [
    `./data/nights/${id}.json`,
    `/data/nights/${id}.json`,
    `../data/nights/${id}.json`,
  ];
  for (const p of paths) {
    try {
      const res = await fetch(p, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        return normalizeNight(data);
      }
    } catch {
      /* try next */
    }
  }
  console.warn("night load fallback for", id);
  return normalizeNight(structuredClone(FALLBACK));
}

function normalizeNight(n) {
  if (!n.sky) {
    n.sky = {
      mood: n.weather_mood || "rain",
      hue: 220,
      warmth: 0.15,
      starDensity: 1,
      cloudDensity: 1,
    };
  }
  if (!n.score) {
    n.score = { story: 10, drift: 25, chapter: 40, free: 5, perfect_bonus: 15 };
  }
  n.drift_mysteries = n.drift_mysteries || [];
  n.pins = n.pins || [];
  n.house_pins = Array.isArray(n.house_pins) ? n.house_pins : [];
  return n;
}

export function chapterCardMeta(id) {
  return CHAPTER_INDEX.find((c) => c.id === id) || CHAPTER_INDEX[0];
}
