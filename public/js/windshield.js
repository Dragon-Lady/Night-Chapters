/**
 * Windshield — custom canvas night sky (no Aladin).
 * NC_BUILD 1.7.64 — wider Gumdrop FoV; hard chapter isolation
 *
 * Camera: RA / Dec / FoV + heading. Projection is heading-aligned:
 *   forward (heading) = up on glass, so A/D yaws the whole sky.
 * Heading is STANDARD COMPASS: 0° north, 90° east, 180° south, 270° west.
 * World canvas rotate is −heading (canvas Y-down).
 * Motion: player A/D yaws; W flies along CURRENT heading only.
 * FoV is chapter-aware: Gumdrop uses a wider cruise window so spread
 * markers sit in peripheral vision (nav ring stays screen-space).
 * Radar/sensor never turns the ship or pulls RA/Dec toward a pin.
 */

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  /**
   * Default cruise FoV (Soft Rainy intimate glass).
   * Gumdrop overrides via cruiseFovForChapter() → ~34°.
   */
  fov: 22,
  /**
   * Compass heading degrees (navigation convention):
   *   0° = north (+Dec), 90° = east (+RA), 180° = south, 270° = west.
   * Matches N/E/S/W pills and “hdg” readout.
   */
  heading: 0,
};

/**
 * Cruise FoV band — pin approach may tighten slightly; free flight holds
 * the chapter cruise. Max raised so Gumdrop can zoom out for peripheral hunt.
 */
const CRUISE_FOV_MIN = 20;
const CRUISE_FOV_MAX = 38;
/**
 * Gentle “look up” bias (degrees of sky). Nose sits slightly low on glass
 * so more upper field / side markers stay in frame while traveling.
 * A touch higher helps wide-FoV chapters see high Dec candy.
 */
const VIEW_PITCH_DEG = 4.5;

/** Chapter cruise FoV — wider for full-sky candy hunts. */
function cruiseFovForChapter(chapterId) {
  if (chapterId === "gumdrop-summer") return 34;
  if (chapterId === "clear-cold-glass") return 28;
  return BOOT.fov; // 22 Soft Rainy intimate
}

/**
 * Throttle → sky speed. No minimum crawl floor (that felt like random drift
 * when thr was slightly >0 from Begin/slider residual or steer thr-floor).
 * Pure curve: intentional W only.
 */
const MAX_DEG_PER_SEC = 12;
/** Curve exponent: low thr stays soft; full thr still cruise-readable */
const THROTTLE_CURVE = 1.55;
/** Below this thr: zero translation (yaw still works) */
const THR_MOVE_DEADZONE = 0.045;
/** Max yaw rate while holding A/D (°/s) — responsive, not sluggish */
const MAX_YAW_DEG_PER_SEC = 58;
/** Hard cap per frame so bad dt / double-ticks never runaway */
const MAX_YAW_DEG_PER_FRAME = 2.6;
/**
 * Celestial pole flight limits (Pole hold / high Dec).
 * Soft: damp northward. Hard: clamp Dec.
 * v1.7.45: no north→east orbit conversion (that slingshot on exit).
 * True-sky °/frame is hard-capped so RA never flings the glass.
 */
const DEC_SOFT_LIMIT = 80.0;
const DEC_HARD_LIMIT = 84.0;
/**
 * Floor |cos(dec)| for RA conversion. cos(72°)≈0.31 → max ~3.2× RA amp
 * (was cos(82°)≈0.14 → ~7× amp = slingshot when leaving east).
 */
const POLE_COS_FLOOR = Math.cos((72 * Math.PI) / 180);
const FIELD_STAR_N = 720;
const NEAR_STAR_N = 140;
const NEBULA_N = 12;
const CLOUD_N = 14;

export function createWindshield(
  containerSelector = "#sky-canvas",
  { fxCanvasId = "fx-canvas" } = {}
) {
  let canvas = null;
  let ctx = null;
  let ready = false;
  const waiters = [];

  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
  /** Flight bearing degrees: 0 = +RA, 90 = +Dec */
  let heading = BOOT.heading;
  /** Continuous steer input −1..+1 (merged from game-loop + local keys) */
  let steerInput = 0;
  /** Game-loop steer (optional); local keys always tracked here too */
  let gameSteer = 0;
  const keySteer = { left: false, right: false };
  let flightKeysBound = false;
  let lastGlideSpeed = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;

  let phase = "MENU";
  let throttle = 0;
  let weatherMood = "rain";
  let skyHue = 220;
  let skyWarmth = 0.12;
  let starDensity = 1;
  let cloudDensity = 1;

  /** Stable field stars in RA/Dec (degrees) */
  let fieldStars = [];
  /** Screen-space near dust for depth streaks */
  let nearStars = [];
  let nebulae = [];
  let clouds = [];
  /** World-fixed anchors (RA/Dec) — slide across glass as you fly */
  let landmarks = [];
  let overlays = []; // { ra, dec, name, kind, done }
  /**
   * Proximity hot target from game-loop (chapter / drift glow).
   * { ra, dec, level: 'notice'|'near', kind, hint }
   */
  let hotTarget = null;
  /** 0–1 ribbon brighten when approaching any pin / glow (set by game-loop) */
  let ribbonApproach = 0;
  /**
   * Forward nav sensor target (next pin / glow).
   * { ra, dec, label, kind, distDeg } | null — set by game-loop
   */
  let sensorTarget = null;
  let sensorPingFlash = 0; // 0–1 visual pulse after a ping
  /** Smoothed blip angle (rad) so pointer moves fluidly on small heading errors */
  let sensorBlipAngSm = 0;
  /**
   * Craft bank from player steer only (never toward sensor lock).
   * Sensor lean was read as "suction" even after soft-face removal.
   */
  let craftBankSm = 0;
  /**
   * On-glass whisper (screen-space fade). Panel whisper is separate DOM.
   * { text, born, holdMs, fadeInSec, fadeOutSec, kind }
   */
  let glassWhisper = null;
  /** Active chapter id — drives landmark pack (soft-rainy-hold / gumdrop-summer / …) */
  let chapterId = "soft-rainy-hold";
  /** Last night object for re-seed after weather */
  let chapterNight = null;

  let running = false;
  let rafId = 0;
  let lastPaint = 0;
  let panVelX = 0;
  let panVelY = 0;
  /** Last time glideStep advanced cam (paintLoop catch-up if game rAF stalls) */
  let lastAdvanceAt = 0;
  /** Cumulative screen scroll for fixed-pattern dust (extra visible pan) */
  let dustOx = 0;
  let dustOy = 0;

  function whenReady(fn) {
    if (ready) fn(null);
    else waiters.push(fn);
  }

  function boot() {
    if (ready && canvas) return canvas;

    // Accept canvas selector or a div we fill with a canvas
    let el = document.querySelector(containerSelector);
    if (!el) {
      console.warn("windshield: missing", containerSelector);
      return null;
    }
    if (el.tagName === "CANVAS") {
      canvas = el;
    } else {
      canvas = document.createElement("canvas");
      canvas.id = "sky-canvas";
      canvas.className = "sky-canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Night sky windshield");
      el.innerHTML = "";
      el.appendChild(canvas);
    }

    ctx = canvas.getContext("2d", { alpha: false });
    // Hide legacy FX canvas — sky owns the paint now
    const fxEl = document.getElementById(fxCanvasId);
    if (fxEl) {
      fxEl.style.display = "none";
      fxEl.setAttribute("aria-hidden", "true");
    }

    seedUniverse();
    resize();
    window.addEventListener("resize", resize);
    bindFlightKeys();

    running = true;
    lastPaint = 0;
    rafId = requestAnimationFrame(paintLoop);

    try {
      window.__ncCam = () => ({ ...cam });
      window.__aladin = null;
      window.__ncSky = { get cam() { return { ...cam }; } };
    } catch {
      /* ignore */
    }

    const stage = document.getElementById("sky-stage");
    if (stage) {
      stage.classList.remove("glass-boot");
      stage.classList.add("glass-live");
    }

    ready = true;
    while (waiters.length) waiters.shift()(null);
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement || canvas;
    const r = parent.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(r.width));
    h = Math.max(1, Math.floor(r.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!nearStars.length) seedNearStars();
  }

  /** Deterministic 0–1 from numbers */
  function hash01(a, b = 0) {
    let x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function seedUniverse() {
    fieldStars = [];
    const n = Math.round(FIELD_STAR_N * starDensity);
    for (let i = 0; i < n; i++) {
      const ra = hash01(i, 1) * 360;
      const dec = (hash01(i, 2) - 0.5) * 170; // −85..85
      const bright = 0.25 + hash01(i, 3) * 0.75;
      fieldStars.push({
        ra,
        dec,
        r: 0.4 + hash01(i, 4) * 1.8 * bright,
        a: 0.35 + bright * 0.65,
        warm: hash01(i, 5) > 0.82,
        tw: hash01(i, 6) * Math.PI * 2,
        z: 0.35 + hash01(i, 7) * 1.2,
      });
    }

    nebulae = [];
    for (let i = 0; i < NEBULA_N; i++) {
      nebulae.push({
        ra: hash01(i, 20) * 360,
        dec: (hash01(i, 21) - 0.5) * 120,
        rx: 18 + hash01(i, 22) * 55,
        ry: 10 + hash01(i, 23) * 35,
        hue: 200 + hash01(i, 24) * 80,
        a: 0.04 + hash01(i, 25) * 0.08,
      });
    }

    clouds = [];
    const cn = Math.max(2, Math.round(CLOUD_N * cloudDensity));
    for (let i = 0; i < cn; i++) {
      clouds.push({
        ra: hash01(i, 30) * 360,
        dec: (hash01(i, 31) - 0.5) * 100,
        s: 40 + hash01(i, 32) * 100,
        a: 0.03 + hash01(i, 33) * 0.07,
        drift: (hash01(i, 34) - 0.5) * 0.02,
      });
    }

    seedLandmarks(chapterNight);
    seedNearStars();
  }

  /**
   * Shared scenery — filtered by chapter so ch2 isn't pulled to ch1/pole noise.
   */
  function sharedSceneryLandmarks(forChapter = "soft-rainy-hold") {
    const pole = {
      ra: 37.95,
      dec: 80.5,
      kind: "beacon",
      label: "Pole hold",
      catalog: "Polaris neighborhood",
      hue: 200,
      size: 0.9,
      role: "beacon",
    };
    const mid = [
      { ra: 120.0, dec: -15.0, kind: "cloud", label: "Soft bank", hue: 215, size: 1.4, role: "beacon" },
      { ra: 330.0, dec: 10.0, kind: "cloud", label: "Night Vale", hue: 250, size: 1.3, role: "beacon" },
      { ra: 90.0, dec: 40.0, kind: "spiral", label: "Far wheel", hue: 270, size: 1.0, role: "beacon" },
      { ra: 200.0, dec: -30.0, kind: "nebula", label: "South bloom", hue: 15, size: 1.25, role: "beacon" },
      { ra: 0.0, dec: 0.0, kind: "beacon", label: "Zero meridian", hue: 180, size: 0.8, role: "beacon" },
    ];
    // Gumdrop Summer: summer-sky only — no pole, no Cass (ch1/ch3 territory)
    if (forChapter === "gumdrop-summer") {
      return [
        { ra: 330.0, dec: 10.0, kind: "cloud", label: "Night Vale", hue: 250, size: 1.3, role: "beacon" },
        { ra: 0.0, dec: 0.0, kind: "beacon", label: "Zero meridian", hue: 180, size: 0.8, role: "beacon" },
      ];
    }
    // Clear cold: include pole + cass in pack itself; shared mid only
    if (forChapter === "clear-cold-glass") {
      return mid;
    }
    // Soft Rainy + default: pole + cass + mid
    return [
      { ra: 14.18, dec: 60.72, kind: "cluster", label: "Cass W", hue: 190, size: 1.05, role: "beacon" },
      pole,
      ...mid,
    ];
  }

  /** Chapter 1 — Soft Rainy Hold */
  function packSoftRainyLandmarks() {
    return [
      {
        ra: 83.82,
        dec: -5.39,
        kind: "nebula",
        label: "Home glass",
        catalog: "Orion · M42",
        hue: 28,
        size: 1.35,
        role: "story",
      },
      {
        ra: 279.23,
        dec: 38.78,
        kind: "beacon",
        label: "Where I left the day",
        catalog: "Vega",
        hue: 200,
        size: 1.0,
        role: "story",
      },
      {
        ra: 210.8,
        dec: 54.35,
        kind: "spiral",
        label: "Personal star",
        catalog: "Whirlpool · M51",
        hue: 260,
        size: 1.15,
        role: "story",
      },
      { ra: 41.97, dec: 21.39, kind: "glow", label: "Porch light", hue: 210, size: 0.95, role: "chapter" },
      { ra: 180.0, dec: 20.0, kind: "beacon", label: "James's heart", hue: 50, size: 0.85, role: "drift" },
      { ra: 245.0, dec: 46.0, kind: "glow", label: "Quiet spark", hue: 320, size: 0.85, role: "drift" },
      { ra: 56.75, dec: 24.12, kind: "cluster", label: "seven sisters", hue: 45, size: 1.1, role: "house" },
      { ra: 95.5, dec: -22.0, kind: "mars", label: "Mars data center", hue: 12, size: 1.45, role: "house" },
      // Scenery also useful from rainy sky
      { ra: 297.7, dec: 8.87, kind: "beacon", label: "Altair porch", hue: 35, size: 0.95, role: "beacon" },
      { ra: 310.36, dec: 45.28, kind: "nebula", label: "Deneb tail", hue: 300, size: 1.2, role: "beacon" },
    ];
  }

  /**
   * Chapter 2 — Gumdrop Summer (summer triangle + candy drifts).
   * Story pins stay true Altair / Vega / Deneb (~35° legs).
   * Drifts / house / scenery are spread across the full sky so spawn
   * is not a 5-marker pancake and free-cruise stays exploratory.
   */
  function packGumdropLandmarks() {
    return [
      // —— Story ribbon (catalog summer triangle) ——
      {
        ra: 297.7,
        dec: 8.87,
        kind: "beacon",
        label: "Porch star",
        catalog: "Altair",
        hue: 35,
        size: 1.2,
        role: "story",
      },
      {
        ra: 279.23,
        dec: 38.78,
        kind: "beacon",
        label: "Lantern",
        catalog: "Vega",
        hue: 48,
        size: 1.15,
        role: "story",
      },
      {
        ra: 310.36,
        dec: 45.28,
        kind: "nebula",
        label: "Dragon tail",
        catalog: "Deneb",
        hue: 300,
        size: 1.25,
        role: "story",
      },
      // —— Candy drifts (long detours, not mid-triangle pile) ——
      {
        ra: 228.0,
        dec: 10.0,
        kind: "glow",
        label: "gumdrop spark",
        hue: 25,
        size: 0.95,
        role: "drift",
      },
      {
        ra: 42.0,
        dec: 48.0,
        kind: "glow",
        label: "candy dust",
        hue: 330,
        size: 0.9,
        role: "drift",
      },
      // Chapter mystery — open south-central sky
      {
        ra: 155.0,
        dec: 22.0,
        kind: "glow",
        label: "the gumdrop",
        hue: 18,
        size: 1.05,
        role: "chapter",
      },
      // House rail: walk down the yard (not on Altair)
      {
        ra: 318.5,
        dec: -11.0,
        kind: "beacon",
        label: "summer porch rail",
        hue: 30,
        size: 0.9,
        role: "house",
      },
      // Scenery — far corners of the glass
      {
        ra: 200.0,
        dec: 55.0,
        kind: "cloud",
        label: "sticky ribbon",
        hue: 40,
        size: 1.3,
        role: "beacon",
      },
      {
        ra: 100.0,
        dec: -18.0,
        kind: "cloud",
        label: "warm bank",
        hue: 22,
        size: 1.2,
        role: "beacon",
      },
    ];
  }

  /** Chapter 3 pack (landmarks only — full polish later) */
  function packClearColdLandmarks() {
    return [
      {
        ra: 14.18,
        dec: 60.72,
        kind: "cluster",
        label: "W of the queen",
        catalog: "Cassiopeia",
        hue: 190,
        size: 1.2,
        role: "story",
      },
      {
        ra: 37.95,
        dec: 80.5,
        kind: "beacon",
        label: "Still point",
        catalog: "Polaris neighborhood",
        hue: 200,
        size: 1.0,
        role: "story",
      },
      {
        ra: 10.68,
        dec: 41.27,
        kind: "spiral",
        label: "Neighbor island",
        catalog: "M31",
        hue: 260,
        size: 1.2,
        role: "story",
      },
      { ra: 25.0, dec: 75.0, kind: "glow", label: "frost spark", hue: 200, size: 0.9, role: "drift" },
      { ra: 20.0, dec: 50.0, kind: "glow", label: "ice dust", hue: 210, size: 0.85, role: "drift" },
      { ra: 30.0, dec: 55.0, kind: "glow", label: "cold glow", hue: 195, size: 1.0, role: "chapter" },
    ];
  }

  /**
   * Pre-spread Gumdrop cluster — never bold, never drawn as active.
   * (Matches pins.js GUMDROP_STALE_COORDS.)
   */
  const GUMDROP_STALE_SKY = [
    { ra: 298.2, dec: 7.5 },
    { ra: 288.0, dec: 24.0 },
    { ra: 305.0, dec: 40.0 },
    { ra: 290.5, dec: 28.5 },
    { ra: 300.0, dec: 20.0 },
    { ra: 285.0, dec: 15.0 },
  ];

  function nearStaleGumdrop(ra, dec, tol = 1.25) {
    const cos = Math.cos((Number(dec) * Math.PI) / 180) || 1;
    for (const s of GUMDROP_STALE_SKY) {
      let dRa = Number(ra) - s.ra;
      while (dRa > 180) dRa -= 360;
      while (dRa < -180) dRa += 360;
      if (Math.hypot(dRa * cos, Number(dec) - s.dec) <= tol) return true;
    }
    return false;
  }

  /**
   * Build landmarks for the active chapter (bold only).
   * Prior chapters: ultra-faint ghosts on Soft Rainy; on Gumdrop they are
   * HIDDEN (user reported ch1 still bold / cluttering the spread map).
   * Ghosts never enter the sensor pool.
   */
  function seedLandmarks(night = null) {
    const id = night?.id || chapterId || "soft-rainy-hold";
    chapterId = id;
    if (night) chapterNight = night;

    /** On Gumdrop / Clear Cold: do not paint Soft Rainy markers at all */
    const hidePriorChapters =
      id === "gumdrop-summer" || id === "clear-cold-glass";

    const packFor = (cid) => {
      if (cid === "gumdrop-summer") return packGumdropLandmarks();
      if (cid === "clear-cold-glass") return packClearColdLandmarks();
      return packSoftRainyLandmarks();
    };

    const CHAPTER_ORDER = [
      "soft-rainy-hold",
      "gumdrop-summer",
      "clear-cold-glass",
      "first-love-sky",
    ];
    const orderIdx = Math.max(0, CHAPTER_ORDER.indexOf(id));

    const pack = packFor(id);
    const shared = sharedSceneryLandmarks(id);
    const fromJson = landmarksFromNightJson(night);
    const merged = [];
    const activeKeys = new Set(); // sky keys that belong to THIS chapter only
    const keyOf = (L) =>
      `${(Math.round(Number(L.ra) * 2) / 2).toFixed(1)}_${(
        Math.round(Number(L.dec) * 2) / 2
      ).toFixed(1)}`;

    /**
     * @param {object} L
     * @param {{ ghost?: boolean, chapter?: string, preferLabel?: boolean }} opts
     * Active (non-ghost) always wins over ghost at the same sky slot.
     */
    const put = (L, opts = {}) => {
      if (!L || L.ra == null || L.dec == null) return;
      // Never promote pre-spread pancake coords to active on Gumdrop
      if (
        id === "gumdrop-summer" &&
        !opts.ghost &&
        nearStaleGumdrop(L.ra, L.dec, 1.15)
      ) {
        // Only allow if this exact point is in the live pack/json (shouldn't be)
        const kTry = keyOf(L);
        const inLive = [...fromJson, ...pack].some((x) => keyOf(x) === kTry);
        if (!inLive) return;
      }
      const ghost = !!opts.ghost;
      const ch = opts.chapter || id;
      const preferLabel = !!opts.preferLabel;
      const k = keyOf(L);
      const i = merged.findIndex((m) => keyOf(m) === k);
      if (i >= 0) {
        const prev = merged[i];
        // Never let a ghost overwrite an active marker
        if (ghost && !prev.ghost) return;
        // Active replaces ghost entirely
        if (!ghost && prev.ghost) {
          merged[i] = {
            ...L,
            chapter: ch,
            ghost: false,
            label: L.label || prev.label,
          };
          if (!ghost) activeKeys.add(k);
          return;
        }
        merged[i] = {
          ...prev,
          ...L,
          label: preferLabel && L.label ? L.label : L.label || prev.label,
          catalog: L.catalog != null ? L.catalog : prev.catalog,
          role: L.role || prev.role,
          chapter: ch,
          // Active put always clears ghost; ghost put only lands if prev was ghost
          ghost: !!ghost,
        };
        if (!ghost && ch === id) activeKeys.add(k);
      } else {
        merged.push({
          ...L,
          chapter: ch,
          ghost,
        });
        if (!ghost && ch === id) activeKeys.add(k);
      }
    };

    landmarks = [];

    // 1) Active chapter only — bold
    for (const L of fromJson) put(L, { ghost: false, chapter: id, preferLabel: true });
    for (const L of pack) put(L, { ghost: false, chapter: id, preferLabel: true });
    // Shared scenery: full on Soft Rainy; ghost/hide on later chapters
    for (const L of shared) {
      if (hidePriorChapters) {
        // Gumdrop uses its own pack scenery — skip generic shared pole clutter
        continue;
      }
      put(L, { ghost: false, chapter: id, preferLabel: false });
    }

    // 2) Prior chapters — only when not hidden (Soft Rainy reference on later maps)
    if (!hidePriorChapters) {
      for (let oi = 0; oi < orderIdx; oi++) {
        const priorId = CHAPTER_ORDER[oi];
        for (const L of packFor(priorId)) {
          put(L, { ghost: true, chapter: priorId, preferLabel: false });
        }
        for (const L of sharedSceneryLandmarks(priorId)) {
          put(L, { ghost: true, chapter: priorId, preferLabel: false });
        }
      }
    }

    landmarks = merged
      .map((f, i) => {
        const ch = f.chapter || id;
        const k = keyOf(f);
        // Hard rules: not this chapter → ghost; not in active key set → ghost
        let forceGhost =
          !!f.ghost || ch !== id || (activeKeys.size > 0 && !activeKeys.has(k));
        // Stale pancake coords never bold on Gumdrop
        if (id === "gumdrop-summer" && nearStaleGumdrop(f.ra, f.dec, 1.15)) {
          if (!activeKeys.has(k)) forceGhost = true;
        }
        return {
          ...f,
          tw: hash01(i + id.length, 90) * Math.PI * 2,
          pulse: 0.85 + hash01(i, 91) * 0.3,
          ghost: forceGhost,
          chapter: ch,
        };
      })
      // Gumdrop: drop ghosts entirely so only spread layout remains
      .filter((L) => !(hidePriorChapters && L.ghost));

    try {
      const ghosts = landmarks.filter((L) => L.ghost);
      const live = landmarks.filter((L) => !L.ghost);
      window.__ncLandmarks = {
        chapter: id,
        total: landmarks.length,
        live: live.length,
        ghost: ghosts.length,
        liveLabels: live.map((L) => L.label).filter(Boolean),
        ghostLabels: ghosts.map((L) => L.label).filter(Boolean),
        hidePrior: hidePriorChapters,
        build: "1.7.64",
        ch1Ghosting: hidePriorChapters || id !== "soft-rainy-hold",
        ghostAlpha: hidePriorChapters ? 0 : 0.04,
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
  }

  /**
   * Sky allowlist for the active chapter (sensor may only lock these).
   * Built from night JSON + current landmark pack.
   */
  function getChapterSensorAllowlist(night = chapterNight) {
    const pts = [];
    const add = (ra, dec, label, role) => {
      const r = Number(ra);
      const d = Number(dec);
      if (!Number.isFinite(r) || !Number.isFinite(d)) return;
      pts.push({
        ra: r,
        dec: d,
        label: label || "",
        role: role || "beacon",
      });
    };
    if (night) {
      for (const p of night.pins || []) {
        if (p?.view) add(p.view.ra, p.view.dec, p.label, "story");
      }
      for (const m of night.drift_mysteries || night.mysteries || []) {
        if (m?.seed)
          add(m.seed.ra, m.seed.dec, m.claimed_label || m.label, "drift");
      }
      if (night.mystery?.seed) {
        const m = night.mystery;
        add(
          m.seed.ra,
          m.seed.dec,
          m.claimed_label || m.label,
          "chapter"
        );
      }
      for (const hp of night.house_pins || []) {
        if (hp?.view) add(hp.view.ra, hp.view.dec, hp.label, "house");
      }
    }
    for (const L of landmarks) {
      if (L.ghost) continue; // never sensor-lock ghosts
      if (L.chapter && L.chapter !== chapterId) continue;
      // On gumdrop, skip pure far scenery for sensor lock (still drawn ghosted)
      if (
        chapterId === "gumdrop-summer" &&
        (L.role === "beacon" || !L.role) &&
        !/porch|lantern|dragon|gumdrop|candy|sticky|warm|rail/i.test(
          String(L.label || "")
        )
      ) {
        continue;
      }
      add(L.ra, L.dec, L.label, L.role || "beacon");
    }
    return pts;
  }

  /** True if a sky point is on the active chapter allowlist (~2.5°). */
  function isChapterSensorAllowed(ra, dec, night = chapterNight) {
    const allow = getChapterSensorAllowlist(night);
    if (!allow.length) return true; // boot / no night yet
    const cos = Math.cos((Number(dec) * Math.PI) / 180) || 1;
    for (const p of allow) {
      const d = Math.hypot(
        wrapDeltaRa(p.ra - Number(ra)) * cos,
        p.dec - Number(dec)
      );
      if (d <= 2.5) return true;
    }
    return false;
  }

  /** Ensure night JSON markers always hit the sensor pool even if pack is stale */
  function landmarksFromNightJson(night) {
    if (!night) return [];
    const out = [];
    const hues = { story: 35, drift: 25, chapter: 18, house: 40, beacon: 200 };
    for (const p of night.pins || []) {
      if (!p?.view) continue;
      out.push({
        ra: Number(p.view.ra),
        dec: Number(p.view.dec),
        kind: "beacon",
        label: p.label || "story light",
        catalog: p.view.name || null,
        hue: hues.story,
        size: 1.1,
        role: "story",
      });
    }
    for (const m of night.drift_mysteries || night.mysteries || []) {
      if (!m?.seed) continue;
      out.push({
        ra: Number(m.seed.ra),
        dec: Number(m.seed.dec),
        kind: "glow",
        label: m.claimed_label || m.label || "drift glow",
        hue: hues.drift,
        size: 0.9,
        role: "drift",
      });
    }
    if (night.mystery?.seed) {
      const m = night.mystery;
      out.push({
        ra: Number(m.seed.ra),
        dec: Number(m.seed.dec),
        kind: "glow",
        label: m.claimed_label || m.label || "chapter glow",
        hue: hues.chapter,
        size: 1.0,
        role: "chapter",
      });
    }
    for (const hp of night.house_pins || []) {
      if (!hp?.view) continue;
      out.push({
        ra: Number(hp.view.ra),
        dec: Number(hp.view.dec),
        kind: "beacon",
        label: hp.label || hp.short_label || "house light",
        hue: hues.house,
        size: 0.95,
        role: "house",
      });
    }
    return out;
  }

  function seedNearStars() {
    nearStars = [];
    const n = Math.round(NEAR_STAR_N * starDensity);
    for (let i = 0; i < n; i++) {
      nearStars.push({
        x: Math.random() * Math.max(1, w),
        y: Math.random() * Math.max(1, h),
        z: 0.5 + Math.random() * 1.5,
        r: 0.6 + Math.random() * 1.6,
        a: 0.4 + Math.random() * 0.6,
        tw: Math.random() * Math.PI * 2,
        warm: Math.random() > 0.85,
      });
    }
  }

  function wrapDeltaRa(d) {
    let x = d;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return x;
  }

  /**
   * North-up projection into pre-rotation canvas space.
   * World layer is then rotated so flight heading points UP on the glass.
   * east → +x, north → −y (before heading rotate).
   */
  function project(ra, dec) {
    const fov = Math.max(2, cam.fov);
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const east = wrapDeltaRa(ra - cam.ra) * cos;
    const north = dec - cam.dec;
    const scale = w / fov;
    const x = w * 0.5 + east * scale;
    // Pitch up: shift world down on glass so more sky sits above the nose
    const pitchPx = (VIEW_PITCH_DEG / fov) * h * 0.55;
    const y = h * 0.5 - north * scale + pitchPx;
    // Large margin — after canvas rotate, corners still need coverage
    const margin = Math.max(w, h) * 1.2;
    if (x < -margin || x > w + margin || y < -margin || y > h + margin) {
      return null;
    }
    return { x, y, scale, east, north };
  }

  /**
   * Screen velocity of world features (after heading rotation).
   * Translation opposite cam motion, plus spin from yaw.
   */
  function skyDeltaToScreen(eastDeg, northDeg, yawDeg = 0) {
    const fov = Math.max(2, cam.fov);
    const scale = Math.max(1, w) / fov;
    // North-up delta first
    let dx = eastDeg * scale;
    let dy = -northDeg * scale;
    // Same rotation as world layer (nav heading: 0° = north up)
    const rot = worldRotationRad();
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const rdx = dx * c - dy * s;
    const rdy = dx * s + dy * c;
    // Yaw spin: features orbit opposite to nose turn
    const yawRad = (yawDeg * Math.PI) / 180;
    const spin = Math.min(w, h) * 0.4 * yawRad;
    return { dx: rdx + spin, dy: rdy };
  }

  /**
   * Rotate world so flight heading points UP on glass.
   * Canvas 2d: +angle is clockwise (Y grows downward).
   * Use −heading so 90° (east) brings +east to the top of the glass.
   * (+heading inverted the star stream → W felt like reverse flight.)
   *
   * Nav heading 0° = north → no rotation (north stays up).
   * Nav heading 90° = east → rotate so east is up.
   */
  function worldRotationRad() {
    return (-heading * Math.PI) / 180;
  }

  /**
   * True compass bearing from camera to a sky point (0°=N, 90°=E, 270°=W).
   * Same convention as heading / HDG readout.
   */
  function bearingNavTo(ra, dec) {
    const cosRaw = Math.cos((cam.dec * Math.PI) / 180);
    const cos =
      Math.sign(cosRaw || 1) *
      Math.max(Math.abs(cosRaw) || POLE_COS_FLOOR, POLE_COS_FLOOR);
    const dRa = wrapDeltaRa(Number(ra) - cam.ra) * cos; // east
    const dDec = Number(dec) - cam.dec; // north
    if (Math.hypot(dRa, dDec) < 1e-8) return null;
    // atan2(east, north): 0 = north, 90 = east
    return ((Math.atan2(dRa, dDec) * 180) / Math.PI + 360) % 360;
  }

  /** Cardinal name for a nav bearing. */
  function bearingCardinal(deg) {
    if (!Number.isFinite(deg)) return "—";
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
    return names[i];
  }

  function isFlightPhase() {
    return (
      phase === "FLIGHT" ||
      phase === "MYSTERY" ||
      phase === "ARRIVE" ||
      phase === "REST"
    );
  }

  function isTextTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    const type = el.type || "";
    return (
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (tag === "INPUT" &&
        type !== "range" &&
        type !== "button" &&
        type !== "checkbox" &&
        type !== "radio" &&
        type !== "submit")
    );
  }

  function isInInstrumentsEl(el) {
    return !!(el && el.closest && el.closest("#instruments, .instruments, #instruments-body"));
  }

  function codeIsSteerLeft(e) {
    const c = e.code || "";
    const k = e.key || "";
    return (
      c === "KeyA" ||
      k === "a" ||
      k === "A" ||
      c === "ArrowLeft" ||
      k === "ArrowLeft"
    );
  }

  function codeIsSteerRight(e) {
    const c = e.code || "";
    const k = e.key || "";
    return (
      c === "KeyD" ||
      k === "d" ||
      k === "D" ||
      c === "ArrowRight" ||
      k === "ArrowRight"
    );
  }

  /**
   * Merge game-loop + local key state → steerInput −1..1.
   * Union of both holds so neither path can “lose” a key and cause stuck/random yaw.
   * Digital only (−1 / 0 / +1) — no partial residual from soft guidance.
   */
  function recomputeSteer() {
    const left = !!(keySteer.left || gameSteer < -0.02);
    const right = !!(keySteer.right || gameSteer > 0.02);
    const fromUnion = (right ? 1 : 0) - (left ? 1 : 0);
    steerInput = fromUnion;
    try {
      window.__ncSteer = {
        steerInput,
        keySteer: { ...keySteer },
        gameSteer,
        left,
        right,
        heading: Math.round(((heading % 360) + 360) % 360),
        phase,
        build: "1.7.64",
      };
    } catch {
      /* ignore */
    }
  }

  /**
   * Own capture listeners so A/D · ←/→ reach the glass.
   * Bind once on window only (not window+document — that double-fired).
   * Always track holds (even if phase briefly lags) so keys never “drop.”
   */
  function bindFlightKeys() {
    if (flightKeysBound || typeof window === "undefined") return;
    flightKeysBound = true;

    const onDown = (e) => {
      if (isTextTarget(e.target)) return;
      // Arrows while focus in instruments → let panel scroll (don't steer)
      // But A/D always yaw — panel should never lock free flight
      if (
        isInInstrumentsEl(e.target) &&
        (e.code === "ArrowLeft" ||
          e.code === "ArrowRight" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        return;
      }
      let hit = false;
      if (codeIsSteerLeft(e)) {
        keySteer.left = true;
        hit = true;
      }
      if (codeIsSteerRight(e)) {
        keySteer.right = true;
        hit = true;
      }
      if (hit) {
        recomputeSteer();
        // PreventDefault only in flight so menu typing is unaffected
        if (isFlightPhase()) e.preventDefault();
      }
    };

    const onUp = (e) => {
      let hit = false;
      if (codeIsSteerLeft(e)) {
        keySteer.left = false;
        hit = true;
      }
      if (codeIsSteerRight(e)) {
        keySteer.right = false;
        hit = true;
      }
      if (hit) recomputeSteer();
    };

    // Clear stuck holds when tab loses focus (prompt, DevTools, panel blur)
    const onWinBlur = () => {
      keySteer.left = false;
      keySteer.right = false;
      recomputeSteer();
    };

    // Single target only — document+window both capture = 2× events
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onWinBlur);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) onWinBlur();
    });
  }

  /**
   * Single integration step: yaw (capped) then move along heading.
   * Called at most once per rAF via paintLoop (not also from glideStep).
   *
   * CONTROL CONTRACT (v1.7.64):
   *  - Yaw only from player steerInput (A/D · ←/→ · flight-bar). Digital −1/0/+1.
   *  - Translation only when thr > deadzone, along CURRENT heading (forward = into nose).
   *  - Never invent thr from steer. Never sample sensorTarget / soft-face.
   *  - Parked (thr≈0): pure look-around yaw, zero position change.
   *  - World rotate is −heading so streak direction matches forward motion.
   */
  function advanceCam(dtRaw) {
    recomputeSteer();
    // Clamp dt so tab-hitch / double-call never spins the sky
    const dt = Math.min(0.05, Math.max(0.001, Number(dtRaw) || 0.016));
    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    // Digital steer only — kill any fractional residual
    const steer =
      Math.abs(steerInput) > 0.5 ? (steerInput > 0 ? 1 : -1) : 0;
    const prevHeading = heading;

    // —— Yaw: PLAYER ONLY. No soft-face, no pin assist, no auto-turn. ——
    let yawApplied = 0;
    let yawSource = "none";
    if (steer !== 0) {
      let yaw = steer * MAX_YAW_DEG_PER_SEC * dt;
      if (yaw > MAX_YAW_DEG_PER_FRAME) yaw = MAX_YAW_DEG_PER_FRAME;
      if (yaw < -MAX_YAW_DEG_PER_FRAME) yaw = -MAX_YAW_DEG_PER_FRAME;
      yawApplied = yaw;
      yawSource = "player";
      heading = (heading + yaw + 360) % 360;
    }

    // —— Throttle: along CURRENT heading only (never toward sensor target) ——
    // Deadzone kills residual crawl from slider/steer thr-floor bugs.
    // No reverse thr — W is always forward along nose.
    const thrLive = t > THR_MOVE_DEADZONE ? t : 0;
    const tCurve = Math.pow(thrLive, THROTTLE_CURVE);
    const maxDegPerSec = thrLive > 0 ? tCurve * MAX_DEG_PER_SEC : 0;
    const stepDeg = maxDegPerSec * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;
    let dRa = 0;
    let dDec = 0;

    if (thrLive > 0 && stepDeg > 0) {
      // Nav heading: 0°=N → +Dec, 90°=E → +RA  (always forward along nose)
      const rad = (heading * Math.PI) / 180;
      let moveNorth = Math.cos(rad) * stepDeg; // true ° north on sky
      let moveEast = Math.sin(rad) * stepDeg; // true ° east on sky

      const cosRaw = Math.cos((cam.dec * Math.PI) / 180);
      const absCos = Math.max(Math.abs(cosRaw) || POLE_COS_FLOOR, POLE_COS_FLOOR);
      const cosDec = Math.sign(cosRaw || 1) * absCos;

      const absDec = Math.abs(cam.dec);
      const northFrac = Math.cos(rad); // +1 = pure north heading
      const eastFrac = Math.sin(rad); // +1 = pure east heading
      const intoPole =
        (cam.dec > 0 && moveNorth > 0) || (cam.dec < 0 && moveNorth < 0);
      // Intentional exit: any equator-ward component or clear E/W turn
      const leavingEquator =
        (cam.dec > 0 && northFrac < -0.08) ||
        (cam.dec < 0 && northFrac > 0.08);
      const leavingLateral =
        Math.abs(eastFrac) > 0.4 && northFrac < 0.5;
      const exiting = leavingEquator || (leavingLateral && !intoPole);

      // Soft damp only when still driving into the pole (not when exiting)
      if (intoPole && absDec > DEC_SOFT_LIMIT && !exiting) {
        const span = Math.max(0.5, DEC_HARD_LIMIT - DEC_SOFT_LIMIT);
        const u = Math.min(1, (absDec - DEC_SOFT_LIMIT) / span);
        const damp = (1 - u) * (1 - u);
        moveNorth *= damp;
        // v1.7.45: NEVER convert blocked north → east (that was the slingshot orbit)
      }

      // Hard wall: zero poleward only
      if (cam.dec >= DEC_HARD_LIMIT - 0.05 && moveNorth > 0) moveNorth = 0;
      else if (cam.dec <= -DEC_HARD_LIMIT + 0.05 && moveNorth < 0) moveNorth = 0;

      // Clean pole exit assist — only near poles (not Gumdrop mid-sky crawl)
      if (exiting && absDec > DEC_SOFT_LIMIT - 2) {
        const u = Math.min(1, (absDec - (DEC_SOFT_LIMIT - 2)) / 6);
        const leave = stepDeg * (0.45 + 0.4 * u);
        if (cam.dec > 0) moveNorth -= leave;
        else moveNorth += leave;
        moveEast *= 0.55 + 0.45 * (1 - u);
      }

      // True-sky speed cap (never exceed throttle step in great-circle °)
      const trueSpd = Math.hypot(moveEast, moveNorth);
      if (trueSpd > stepDeg && trueSpd > 1e-9) {
        const s = stepDeg / trueSpd;
        moveEast *= s;
        moveNorth *= s;
      }

      // RA from true east — floor cos so we don't divide by ~0, then
      // re-cap so |dRa * cos| never exceeds intended true east (anti-slingshot).
      dRa = moveEast / cosDec;
      dDec = moveNorth;
      const trueEast = Math.abs(dRa * absCos);
      if (trueEast > Math.abs(moveEast) + 1e-9 && trueEast > 1e-9) {
        dRa *= Math.abs(moveEast) / trueEast;
      }
      // Absolute RA °/frame safety (visual slingshot guard)
      const maxRaFrame = Math.max(stepDeg * 2.2, 0.08);
      if (dRa > maxRaFrame) dRa = maxRaFrame;
      else if (dRa < -maxRaFrame) dRa = -maxRaFrame;
    }

    if (dRa !== 0 || dDec !== 0) {
      let nRa = cam.ra + dRa;
      let nDec = cam.dec + dDec;
      nRa = ((nRa % 360) + 360) % 360;
      if (nDec > DEC_HARD_LIMIT) nDec = DEC_HARD_LIMIT;
      else if (nDec < -DEC_HARD_LIMIT) nDec = -DEC_HARD_LIMIT;
      cam.ra = nRa;
      cam.dec = nDec;
    }

    // Screen-space velocity for streaks / dust (matches rotated world)
    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const eastMove = dRaMove * cosFx;
    const northMove = dDecMove;
    // Features move opposite camera translation; yaw spins them too
    const scr = skyDeltaToScreen(-eastMove, -northMove, -yawApplied);
    const dxPx = scr.dx;
    const dyPx = scr.dy;
    dustOx = (dustOx + dxPx) % 256;
    dustOy = (dustOy + dyPx) % 256;
    if (thrLive > 0 && dt > 0) {
      panVelX = panVelX * 0.25 + (dxPx / dt) * 0.75;
      panVelY = panVelY * 0.25 + (dyPx / dt) * 0.75;
    } else {
      // Parked / yaw-only: kill residual streak crawl immediately
      panVelX = 0;
      panVelY = 0;
    }
    const movedDeg = Math.hypot(eastMove, northMove);
    lastAdvanceAt = performance.now();
    try {
      window.__ncPull = {
        yawSource,
        yawApplied: +yawApplied.toFixed(4),
        steer,
        thr: t,
        thrLive,
        heading: Math.round(((heading % 360) + 360) % 360),
        sensorAffectsYaw: false,
        sensorAffectsPos: false,
        posMove: movedDeg > 1e-6,
        dRa: +dRaMove.toFixed(5),
        dDec: +dDecMove.toFixed(5),
        forwardStream: true,
        build: "1.7.64",
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
    return {
      dRa: dRaMove,
      dDec: dDecMove,
      movedDeg,
      dxPx,
      dyPx,
      heading,
      prevHeading,
      yawApplied,
      yawSource,
      steer,
    };
  }

  function paintLoop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(paintLoop);
    const dt = lastPaint ? Math.min(0.05, (ts - lastPaint) / 1000) : 0.016;
    lastPaint = ts;
    if (!ctx || w < 2) {
      resize();
      return;
    }
    recomputeSteer();
    // Sole integrator: yaw (A/D) + throttle translate — never skip yaw when held
    if (isFlightPhase() && (throttle > THR_MOVE_DEADZONE || Math.abs(steerInput) > 0.5)) {
      advanceCam(dt);
      publishCam();
    } else if (isFlightPhase() && throttle <= THR_MOVE_DEADZONE) {
      // Parked: kill residual pan so near-stars don't crawl
      panVelX = 0;
      panVelY = 0;
    }
    // Craft bank always follows player steer (even when sensor is off)
    updateCraftBank(dt);
    paint(dt, ts);
  }

  /** Bank from A/D only — never toward radar lock. */
  function updateCraftBank(dtRaw) {
    const dt = Math.min(0.05, Math.max(0.001, Number(dtRaw) || 0.016));
    const follow = 1 - Math.exp(-16 * dt);
    const playerSteering = Math.abs(steerInput || 0) > 0.04;
    const bankTarget = playerSteering
      ? Math.max(-1, Math.min(1, steerInput || 0)) * 0.28
      : 0;
    craftBankSm += (bankTarget - craftBankSm) * follow;
  }

  function paint(dt, ts) {
    const t = ts * 0.001;
    // Static backdrop (doesn't need yaw — pure black depth)
    drawAtmosphere();
    // Scenery beacons (Altair porch, …) not in night JSON — keep approach live
    refreshRibbonApproachFromSky();

    // —— World layer: rotate entire sky so heading = UP ——
    // A/D changes heading → this rotation turns anchors/stars every frame.
    const cx = w * 0.5;
    const cy = h * 0.5;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(worldRotationRad());
    ctx.translate(-cx, -cy);
    drawDustLayer();
    drawCoordGrid(); // very faint, behind ribbon/anchors
    drawMilkyBand(t);
    drawNebulae();
    drawLandmarks(t);
    drawFieldStars(t);
    drawClouds(t);
    drawOverlays();
    ctx.restore();

    // Screen-space layers (not rotated with world)
    drawNearStars(dt, t);
    drawRibbonBearingCue();
    drawVignette(t);
    // Flight chrome AFTER vignette — one N·E·S·W set only (no outer rim)
    drawCompassRose(t);
    drawForwardSensor(t, dt);
    drawHeadingHud(t);
    drawGlassWhisper(ts);
  }

  /**
   * Single compass layer: punchy N/E/S/W around the craft (v1.7.50).
   * Outer screen-edge cardinal rim removed — no duplicate W/N/E/S.
   * No full compass ring disc; ticks + pills only so sky stays open.
   */
  function drawCompassRose(t) {
    if (!isFlightPhase()) return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.175;
    const rot = worldRotationRad();
    const pulse = 0.94 + 0.06 * Math.sin(t * 1.4);

    ctx.save();
    ctx.translate(cx, cy);

    // No outer ring / plate — only cardinal ticks + pills

    // Soft intermediate ticks (NE/SE/SW/NW) without a full circle stroke
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) continue; // skip N/E/S/W (drawn as pills)
      const ang = (i * Math.PI) / 4;
      const east = Math.sin(ang);
      const north = Math.cos(ang);
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const rdx = east * cosR - -north * sinR;
      const rdy = east * sinR + -north * cosR;
      const len = Math.hypot(rdx, rdy) || 1;
      const ux = rdx / len;
      const uy = rdy / len;
      ctx.strokeStyle = `rgba(190, 215, 245, ${0.22 * pulse})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ux * (R - 8), uy * (R - 8));
      ctx.lineTo(ux * (R - 1), uy * (R - 1));
      ctx.stroke();
    }

    // One clean N/E/S/W set (punchy pills)
    const dirs = [
      { name: "N", ang: 0, gold: true },
      { name: "E", ang: Math.PI / 2, gold: false },
      { name: "S", ang: Math.PI, gold: false },
      { name: "W", ang: -Math.PI / 2, gold: false },
    ];
    for (const d of dirs) {
      const east = Math.sin(d.ang);
      const north = Math.cos(d.ang);
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const rdx = east * cosR - -north * sinR;
      const rdy = east * sinR + -north * cosR;
      const len = Math.hypot(rdx, rdy) || 1;
      const ux = rdx / len;
      const uy = rdy / len;

      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.lineWidth = d.gold ? 5.5 : 4.5;
      ctx.beginPath();
      ctx.moveTo(ux * (R - 14), uy * (R - 14));
      ctx.lineTo(ux * (R + 3), uy * (R + 3));
      ctx.stroke();
      ctx.strokeStyle = d.gold
        ? `rgba(255, 225, 150, ${0.98 * pulse})`
        : `rgba(220, 235, 255, ${0.92 * pulse})`;
      ctx.lineWidth = d.gold ? 3.0 : 2.5;
      ctx.beginPath();
      ctx.moveTo(ux * (R - 12), uy * (R - 12));
      ctx.lineTo(ux * (R + 1), uy * (R + 1));
      ctx.stroke();

      const lx = ux * (R + 18);
      const ly = uy * (R + 18);
      ctx.font = d.gold
        ? "bold 15px system-ui, sans-serif"
        : "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(d.name).width;
      const pw = tw + 14;
      const ph = 22;
      ctx.fillStyle = "rgba(4, 8, 18, 0.82)";
      ctx.strokeStyle = d.gold
        ? `rgba(255, 220, 150, ${0.7 * pulse})`
        : `rgba(160, 200, 255, ${0.55 * pulse})`;
      ctx.lineWidth = 1.4;
      const rx = lx - pw * 0.5;
      const ry = ly - ph * 0.5;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(rx, ry, pw, ph, 5);
      } else {
        ctx.rect(rx, ry, pw, ph);
      }
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.fillText(d.name, lx + 1.2, ly + 1.2);
      ctx.fillStyle = d.gold
        ? "rgba(255, 236, 180, 1)"
        : "rgba(240, 248, 255, 1)";
      ctx.fillText(d.name, lx, ly);
    }

    // Short nose tick only (no full dashed diameter across the glass)
    ctx.strokeStyle = `rgba(255, 220, 145, ${0.5 * pulse})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.35);
    ctx.lineTo(0, -R * 0.85);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Outer screen-edge N/E/S/W — disabled (v1.7.50).
   * Kept as no-op so old call sites don't break; single set lives in drawCompassRose.
   */
  function drawCardinalRim() {
    /* intentionally empty — no duplicate outer cardinals */
  }

  /**
   * Soft edge tick pointing toward the milky ribbon if it's off-center.
   * Helps find Dec~+20° while slow-yawing.
   */
  function drawRibbonBearingCue() {
    if (!isFlightPhase()) return;
    const mid = project(cam.ra, 20);
    const cx = w * 0.5;
    const cy = h * 0.5;
    // Transform world-projected point by same rotation as world layer
    const rot = worldRotationRad();
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    let tx = cx;
    let ty = cy;
    let onGlass = false;
    if (mid) {
      const lx = mid.x - cx;
      const ly = mid.y - cy;
      tx = cx + lx * cosR - ly * sinR;
      ty = cy + lx * sinR + ly * cosR;
      onGlass =
        tx > 24 && tx < w - 24 && ty > 24 && ty < h - 24;
    }
    if (onGlass) return; // ribbon already in view — label on band is enough

    // Direction from center toward ribbon in screen space
    let dx = tx - cx;
    let dy = ty - cy;
    // If project failed, aim by dec only (north if cam.dec < 20)
    if (!mid) {
      const aimNorth = cam.dec < 20;
      // north in screen after rot
      let ndx = 0;
      let ndy = -1;
      dx = ndx * cosR - ndy * sinR;
      dy = ndx * sinR + ndy * cosR;
      if (!aimNorth) {
        dx = -dx;
        dy = -dy;
      }
    }
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const edge = Math.min(w, h) * 0.38;
    const ex = cx + ux * edge;
    const ey = cy + uy * edge;

    ctx.save();
    ctx.strokeStyle = "rgba(180, 210, 255, 0.4)";
    ctx.fillStyle = "rgba(180, 210, 255, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + ux * (edge - 28), cy + uy * (edge - 28));
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // chevron
    const px = -uy;
    const py = ux;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ux * 10 + px * 5, ey - uy * 10 + py * 5);
    ctx.lineTo(ex - ux * 10 - px * 5, ey - uy * 10 - py * 5);
    ctx.closePath();
    ctx.fill();
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(190, 215, 255, 0.55)";
    ctx.fillText("ribbon", ex - ux * 18, ey - uy * 18);
    ctx.restore();
  }

  /** NC_SENSOR_BUILD 1.7.38 — game-loop drives this every proximity tick */
  function setSensorTarget(t) {
    if (!t || t.ra == null || t.dec == null) {
      sensorTarget = null;
      return;
    }
    const ra = Number(t.ra);
    const dec = Number(t.dec);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      sensorTarget = null;
      return;
    }
    sensorTarget = {
      ra,
      dec,
      label: t.label ? String(t.label).slice(0, 28) : "",
      kind: t.kind || "nav",
      distDeg: Number.isFinite(Number(t.distDeg)) ? Number(t.distDeg) : null,
      mode: t.mode || null,
      build: "1.7.64",
    };
  }

  /** Soft visual flash when audio sensor pings (game-loop calls after cue). */
  function sensorPingPulse(strength = 0.6) {
    sensorPingFlash = Math.max(
      sensorPingFlash,
      Math.max(0.35, Math.min(1, Number(strength) || 0.6))
    );
  }

  /**
   * Screen-space bearing of a sky point relative to nose (up).
   * angleRad: 0 = dead ahead, + = right of nose, − = left (screen).
   */
  function sensorBearingTo(ra, dec) {
    const p = project(ra, dec);
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rot = worldRotationRad();
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    let sx;
    let sy;
    if (p) {
      const lx = p.x - cx;
      const ly = p.y - cy;
      sx = lx * cosR - ly * sinR;
      sy = lx * sinR + ly * cosR;
    } else {
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      const east = wrapDeltaRa(ra - cam.ra) * cos;
      const north = dec - cam.dec;
      const dx = east;
      const dy = -north;
      sx = dx * cosR - dy * sinR;
      sy = dx * sinR + dy * cosR;
    }
    const distPx = Math.hypot(sx, sy) || 1;
    const angleRad = Math.atan2(sx, -sy);
    const onGlass =
      !!p &&
      p.x > 20 &&
      p.x < w - 20 &&
      p.y > 20 &&
      p.y < h - 20;
    return {
      angleRad,
      onGlass,
      distPx,
      ux: sx / distPx,
      uy: sy / distPx,
      sx,
      sy,
    };
  }

  /**
   * Amplify small heading errors so the blip moves while near the path.
   * True ±12° error → ~full scan cone so corrections are readable.
   */
  function amplifySensorAngle(angleRad, halfSpan) {
    const sens = 2.4; // gain on small errors
    const raw = angleRad * sens;
    if (raw > halfSpan) return halfSpan;
    if (raw < -halfSpan) return -halfSpan;
    // Ease near center so micro-wobble still shows as a gentle sway
    return Math.tanh(raw / halfSpan) * halfSpan;
  }

  /**
   * Forward sensor — brighter on-path, responsive blip (v1.7.37).
   * Still immersive (no minimap); readable enough to hunt the last marker.
   */
  function drawForwardSensor(t, dt = 0.016) {
    if (!isFlightPhase() || !sensorTarget) return;
    const br = sensorBearingTo(sensorTarget.ra, sensorTarget.dec);
    if (!br) return;

    if (sensorPingFlash > 0) {
      sensorPingFlash = Math.max(0, sensorPingFlash - dt * 1.35);
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.26;
    const craftNose = Math.min(w, h) * 0.07;
    const arcY = cy - craftNose * 0.5;
    const halfSpan = (68 * Math.PI) / 180; // wider scan so pointer has room

    // Live range (prefer fresh cam math over stale game-loop sample)
    const cosLive = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const distLive = Math.hypot(
      wrapDeltaRa(sensorTarget.ra - cam.ra) * cosLive,
      sensorTarget.dec - cam.dec
    );
    const dist =
      Number.isFinite(distLive) && distLive < 1e6
        ? distLive
        : sensorTarget.distDeg != null
          ? sensorTarget.distDeg
          : 40;

    const trueA = br.angleRad;
    const offCone = Math.abs(trueA) > halfSpan * 0.95;
    let aTarget = amplifySensorAngle(trueA, halfSpan);
    if (offCone) aTarget = trueA > 0 ? halfSpan : -halfSpan;

    // Smooth blip so it visibly tracks while you yaw near the path
    const dtClamped = Math.min(0.05, Math.max(0.001, dt));
    const follow = 1 - Math.exp(-16 * dtClamped); // snappy for last-marker hunt
    sensorBlipAngSm += (aTarget - sensorBlipAngSm) * follow;
    const a = sensorBlipAngSm;

    // On-course when true bearing is tight (path lock)
    const onPath = Math.abs(trueA) < 0.22; // ~12.5°
    const nearPath = Math.abs(trueA) < 0.45; // ~25°
    const closing = dist < 22;
    const locked = dist < 4.5 && Math.abs(trueA) < 0.18;

    // Strong baseline so the scan cone never disappears into stars
    let rangeAlpha = 0.58;
    if (dist > 55) rangeAlpha = 0.52;
    else if (dist > 30) rangeAlpha = 0.62;
    else if (dist > 14) rangeAlpha = 0.72;
    else if (dist > 6) rangeAlpha = 0.84;
    else rangeAlpha = 0.94;
    if (onPath) rangeAlpha = Math.min(0.98, rangeAlpha + 0.14);
    else if (nearPath) rangeAlpha = Math.min(0.95, rangeAlpha + 0.08);
    if (closing) rangeAlpha = Math.min(0.98, rangeAlpha + 0.05);

    const flash = sensorPingFlash * 0.6;
    const breath = 0.94 + 0.06 * Math.sin(t * (locked ? 3.2 : 1.4));
    const alpha = Math.min(0.99, (rangeAlpha + flash) * breath);

    // Craft bank is updated in paintLoop (player steer only).

    ctx.save();
    ctx.translate(cx, arcY);

    // Soft filled cone (reads better against star field)
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, -Math.PI / 2 - halfSpan, -Math.PI / 2 + halfSpan);
    ctx.closePath();
    const coneA = (onPath ? 0.16 : 0.09) + flash * 0.1;
    ctx.fillStyle = onPath
      ? `rgba(255, 230, 170, ${coneA})`
      : `rgba(120, 180, 240, ${coneA})`;
    ctx.fill();

    // Scan arc rim — dark understroke + bright ice/gold
    ctx.beginPath();
    ctx.arc(0, 0, R, -Math.PI / 2 - halfSpan, -Math.PI / 2 + halfSpan);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
    ctx.lineWidth = onPath || closing ? 4.5 : 3.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R, -Math.PI / 2 - halfSpan, -Math.PI / 2 + halfSpan);
    ctx.strokeStyle = onPath
      ? `rgba(255, 220, 150, ${0.68 + flash * 0.3 + (closing ? 0.12 : 0)})`
      : `rgba(185, 225, 255, ${0.62 + flash * 0.28})`;
    ctx.lineWidth = onPath || closing ? 2.8 : 2.2;
    ctx.stroke();

    // Range ticks
    for (const f of [0.38, 0.68]) {
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        R * f,
        -Math.PI / 2 - halfSpan * 0.92,
        -Math.PI / 2 + halfSpan * 0.92
      );
      ctx.strokeStyle = `rgba(170, 210, 245, ${0.14 + flash * 0.12 + (onPath ? 0.08 : 0)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Nose notch (gold when on path)
    ctx.strokeStyle = onPath
      ? `rgba(255, 220, 140, ${0.85 + flash * 0.15})`
      : `rgba(232, 213, 163, ${0.55 + flash * 0.3})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.08);
    ctx.lineTo(0, -R * 0.32);
    ctx.stroke();

    // Ping ring
    if (sensorPingFlash > 0.04) {
      const pr = R * (0.3 + (1 - sensorPingFlash) * 0.75);
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        pr,
        -Math.PI / 2 - halfSpan * 0.88,
        -Math.PI / 2 + halfSpan * 0.88
      );
      ctx.strokeStyle = `rgba(200, 230, 255, ${0.35 * sensorPingFlash})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Blip radius: closer contacts sit higher on the arc (toward nose)
    const blipR = R * (0.42 + Math.min(0.5, dist / 55) * 0.45);
    const blipAng = -Math.PI / 2 + a;
    const bx = Math.cos(blipAng) * blipR;
    const by = Math.sin(blipAng) * blipR;
    const blipPulse = 0.78 + 0.22 * Math.sin(t * (locked ? 5.5 : onPath ? 3.5 : 2.2));
    const ba = Math.min(1, alpha * blipPulse * 1.05);

    let brgb = "180, 225, 255";
    if (sensorTarget.kind === "drift" || sensorTarget.kind === "chapter") {
      brgb = "255, 225, 150";
    } else if (sensorTarget.kind === "house") {
      brgb = "255, 205, 165";
    } else if (sensorTarget.kind === "beacon") {
      brgb = "200, 190, 255"; // Night Vale / scenery
    }
    if (onPath) brgb = locked ? "255, 230, 160" : "220, 235, 255";

    // Lead line — thicker when near path
    ctx.strokeStyle = `rgba(190, 220, 255, ${0.28 + flash * 0.25 + (onPath ? 0.2 : 0)})`;
    ctx.lineWidth = onPath || closing ? 2 : 1.4;
    ctx.setLineDash(offCone ? [3, 4] : []);
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.1);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);

    // Direction chevron at blip (reads as a pointer, not a static dot)
    const chevron = 7 + (closing ? 2 : 0);
    const cux = Math.cos(blipAng);
    const cuy = Math.sin(blipAng);
    const px = -cuy;
    const py = cux;
    ctx.fillStyle = `rgba(${brgb}, ${ba})`;
    ctx.beginPath();
    ctx.moveTo(bx + cux * 3, by + cuy * 3);
    ctx.lineTo(bx - cux * chevron + px * 5, by - cuy * chevron + py * 5);
    ctx.lineTo(bx - cux * chevron - px * 5, by - cuy * chevron - py * 5);
    ctx.closePath();
    ctx.fill();

    // Blip halo + core
    const haloR = 14 + flash * 8 + (onPath ? 4 : 0);
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, haloR);
    g.addColorStop(0, `rgba(${brgb}, ${ba})`);
    g.addColorStop(0.35, `rgba(${brgb}, ${0.4 * alpha})`);
    g.addColorStop(1, "rgba(160, 200, 240, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + flash * 0.3})`;
    ctx.beginPath();
    ctx.arc(bx, by, locked ? 3.8 : onPath ? 3.2 : 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${brgb}, ${ba})`;
    ctx.beginPath();
    ctx.arc(bx, by, locked ? 5.5 : 4.2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${brgb}, ${0.7 * alpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Edge arrow when outside cone
    if (offCone) {
      const edgeAng = -Math.PI / 2 + (trueA > 0 ? halfSpan : -halfSpan);
      const ex = Math.cos(edgeAng) * (R + 6);
      const ey = Math.sin(edgeAng) * (R + 6);
      ctx.fillStyle = `rgba(220, 235, 255, ${0.7 + flash * 0.2})`;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + (trueA > 0 ? 7 : -7), ey - 5);
      ctx.lineTo(ex + (trueA > 0 ? 7 : -7), ey + 5);
      ctx.closePath();
      ctx.fill();
    }

    // Labels — high-contrast plates so target name guides the hunt
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "bold 12px system-ui, sans-serif";
    const tag =
      sensorTarget.kind === "pin" || sensorTarget.kind === "story"
        ? "nav"
        : sensorTarget.kind === "drift"
          ? "glow"
          : sensorTarget.kind === "house"
            ? "house"
            : sensorTarget.kind === "chapter"
              ? "chapter"
              : sensorTarget.kind === "beacon"
                ? "beacon"
                : "sensor";
    const pathTag = onPath ? (locked ? " · lock" : " · path") : "";
    const tagLine = `${tag}${pathTag}`;
    let twTag = ctx.measureText(tagLine).width;
    ctx.fillStyle = "rgba(4, 8, 18, 0.72)";
    ctx.fillRect(-twTag * 0.5 - 6, R * 0.12, twTag + 12, 16);
    ctx.fillStyle = `rgba(220, 235, 255, ${0.92 + flash * 0.08})`;
    ctx.fillText(tagLine, 0, R * 0.13);
    if (sensorTarget.label) {
      ctx.font = "bold 13px system-ui, sans-serif";
      const short =
        sensorTarget.label.length > 18
          ? `${sensorTarget.label.slice(0, 16)}…`
          : sensorTarget.label;
      const tw = ctx.measureText(short).width;
      ctx.fillStyle = `rgba(4, 8, 18, ${0.78 + (onPath ? 0.08 : 0)})`;
      ctx.strokeStyle = onPath
        ? "rgba(255, 220, 150, 0.55)"
        : "rgba(140, 190, 255, 0.45)";
      ctx.lineWidth = 1.2;
      const ly = R * 0.12 + 18;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(-tw * 0.5 - 8, ly, tw + 16, 20, 5);
      } else {
        ctx.rect(-tw * 0.5 - 8, ly, tw + 16, 20);
      }
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = onPath
        ? `rgba(255, 240, 200, 1)`
        : `rgba(245, 250, 255, 1)`;
      ctx.fillText(short, 0, ly + 3);
    }
    ctx.font = "bold 12px system-ui, sans-serif";
    const rangeTxt =
      dist < 1.2 ? "LOCK" : dist < 5 ? "CLOSE" : `${Math.round(dist)}° out`;
    const ry = R * 0.12 + (sensorTarget.label ? 42 : 20);
    const rw = ctx.measureText(rangeTxt).width;
    ctx.fillStyle = "rgba(4, 8, 18, 0.7)";
    ctx.fillRect(-rw * 0.5 - 6, ry, rw + 12, 16);
    ctx.fillStyle = locked
      ? "rgba(255, 230, 160, 1)"
      : closing
        ? "rgba(200, 230, 255, 1)"
        : "rgba(190, 215, 245, 0.95)";
    ctx.fillText(rangeTxt, 0, ry + 1);

    // On-glass reticle toward contact (stronger near path)
    if (br.onGlass && Math.abs(trueA) < 0.7 && dist < 28) {
      ctx.restore();
      ctx.save();
      const gx = cx + br.sx;
      const gy = cy + br.sy;
      const ra = 0.28 + flash * 0.3 + (onPath ? 0.25 : 0) + (closing ? 0.12 : 0);
      ctx.strokeStyle = onPath
        ? `rgba(255, 220, 150, ${ra})`
        : `rgba(180, 220, 255, ${ra})`;
      ctx.lineWidth = onPath ? 2 : 1.4;
      ctx.beginPath();
      ctx.arc(gx, gy, 16 + flash * 10 + (closing ? 4 : 0), 0, Math.PI * 2);
      ctx.stroke();
      // Cross ticks
      ctx.beginPath();
      ctx.moveTo(gx - 10, gy);
      ctx.lineTo(gx - 4, gy);
      ctx.moveTo(gx + 4, gy);
      ctx.lineTo(gx + 10, gy);
      ctx.moveTo(gx, gy - 10);
      ctx.lineTo(gx, gy - 4);
      ctx.moveTo(gx, gy + 4);
      ctx.lineTo(gx, gy + 10);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Spacecraft — punchy small pointer (1.7.37 boost kept).
   * Nose UP; banks from player A/D only (never toward sensor lock).
   */
  function drawCraftShip(cx, cy, scale = 1, t = 0) {
    const s = Math.max(1.0, scale);
    const steer = Math.max(-1, Math.min(1, steerInput || 0));
    // Player bank only — sensor-lean was the "suction" read on ribbon legs
    const bank =
      Math.abs(craftBankSm) > 0.01 ? craftBankSm : steer * 0.28;
    const pulse = 0.95 + 0.05 * Math.sin(t * 2.4);
    const thr = Math.max(0, Math.min(1, throttle || 0));
    const onContact =
      sensorTarget &&
      Math.abs(sensorBlipAngSm) < 0.35;
    // Turn cue only when YOU are steering — radar blip already shows contact
    const turnCue = Math.abs(steer) > 0.08 ? steer : 0;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(bank);

    // Dark under-silhouette so craft reads on bright nebulae
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.moveTo(0, -18 * s);
    ctx.lineTo(15 * s, 7.5 * s);
    ctx.lineTo(0, 12 * s);
    ctx.lineTo(-15 * s, 7.5 * s);
    ctx.closePath();
    ctx.fill();

    if (thr > 0.04) {
      const eg = ctx.createRadialGradient(0, 12 * s, 0, 0, 15 * s, 24 * s);
      eg.addColorStop(0, `rgba(170, 220, 255, ${0.5 * thr * pulse})`);
      eg.addColorStop(1, "rgba(100, 160, 255, 0)");
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.ellipse(0, 14 * s, 7.5 * s + thr * 4.5, 13 * s + thr * 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Wings
    ctx.beginPath();
    ctx.moveTo(-14.5 * s, 5.5 * s);
    ctx.lineTo(0, -2.5 * s);
    ctx.lineTo(14.5 * s, 5.5 * s);
    ctx.lineTo(9.5 * s, 9 * s);
    ctx.lineTo(0, 2.8 * s);
    ctx.lineTo(-9.5 * s, 9 * s);
    ctx.closePath();
    ctx.fillStyle = `rgba(175, 215, 255, ${0.9 * pulse})`;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(245, 250, 255, 0.98)";
    ctx.lineWidth = 1.8;
    ctx.fill();
    ctx.stroke();

    // Fuselage
    ctx.beginPath();
    ctx.moveTo(0, -17.5 * s);
    ctx.lineTo(4.2 * s, 2.4 * s);
    ctx.lineTo(0, 11.5 * s);
    ctx.lineTo(-4.2 * s, 2.4 * s);
    ctx.closePath();
    ctx.fillStyle = "rgba(248, 250, 255, 0.98)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.lineWidth = 3.2;
    ctx.stroke();
    ctx.strokeStyle = onContact
      ? "rgba(255, 225, 145, 1)"
      : "rgba(255, 235, 175, 0.98)";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    // Cockpit
    ctx.beginPath();
    ctx.ellipse(0, -5.2 * s, 2.3 * s, 3 * s, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 248, 210, 1)";
    ctx.fill();
    ctx.strokeStyle = "rgba(40, 30, 10, 0.45)";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Nose tip — gold pointer
    ctx.beginPath();
    ctx.moveTo(0, -19 * s);
    ctx.lineTo(3.6 * s, -9.8 * s);
    ctx.lineTo(-3.6 * s, -9.8 * s);
    ctx.closePath();
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -18.3 * s);
    ctx.lineTo(3.2 * s, -10 * s);
    ctx.lineTo(-3.2 * s, -10 * s);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 225, 140, 1)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 250, 220, 0.95)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (sensorTarget) {
      const side = Math.sign(sensorBlipAngSm || 0) || 0;
      const blink = 0.55 + 0.45 * Math.sin(t * 7);
      const lx = side >= 0 ? 11 * s : -11 * s;
      ctx.fillStyle = `rgba(120, 240, 255, ${0.6 + blink * 0.35})`;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(lx, 4.2 * s, 2.5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(140, 180, 220, 0.32)";
      ctx.beginPath();
      ctx.arc(-lx, 4.2 * s, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Turn cue (subtle side chevron — not a big circle)
    if (Math.abs(turnCue) > 0.12) {
      ctx.save();
      ctx.translate(cx, cy);
      const side = turnCue > 0 ? 1 : -1;
      const ax = side * 28 * s;
      const blink = 0.7 + 0.3 * Math.sin(t * 5);
      ctx.fillStyle = onContact
        ? `rgba(255, 230, 160, ${0.32 * blink})`
        : `rgba(160, 210, 255, ${0.48 * blink})`;
      ctx.beginPath();
      ctx.moveTo(ax, 0);
      ctx.lineTo(ax - side * 10 * s, -6 * s);
      ctx.lineTo(ax - side * 10 * s, 6 * s);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Craft HUD — ship circle QUIET (v1.7.41); craft pointer stays punchy.
   */
  function drawHeadingHud(t = 0) {
    if (!isFlightPhase()) return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    // Punchy small craft scale (1.7.37 boost)
    const craftScale = Math.min(w, h) * 0.0031;
    const s = Math.max(1.12, Math.min(1.75, craftScale * 18));

    ctx.save();
    const onPathRing =
      sensorTarget && Math.abs(sensorBlipAngSm) < 0.35;

    // —— Ship circle: significantly reduced (was heavy multi-layer disc) ——
    // Tiny soft plate only under the craft silhouette
    ctx.beginPath();
    ctx.arc(cx, cy, 16 * s, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(3, 6, 14, 0.16)";
    ctx.fill();

    // Single thin station ring (no dual/triple stack)
    ctx.strokeStyle = onPathRing
      ? "rgba(255, 220, 140, 0.28)"
      : "rgba(185, 220, 255, 0.22)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(cx, cy, 18 * s, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
    drawCraftShip(cx, cy, s, t);
    ctx.save();

    // Readout: nav HDG (0°=N … 270°=W) + cardinal + FoV
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const hdgNum = Math.round(((heading % 360) + 360) % 360);
    const card = bearingCardinal(hdgNum);
    const hdg = `hdg ${hdgNum}° ${card} · FoV ${cam.fov.toFixed(0)}°`;
    const hw = ctx.measureText(hdg).width;
    const hy = cy + 26 * s;
    ctx.fillStyle = "rgba(4, 8, 18, 0.62)";
    ctx.strokeStyle = "rgba(150, 190, 240, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(cx - hw * 0.5 - 8, hy - 9, hw + 16, 18, 4);
    } else {
      ctx.rect(cx - hw * 0.5 - 8, hy - 9, hw + 16, 18);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillText(hdg, cx + 1, hy + 1);
    ctx.fillStyle = "rgba(245, 248, 255, 0.94)";
    ctx.fillText(hdg, cx, hy);

    // True bearing to sensor contact (same compass convention)
    let line2 = null;
    let line2Gold = false;
    if (sensorTarget) {
      const brg = bearingNavTo(sensorTarget.ra, sensorTarget.dec);
      if (brg != null) {
        const bc = bearingCardinal(brg);
        const short =
          sensorTarget.label && sensorTarget.label.length > 14
            ? `${sensorTarget.label.slice(0, 12)}…`
            : sensorTarget.label || "contact";
        line2 = `brg ${Math.round(brg)}° ${bc} → ${short}`;
        line2Gold = Math.abs(sensorBlipAngSm) < 0.14;
      }
    }
    if (!line2) {
      if (Math.abs(steerInput) > 0.02) {
        line2 = steerInput > 0 ? "turning right →" : "← turning left";
        line2Gold = true;
      } else if (sensorTarget && Math.abs(sensorBlipAngSm) > 0.14) {
        line2 =
          sensorBlipAngSm > 0
            ? "yaw right (D) → contact"
            : "← yaw left (A) · contact";
      } else if (sensorTarget) {
        line2 = "on path · W to glide";
        line2Gold = true;
      }
    }
    if (line2) {
      ctx.font = "bold 11px system-ui, sans-serif";
      const cw = ctx.measureText(line2).width;
      const cy2 = hy + 17;
      ctx.fillStyle = "rgba(4, 8, 18, 0.55)";
      ctx.fillRect(cx - cw * 0.5 - 7, cy2 - 8, cw + 14, 16);
      ctx.fillStyle = line2Gold
        ? "rgba(255, 230, 160, 0.92)"
        : "rgba(190, 225, 255, 0.9)";
      ctx.fillText(line2, cx, cy2);
    }
    ctx.restore();
  }

  function drawAtmosphere() {
    // Shift glow with camera so the whole sky “slides,” not only stars
    const fov = Math.max(2, cam.fov);
    const ox = ((cam.ra % 40) / 40 - 0.5) * w * 0.08;
    const oy = (cam.dec / 90) * h * 0.06;
    const cx = w * 0.5 + ox;
    const cy = h * 0.42 + oy;

    const g = ctx.createRadialGradient(
      cx,
      cy,
      0,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.75
    );
    const sat = weatherMood === "cold" ? 48 : weatherMood === "warm" ? 52 : 42;
    const topHue =
      weatherMood === "rose"
        ? 320
        : weatherMood === "warm"
          ? 28
          : weatherMood === "cold"
            ? 205
            : skyHue;
    // Hue drifts with RA so long pans change the sky color
    const hueShift = (cam.ra * 0.15) % 40;
    const core = `hsla(${topHue + skyWarmth * 20 + hueShift}, ${sat}%, ${11 + skyWarmth * 8}%, 1)`;
    const mid = `hsla(${skyHue + hueShift * 0.5}, ${sat}%, 7%, 1)`;
    const edge = "#03040a";
    g.addColorStop(0, core);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, edge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const hg = ctx.createLinearGradient(0, h * 0.55, 0, h);
    hg.addColorStop(0, "rgba(0,0,0,0)");
    const hCol =
      weatherMood === "warm"
        ? "rgba(60, 30, 20, 0.35)"
        : weatherMood === "rose"
          ? "rgba(50, 20, 40, 0.3)"
          : "rgba(10, 20, 40, 0.35)";
    hg.addColorStop(1, hCol);
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);
  }

  /** Sparse soft dust — less visual noise than before */
  function drawDustLayer() {
    const cell = 64;
    ctx.save();
    ctx.globalAlpha = 0.28;
    for (let yy = -cell; yy < h + cell; yy += cell) {
      for (let xx = -cell; xx < w + cell; xx += cell) {
        const px = xx + dustOx;
        const py = yy + dustOy;
        const n = hash01(Math.floor(px / cell), Math.floor(py / cell));
        if (n < 0.55) continue;
        const r = 0.5 + n * 1.1;
        ctx.fillStyle =
          n > 0.88
            ? `rgba(255, 230, 200, ${0.2 + n * 0.25})`
            : `rgba(200, 220, 255, ${0.15 + n * 0.2})`;
        ctx.beginPath();
        ctx.arc(
          xx + n * cell * 0.5,
          yy + (1 - n) * cell * 0.5,
          r,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The “ribbon” — soft galactic band near Dec +20°.
   * Pulsing glow + trail; brightens modestly when approaching a pin/glow.
   */
  function drawMilkyBand(t = 0) {
    const samples = 40;
    const halfSpan = Math.max(55, cam.fov * 2.4);
    const approach = Math.max(0, Math.min(1, ribbonApproach));
    // Base breath + approach lift (noticeable but not neon)
    const breath =
      (0.9 + 0.2 * Math.sin(t * 1.05)) * (1 + approach * 0.55);
    const aMul = 1.35 + approach * 0.9; // modest intensity bump
    // Warm gold wash when close to a pin
    const coreRgb =
      approach > 0.35
        ? `${Math.round(220 + approach * 25)}, ${Math.round(228 + approach * 10)}, ${Math.round(245 - approach * 40)}`
        : "220, 230, 255";
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const collect = (dec) => {
      const pts = [];
      for (let i = 0; i <= samples; i++) {
        const ra = cam.ra - halfSpan + (i / samples) * halfSpan * 2;
        const p = project(ra, dec);
        if (p) pts.push(p);
      }
      return pts;
    };

    const strokePts = (pts, width, alpha, color = "210, 220, 255") => {
      if (pts.length < 2) return;
      ctx.strokeStyle = `rgba(${color}, ${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    };

    const core = collect(20);
    const baseW = Math.max(34, Math.min(w, h) * 0.11) * (1 + approach * 0.2);

    // Wide outer halo (trail) — alphas raised so ribbon reads at cruise FoV
    strokePts(core, baseW * 2.5, 0.08 * breath * aMul, "180, 200, 255");
    strokePts(core, baseW * 1.7, 0.14 * breath * aMul, "200, 215, 255");
    // Bright core
    strokePts(core, baseW * 1.0, 0.28 * breath * aMul, coreRgb);
    strokePts(core, baseW * 0.4, 0.4 * breath * aMul, "240, 245, 255");
    // Parallel wisps
    strokePts(collect(17.5), baseW * 0.55, 0.14 * breath * aMul, "200, 210, 255");
    strokePts(collect(22.5), baseW * 0.5, 0.13 * breath * aMul, "200, 210, 255");

    // Soft sparkles along ribbon — denser + brighter near pins
    const sparkStep = approach > 0.4 ? 2 : 3;
    for (let i = 0; i < core.length; i += sparkStep) {
      const p = core[i];
      const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.7);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12 + tw * 10 + approach * 8);
      g.addColorStop(
        0,
        `rgba(240, 245, 255, ${(0.16 + approach * 0.14) * tw * breath})`
      );
      g.addColorStop(1, "rgba(200, 220, 255, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14 + tw * 7 + approach * 6, 0, Math.PI * 2);
      ctx.fill();
    }

    const mid = project(cam.ra, 20);
    if (mid && mid.x > 40 && mid.x < w - 40 && mid.y > 20 && mid.y < h - 20) {
      const lp = 0.75 + 0.25 * Math.sin(t * 1.5) + approach * 0.15;
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(12, 16, 28, ${0.4 * lp})`;
      ctx.fillText("∽ ribbon", mid.x + 1, mid.y - baseW * 0.55 + 1);
      ctx.fillStyle = `rgba(220, 232, 255, ${0.65 * lp})`;
      ctx.fillText("∽ ribbon", mid.x, mid.y - baseW * 0.55);
    }
    ctx.restore();
  }

  function setRibbonApproach(v) {
    const n = Number(v);
    ribbonApproach = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  /**
   * Approach intensity 0–1 from nearest labeled landmark (14°/8° ramp).
   * Used so scenery beacons (Altair porch, Deneb, …) brighten even when
   * they are not night JSON pins / house_pins.
   */
  function approachIntensityFromLandmarks() {
    let nearest = Infinity;
    for (const L of landmarks) {
      if (!L.label || L.ra == null || L.ghost) continue; // ghosts don't pull ribbon glow
      const d = landmarkCamDist(L);
      if (Number.isFinite(d) && d < nearest) nearest = d;
    }
    if (!(nearest < 14)) return 0;
    let g = Math.pow(1 - nearest / 14, 0.85);
    if (nearest < 8) g = Math.max(g, Math.pow(1 - nearest / 8, 0.7));
    return Math.max(0, Math.min(1, g));
  }

  /** Merge game-loop glow with live landmark distance (belt-and-suspenders). */
  function refreshRibbonApproachFromSky() {
    const fromLm = approachIntensityFromLandmarks();
    if (fromLm > ribbonApproach) ribbonApproach = fromLm;
  }

  /**
   * Barely-there sky grid — heavy fade so ribbon + anchors stay primary.
   * Lines stay at the periphery (radial mask); center of glass is almost clean.
   */
  function drawCoordGrid() {
    const fov = Math.max(2, cam.fov);
    // Very coarse lattice — avoids checkered cage feel
    const step = fov > 16 ? 30 : 20;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const fadeR = Math.min(w, h) * 0.22; // soft hole in the middle
    const fullR = Math.min(w, h) * 0.55;

    ctx.save();
    // Clip+fade: draw to temp opacity, then punch soft center
    ctx.globalAlpha = 0.022; // nearly invisible overall
    ctx.strokeStyle = "rgba(150, 175, 220, 1)";
    ctx.lineWidth = 1;

    const strokeChain = (points) => {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
    };

    const ra0 = Math.floor(cam.ra / step) * step - step * 3;
    for (let i = 0; i < 8; i++) {
      const ra = ra0 + i * step;
      const pts = [];
      for (let j = 0; j <= 8; j++) {
        const dec = cam.dec - step * 4 + j * step;
        if (dec < -90 || dec > 90) continue;
        const p = project(ra, dec);
        if (!p) continue;
        // Skip segments near view center (keep glass clear for ribbon)
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < fadeR) continue;
        pts.push(p);
      }
      strokeChain(pts);
    }
    const dec0 = Math.floor(cam.dec / step) * step - step * 3;
    for (let i = 0; i < 8; i++) {
      const dec = dec0 + i * step;
      if (dec < -90 || dec > 90) continue;
      const pts = [];
      for (let j = 0; j <= 8; j++) {
        const ra = cam.ra - step * 4 + j * step;
        const p = project(ra, dec);
        if (!p) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < fadeR) continue;
        pts.push(p);
      }
      strokeChain(pts);
    }

    // Extra soft veil: dim anything remaining near center
    ctx.globalAlpha = 1;
    const veil = ctx.createRadialGradient(cx, cy, fadeR * 0.5, cx, cy, fullR);
    // This doesn't erase strokes already drawn; we already skipped center points.
    ctx.restore();
  }

  /**
   * World-fixed anchors (RA/Dec). They do not stick to the camera — when you
   * pan/turn they slide across the glass so motion is obvious.
   */
  function landmarkIsHot(L) {
    if (!hotTarget) return null;
    const dRa = wrapDeltaRa(L.ra - hotTarget.ra);
    const cos = Math.cos((L.dec * Math.PI) / 180) || 1;
    const d = Math.hypot(dRa * cos, L.dec - hotTarget.dec);
    // Wider match so approach glow catches earlier at cruise FoV
    // Story / beacon (Altair porch etc.) share coords with labeled landmarks
    const matchR =
      hotTarget.kind === "story" || hotTarget.kind === "beacon" ? 3.2 : 2.4;
    if (d > matchR) return null;
    return hotTarget;
  }

  /** Sky ° from camera to a landmark (for local approach brighten) */
  function landmarkCamDist(L) {
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    return Math.hypot(wrapDeltaRa(L.ra - cam.ra) * cos, L.dec - cam.dec);
  }

  function drawLandmarks(t) {
    for (const L of landmarks) {
      const p = project(L.ra, L.dec);
      if (!p) continue;
      // Prior-chapter / off-route / stale: always ghost (never bold)
      const isGhost =
        !!L.ghost ||
        (!!L.chapter && L.chapter !== chapterId) ||
        (chapterId === "gumdrop-summer" && nearStaleGumdrop(L.ra, L.dec, 1.15));
      // Hard skip: never paint ghosts on Gumdrop (seed already filters; belt)
      if (
        isGhost &&
        (chapterId === "gumdrop-summer" || chapterId === "clear-cold-glass")
      ) {
        continue;
      }
      // Ghosts: never hot or approach-boosted
      const hot = isGhost ? null : landmarkIsHot(L);
      const dCam = landmarkCamDist(L);
      let localAp = 0;
      if (!isGhost && dCam < 14) {
        localAp = Math.pow(1 - dCam / 14, 0.85);
        if (dCam < 8) localAp = Math.max(localAp, Math.pow(1 - dCam / 8, 0.7));
      }
      const approachMix = isGhost
        ? 0
        : Math.max(ribbonApproach * 0.35, localAp);
      const hotBoost = isGhost
        ? 0.25
        : hot
          ? hot.level === "near"
            ? 1.85
            : 1.5
          : 1 + approachMix * 0.55;
      const pulse = isGhost
        ? 0.4
        : (0.75 + 0.35 * Math.sin(t * 1.35 * L.pulse + L.tw)) *
          (hot ? 1.3 : 1 + approachMix * 0.2);
      // Ghosts tiny + near-invisible. Wide FoV shrinks project scale — compensate
      // so Porch/Lantern/candy still read at Gumdrop ~34° cruise.
      const fovRead = Math.sqrt(Math.max(1, cam.fov / 22));
      const base =
        Math.max(
          isGhost ? 6 : 36,
          (isGhost ? 10 : 62) * L.size * (p.scale / 40) * fovRead
        ) * hotBoost;
      const hue = L.hue;
      // Chapter-aware alpha: ghosts ~4% (memory only)
      const vis = isGhost ? 0.04 : 1;

      ctx.save();
      ctx.globalAlpha = vis;

      // Shared outer pulse ring — nearly gone for ghosts
      const ringR = base * (isGhost ? 0.85 : 1.15 + 0.22 * pulse);
      const ringA = isGhost
        ? 0.12
        : hot
          ? hot.level === "near"
            ? 0.72 + 0.28 * pulse
            : 0.5 + 0.28 * pulse
          : 0.28 + 0.22 * pulse + approachMix * 0.35;
      ctx.strokeStyle = `hsla(${hue}, ${isGhost ? 35 : 72}%, ${isGhost ? 55 : 72}%, ${Math.min(0.95, ringA)})`;
      ctx.lineWidth =
        (isGhost ? 0.7 : 1.8 + pulse) *
        (hot ? 1.85 : 1.15 + approachMix * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      // Soft halo — ghosts: tiny cool wash only (no bright attractor)
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, ringR * 1.55);
      const haloA = isGhost
        ? 0.06 * pulse
        : hot
          ? 0.4 * pulse
          : (0.18 + approachMix * 0.28) * pulse;
      halo.addColorStop(0, `hsla(${hue}, ${isGhost ? 30 : 75}%, 65%, ${haloA})`);
      halo.addColorStop(0.55, `hsla(${hue}, 60%, 50%, ${haloA * 0.45})`);
      halo.addColorStop(1, `hsla(${hue}, 50%, 40%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR * (isGhost ? 1.1 : 1.5), 0, Math.PI * 2);
      ctx.fill();

      // Extra approach ring — active chapter only (never on ghosts)
      if (!isGhost && (hot || approachMix > 0.42)) {
        const beat = 0.55 + 0.45 * Math.sin(t * 3.2);
        const kind = hot?.kind || "story";
        ctx.strokeStyle =
          kind === "chapter"
            ? `hsla(200, 90%, 75%, ${0.35 + 0.4 * beat})`
            : kind === "story"
              ? `hsla(28, 88%, 68%, ${0.32 + 0.38 * beat + (hot ? 0 : approachMix * 0.15)})`
              : kind === "beacon"
                ? `hsla(35, 90%, 68%, ${0.34 + 0.38 * beat + (hot ? 0 : approachMix * 0.12)})`
                : `hsla(48, 90%, 70%, ${0.3 + 0.35 * beat})`;
        ctx.lineWidth = 2.5;
        const solidNear = hot ? hot.level === "near" : approachMix > 0.7;
        ctx.setLineDash(solidNear ? [] : [6, 5]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR * (1.35 + 0.08 * beat), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Ghosts of any kind → single soft pinprick (no mars racks / spirals / bold art)
      if (isGhost) {
        const r = base * 0.5;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.4);
        g.addColorStop(0, `hsla(${hue}, 35%, 72%, ${0.4 * pulse})`);
        g.addColorStop(0.5, `hsla(${hue}, 30%, 55%, ${0.12 * pulse})`);
        g.addColorStop(1, `hsla(${hue}, 25%, 40%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (L.kind === "nebula") {
        const r = base * 1.6;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hue}, 70%, 62%, ${0.28 * pulse})`);
        g.addColorStop(0.45, `hsla(${hue + 20}, 55%, 45%, ${0.16 * pulse})`);
        g.addColorStop(1, `hsla(${hue}, 50%, 30%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 1.15, r * 0.7, L.tw * 0.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (L.kind === "spiral") {
        const r = base * 1.1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(t * 0.08 + L.tw);
        for (let arm = 0; arm < 2; arm++) {
          ctx.strokeStyle = `hsla(${hue}, 60%, 70%, ${0.35 * pulse})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let a = 0; a < Math.PI * 1.6; a += 0.12) {
            const rr = (a / (Math.PI * 1.6)) * r;
            const x = Math.cos(a + arm * Math.PI) * rr;
            const y = Math.sin(a + arm * Math.PI) * rr * 0.55;
            if (a === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.fillStyle = `hsla(${hue}, 70%, 75%, ${0.5 * pulse})`;
        ctx.beginPath();
        ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (L.kind === "cluster") {
        const r = base * 0.85;
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + L.tw;
          const rr = r * (0.25 + (i % 3) * 0.18);
          const x = p.x + Math.cos(a) * rr;
          const y = p.y + Math.sin(a) * rr * 0.65;
          ctx.fillStyle = `hsla(${hue}, 55%, 85%, ${0.55 * pulse})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.4 + (i % 2), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `hsla(${hue}, 60%, 90%, ${0.7 * pulse})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (L.kind === "cloud") {
        const r = base * 1.8;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hue}, 35%, 70%, ${0.1 * pulse})`);
        g.addColorStop(1, `hsla(${hue}, 30%, 40%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 1.4, r * 0.5, 0.3, 0, Math.PI * 2);
        ctx.fill();
      } else if (L.kind === "mars") {
        // Red planet disk + glowing server array (James anchor)
        const R = base * 1.15;
        const planet = ctx.createRadialGradient(
          p.x - R * 0.2,
          p.y - R * 0.25,
          R * 0.1,
          p.x,
          p.y,
          R
        );
        planet.addColorStop(0, `hsla(18, 85%, 48%, ${0.55 * pulse})`);
        planet.addColorStop(0.45, `hsla(8, 80%, 32%, ${0.5 * pulse})`);
        planet.addColorStop(0.85, `hsla(5, 70%, 18%, ${0.35 * pulse})`);
        planet.addColorStop(1, `hsla(5, 60%, 10%, 0)`);
        ctx.fillStyle = planet;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
        ctx.fill();
        // Soft polar cap
        ctx.fillStyle = `hsla(200, 40%, 85%, ${0.12 * pulse})`;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - R * 0.55, R * 0.35, R * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
        // Server rack array on the surface — small glowing columns
        const racks = 5;
        for (let i = 0; i < racks; i++) {
          const u = (i / (racks - 1) - 0.5) * R * 0.7;
          const blink = 0.55 + 0.45 * Math.sin(t * 2.4 + i * 1.1 + L.tw);
          const rx = p.x + u;
          const ry = p.y + R * 0.12;
          const rh = (6 + (i % 3) * 3) * (base / 40) * (0.9 + blink * 0.15);
          const rw = Math.max(2.5, base * 0.06);
          // Cabinet body
          ctx.fillStyle = `hsla(220, 15%, 18%, ${0.75 * pulse})`;
          ctx.fillRect(rx - rw * 0.5, ry - rh, rw, rh);
          // Cyan / amber status LEDs
          ctx.fillStyle = `hsla(${i % 2 ? 45 : 175}, 90%, 65%, ${0.55 + 0.4 * blink})`;
          ctx.beginPath();
          ctx.arc(rx, ry - rh * 0.7, 1.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `hsla(160, 95%, 60%, ${0.35 + 0.5 * blink})`;
          ctx.fillRect(rx - rw * 0.3, ry - rh * 0.45, rw * 0.6, 1.5);
        }
        // Warm James heart-spark above the array
        const jx = p.x;
        const jy = p.y - R * 0.15;
        const jg = ctx.createRadialGradient(jx, jy, 0, jx, jy, R * 0.35);
        jg.addColorStop(0, `hsla(48, 95%, 70%, ${0.45 * pulse})`);
        jg.addColorStop(0.5, `hsla(25, 90%, 50%, ${0.2 * pulse})`);
        jg.addColorStop(1, `hsla(12, 80%, 40%, 0)`);
        ctx.fillStyle = jg;
        ctx.beginPath();
        ctx.arc(jx, jy, R * 0.35, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // beacon / glow — bright cross + halo (active chapter only)
        const r = base * 0.9;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hue}, 80%, 80%, ${0.55 * pulse})`);
        g.addColorStop(0.35, `hsla(${hue}, 70%, 60%, ${0.2 * pulse})`);
        g.addColorStop(1, `hsla(${hue}, 60%, 40%, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `hsla(${hue}, 80%, 85%, ${0.65 * pulse})`;
        ctx.lineWidth = 1.5;
        const arm = 6 + L.size * 4;
        ctx.beginPath();
        ctx.moveTo(p.x - arm, p.y);
        ctx.lineTo(p.x + arm, p.y);
        ctx.moveTo(p.x, p.y - arm);
        ctx.lineTo(p.x, p.y + arm);
        ctx.stroke();
      }

      // Labels: active chapter only (ghosts never label — stopped looking bold)
      const showLabel =
        L.label &&
        !isGhost &&
        p.x > 8 &&
        p.x < w - 8 &&
        p.y > 14 &&
        p.y < h - 8;
      if (showLabel) {
        const title = isGhost
          ? L.label // plain name, no emoji clutter for ghosts
          : L.role === "chapter"
            ? `✦ ${L.label}`
            : L.role === "drift"
              ? `✧ ${L.label}`
              : L.role === "house"
                ? L.kind === "mars"
                  ? `🔴 ${L.label}`
                  : `📌 ${L.label}`
                : L.label;
        let hint = null;
        if (!isGhost) {
          if (
            hot?.hint &&
            hot.hint.length < 28 &&
            !title.includes(hot.hint) &&
            hot.hint !== L.label
          ) {
            hint = hot.hint;
          } else if (
            L.catalog &&
            L.catalog !== L.label &&
            !title.includes(L.catalog)
          ) {
            hint = L.catalog;
          }
        }
        drawMarkerLabel(p.x + ringR * 0.55 + 8, p.y - 4, title, hint, {
          hot: !!hot && !isGhost,
          near: !isGhost && hot?.level === "near",
          ghost: isGhost,
        });
      }
      ctx.restore(); // end chapter vis alpha
    }
  }

  /**
   * Single label plate: soft background, optional second line, no shadow-on-shadow
   * double-fill that made text unreadable when overlays also painted.
   */
  function wrapLabelLines(text, maxChars = 28) {
    const s = String(text || "").trim();
    if (!s) return [];
    if (s.length <= maxChars) return [s];
    const words = s.split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > maxChars && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3); // max 3 lines on glass
  }

  function drawMarkerLabel(
    x,
    y,
    title,
    hint,
    { hot = false, near = false, ghost = false } = {}
  ) {
    const titleLines = wrapLabelLines(title, hot ? 30 : ghost ? 22 : 26);
    const hintLines = !ghost && hint ? wrapLabelLines(hint, 24) : [];
    if (!titleLines.length && !hintLines.length) return;

    const titleSize = ghost ? 10 : hot ? 13 : 12;
    const hintSize = 11;
    const lineH = titleSize + 3;
    const hintH = hintSize + 2;
    const padX = ghost ? 5 : 8;
    const padY = ghost ? 3 : 5;
    const gap = hintLines.length ? 4 : 0;

    ctx.save();
    if (ghost) ctx.globalAlpha *= 0.55; // extra fade on top of landmark vis
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${ghost ? "500" : "bold"} ${titleSize}px system-ui, sans-serif`;
    let maxW = 0;
    for (const ln of titleLines) maxW = Math.max(maxW, ctx.measureText(ln).width);
    if (hintLines.length) {
      ctx.font = `${hintSize}px system-ui, sans-serif`;
      for (const ln of hintLines) maxW = Math.max(maxW, ctx.measureText(ln).width);
    }
    const boxW = maxW + padX * 2;
    const boxH =
      padY * 2 +
      titleLines.length * lineH +
      gap +
      hintLines.length * hintH;

    // Keep plate on glass
    let bx = x;
    let by = y - boxH * 0.35;
    if (bx + boxW > w - 6) bx = w - 6 - boxW;
    if (bx < 6) bx = 6;
    if (by < 6) by = 6;
    if (by + boxH > h - 6) by = h - 6 - boxH;

    // Soft plate (one layer — not a second hard shadow text)
    ctx.fillStyle = ghost
      ? "rgba(6, 10, 18, 0.35)"
      : hot
        ? "rgba(8, 12, 22, 0.72)"
        : "rgba(6, 10, 18, 0.62)";
    ctx.strokeStyle = ghost
      ? "rgba(120, 140, 170, 0.15)"
      : hot
        ? near
          ? "rgba(255, 220, 150, 0.45)"
          : "rgba(180, 210, 255, 0.35)"
        : "rgba(140, 170, 210, 0.22)";
    ctx.lineWidth = 1;
    const rr = 6;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(bx, by, boxW, boxH, rr);
    } else {
      ctx.rect(bx, by, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    let ty = by + padY;
    ctx.font = `${ghost ? "500" : "bold"} ${titleSize}px system-ui, sans-serif`;
    ctx.fillStyle = ghost
      ? "rgba(180, 195, 220, 0.55)"
      : hot
        ? "rgba(255, 246, 220, 0.95)"
        : "rgba(236, 242, 255, 0.92)";
    for (const ln of titleLines) {
      ctx.fillText(ln, bx + padX, ty);
      ty += lineH;
    }
    if (hintLines.length) {
      ty += gap;
      ctx.font = `${hintSize}px system-ui, sans-serif`;
      ctx.fillStyle = near
        ? "rgba(255, 230, 160, 0.9)"
        : "rgba(190, 215, 245, 0.85)";
      for (const ln of hintLines) {
        ctx.fillText(ln, bx + padX, ty);
        ty += hintH;
      }
    }
    ctx.restore();
  }

  /** True if a labeled scenery landmark sits on this sky point */
  function landmarkLabelAt(ra, dec, maxDeg = 1.25) {
    for (const L of landmarks) {
      if (!L.label) continue;
      const cos = Math.cos((dec * Math.PI) / 180) || 1;
      const d = Math.hypot(wrapDeltaRa(L.ra - ra) * cos, L.dec - dec);
      if (d < maxDeg) return L;
    }
    return null;
  }

  /** Nearest labeled landmark for free-pin default naming + nav sensor */
  function nearestLandmark(ra, dec) {
    let best = null;
    let bestD = Infinity;
    for (const L of landmarks) {
      if (!L.label || L.ra == null || L.ghost) continue; // never default free-pin to ghosts
      const cos = Math.cos((dec * Math.PI) / 180) || 1;
      const d = Math.hypot(wrapDeltaRa(L.ra - ra) * cos, L.dec - dec);
      if (d < bestD) {
        bestD = d;
        best = { landmark: L, distDeg: d };
      }
    }
    return best;
  }

  /**
   * Sensor pool — active chapter only (never ghosts / prior-chapter Soft Rainy).
   */
  function listLandmarks() {
    return landmarks
      .filter(
        (L) =>
          !L.ghost && (!L.chapter || L.chapter === chapterId)
      )
      .map((L) => ({
        ra: L.ra,
        dec: L.dec,
        label: L.label,
        catalog: L.catalog || null,
        kind: L.kind,
        role: L.role || "beacon",
        chapter: L.chapter || chapterId,
        ghost: false,
      }));
  }

  function getChapterId() {
    return chapterId;
  }

  function setHotTarget(t) {
    if (!t || t.ra == null || t.dec == null) {
      hotTarget = null;
      return;
    }
    hotTarget = {
      ra: Number(t.ra),
      dec: Number(t.dec),
      level: t.level === "near" ? "near" : "notice",
      kind: t.kind || "glow",
      hint: t.hint || "",
    };
  }

  /** DOM plate above sky-veil — canvas text alone can be washed by soft-light veil */
  function glassWhisperEl() {
    return typeof document !== "undefined"
      ? document.getElementById("glass-whisper")
      : null;
  }

  let glassDomHideTimer = 0;

  function syncGlassWhisperDom(text, kind, lifeMs) {
    const el = glassWhisperEl();
    if (!el) {
      try {
        window.__ncGlassWhisperErr = "no #glass-whisper element";
      } catch {
        /* ignore */
      }
      return;
    }
    if (glassDomHideTimer) {
      clearTimeout(glassDomHideTimer);
      glassDomHideTimer = 0;
    }
    if (!text) {
      el.setAttribute("hidden", "");
      el.hidden = true;
      el.style.display = "none";
      el.classList.remove("is-show", "is-soft", "is-drift", "is-mystery");
      el.textContent = "";
      return;
    }
    // Force-visible above veil (do not rely on .hidden alone — some UAs stick)
    el.removeAttribute("hidden");
    el.hidden = false;
    el.style.display = "block";
    el.style.visibility = "visible";
    el.style.opacity = ""; // CSS animation owns opacity
    el.style.zIndex = "20";
    el.textContent = text;
    el.classList.remove("is-show", "is-soft", "is-drift", "is-mystery");
    // Restart CSS animation (reflow required)
    void el.offsetWidth;
    el.classList.add("is-show");
    if (kind === "soft") el.classList.add("is-soft");
    if (kind === "drift" || kind === "mystery") {
      /* gold plate is default */
    }
    const life = Number(lifeMs) > 0 ? Number(lifeMs) : 12000;
    glassDomHideTimer = setTimeout(() => {
      el.setAttribute("hidden", "");
      el.hidden = true;
      el.style.display = "none";
      el.classList.remove("is-show");
      glassDomHideTimer = 0;
    }, life);
  }

  /**
   * Soft line on the sky glass (DOM plate + canvas backup).
   * DOM sits above .sky-veil so hooks stay readable; canvas still draws too.
   * Defaults: ~12s total life. Soft lines will not clobber active drift/mystery.
   */
  function setGlassWhisper(text, opts = {}) {
    const s = text == null ? "" : String(text).trim();
    if (!s) {
      glassWhisper = null;
      syncGlassWhisperDom("", "soft", 0);
      return;
    }
    const holdMs = Number(opts.holdMs) > 0 ? Number(opts.holdMs) : 12000;
    const fadeInSec = Number(opts.fadeIn) > 0 ? Number(opts.fadeIn) : 0.5;
    const fadeOutSec = Number(opts.fadeOut) > 0 ? Number(opts.fadeOut) : 2.8;
    const kind = opts.kind || "soft";
    const force = !!opts.force;
    const now = performance.now();
    // DOM animation length must cover hold + fades (CSS default 15.5s)
    const lifeMs = Math.max(15500, holdMs + fadeInSec * 1000 + fadeOutSec * 1000);

    // Same line again without force → extend hold (no flicker)
    if (glassWhisper && glassWhisper.text === s && !force) {
      glassWhisper.holdMs = Math.max(glassWhisper.holdMs, holdMs);
      glassWhisper.fadeOutSec = Math.max(glassWhisper.fadeOutSec, fadeOutSec);
      glassWhisper.born = now - glassWhisper.fadeInSec * 1000;
      syncGlassWhisperDom(s, kind, Math.max(lifeMs, glassWhisper.holdMs + fadeOutSec * 1000));
      return;
    }

    // Keep a recent passage hook if a soft line tries to replace it
    if (
      !force &&
      glassWhisper &&
      (glassWhisper.kind === "drift" || glassWhisper.kind === "mystery") &&
      kind === "soft"
    ) {
      const age = (now - glassWhisper.born) / 1000;
      const protectUntil =
        glassWhisper.fadeInSec + (glassWhisper.holdMs / 1000) * 0.75;
      if (age < protectUntil) return;
    }

    glassWhisper = {
      text: s,
      born: now,
      holdMs,
      fadeInSec,
      fadeOutSec,
      kind,
    };
    // Primary visible path: HTML above veil (life matches hold + fades)
    syncGlassWhisperDom(s, kind, lifeMs);
    try {
      window.__ncGlassWhisper = {
        text: s,
        kind,
        holdMs,
        lifeMs,
        force,
        t: now,
      };
    } catch {
      /* ignore */
    }
  }

  function drawGlassWhisper(/* rAF ts ignored — use performance.now for born sync */) {
    if (!glassWhisper || !ctx || w < 8) return;
    const gw = glassWhisper;
    const age = (performance.now() - gw.born) / 1000;
    const hold = gw.holdMs / 1000;
    let alpha = 1;
    if (age < gw.fadeInSec) {
      // Ease-in (smoother than linear pop)
      const u = age / gw.fadeInSec;
      alpha = u * u * (3 - 2 * u);
    } else if (age > gw.fadeInSec + hold) {
      const u = (age - gw.fadeInSec - hold) / gw.fadeOutSec;
      // Slow ease-out so the last seconds stay readable longer
      alpha = 1 - u * u;
    }
    if (alpha <= 0.03) {
      glassWhisper = null;
      return;
    }
    alpha = Math.max(0, Math.min(1, alpha));

    const maxW = Math.min(w * 0.88, 520);
    const fontSize = Math.max(13, Math.min(16, w * 0.028));
    ctx.save();
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Wrap to glass width
    const words = gw.text.split(/\s+/);
    const lines = [];
    let cur = "";
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(next).width > maxW && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    const show = lines.slice(0, 4);
    if (!show.length) {
      ctx.restore();
      return;
    }

    const lineH = fontSize + 6;
    const padX = 16;
    const padY = 12;
    let textW = 0;
    for (const ln of show) textW = Math.max(textW, ctx.measureText(ln).width);
    const boxW = textW + padX * 2;
    const boxH = show.length * lineH + padY * 2;
    // Lower third of glass — above flight bar, clear of center reticle
    const bx = (w - boxW) * 0.5;
    const by = Math.min(h * 0.72, h - boxH - 56);

    ctx.globalAlpha = alpha * 0.88;
    ctx.fillStyle = "rgba(6, 10, 20, 0.72)";
    ctx.strokeStyle =
      gw.kind === "mystery" || gw.kind === "drift"
        ? "rgba(255, 220, 160, 0.4)"
        : "rgba(160, 200, 255, 0.32)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(bx, by, boxW, boxH, 10);
    } else {
      ctx.rect(bx, by, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    ctx.globalAlpha = alpha;
    ctx.fillStyle =
      gw.kind === "mystery" || gw.kind === "drift"
        ? "rgba(255, 242, 210, 0.96)"
        : "rgba(230, 240, 255, 0.96)";
    let ty = by + padY + lineH * 0.5;
    for (const ln of show) {
      ctx.fillText(ln, w * 0.5, ty);
      ty += lineH;
    }
    ctx.restore();
  }

  function drawNebulae() {
    for (const n of nebulae) {
      const p = project(n.ra, n.dec);
      if (!p) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, n.rx * (p.scale / 40));
      const hue =
        weatherMood === "warm"
          ? n.hue - 40
          : weatherMood === "rose"
            ? n.hue + 60
            : n.hue;
      g.addColorStop(0, `hsla(${hue}, 55%, 55%, ${n.a + skyWarmth * 0.05})`);
      g.addColorStop(1, `hsla(${hue}, 50%, 40%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(
        p.x,
        p.y,
        n.rx * (p.scale / 50),
        n.ry * (p.scale / 50),
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  function drawFieldStars(t) {
    const gliding = throttle > THR_MOVE_DEADZONE;
    const speedMag = Math.hypot(panVelX, panVelY);
    for (const s of fieldStars) {
      const p = project(s.ra, s.dec);
      if (!p) continue;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.4 + s.tw);
      const alpha = s.a * tw * (gliding ? 1 : 0.88);
      const col = s.warm ? "255, 230, 195" : "210, 225, 255";
      // Long streaks while moving — primary “we're flying” cue
      if (gliding && speedMag > 8 && s.z > 0.55) {
        const len = 6 + Math.min(48, speedMag * 0.04) * s.z + throttle * 18;
        const mag = speedMag || 1;
        const sx = panVelX / mag;
        const sy = panVelY / mag;
        ctx.strokeStyle = `rgba(${col}, ${alpha * 0.55})`;
        ctx.lineWidth = Math.max(0.7, s.r * 0.65);
        ctx.beginPath();
        ctx.moveTo(p.x - sx * len, p.y - sy * len);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col}, ${alpha})`;
      ctx.arc(p.x, p.y, s.r * (gliding ? 1.15 : 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawClouds(t) {
    if (cloudDensity < 0.2) return;
    const tint =
      weatherMood === "warm"
        ? "255, 210, 170"
        : weatherMood === "rose"
          ? "230, 180, 210"
          : weatherMood === "cold"
            ? "160, 200, 240"
            : "180, 200, 230";
    for (const c of clouds) {
      // Slow weather drift + cam project
      const ra = c.ra + t * c.drift * 8;
      const p = project(ra, c.dec);
      if (!p) continue;
      const rad = c.s * (p.scale / 55);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
      const a = c.a * (throttle > 0.1 ? 1.15 : 1);
      g.addColorStop(0, `rgba(${tint}, ${a})`);
      g.addColorStop(1, `rgba(${tint}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad * 1.5, rad * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawNearStars(dt, t) {
    // Match thr deadzone — never crawl dust when parked
    const gliding = throttle > THR_MOVE_DEADZONE;
    const speedMag = Math.hypot(panVelX, panVelY);
    for (const s of nearStars) {
      // Parallax only while actually translating (not yaw-only residual)
      if (gliding && speedMag > 2) {
        s.x += panVelX * dt * (0.5 + s.z);
        s.y += panVelY * dt * (0.5 + s.z);
      }
      if (s.x < -8) s.x = w + 8;
      if (s.x > w + 8) s.x = -8;
      if (s.y < -8) s.y = h + 8;
      if (s.y > h + 8) s.y = -8;

      const tw = 0.55 + 0.45 * Math.sin(t * 2 + s.tw);
      const alpha = s.a * tw * 0.7;
      const col = s.warm ? "255, 230, 190" : "200, 220, 255";
      if (gliding && speedMag > 6) {
        const len = 10 + Math.min(60, speedMag * 0.05) * s.z;
        const mag = speedMag || 1;
        ctx.strokeStyle = `rgba(${col}, ${alpha * 0.6})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x - (panVelX / mag) * len, s.y - (panVelY / mag) * len);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col}, ${alpha})`;
      ctx.arc(s.x, s.y, s.r * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!gliding) {
      panVelX *= 0.88;
      panVelY *= 0.88;
    }
  }

  function drawOverlays() {
    for (const o of overlays) {
      const p = project(o.ra, o.dec);
      if (!p) continue;
      const isGhost =
        !!o.ghost || (!!o.chapter && o.chapter !== chapterId);
      const isMyst =
        !isGhost &&
        (o.kind === "drift" || o.kind === "chapter" || o.kind === "claimed");
      const color = isGhost
        ? "#8a9bb0"
        : isMyst
          ? "#ffd78a"
          : o.done
            ? "#9ec9ff"
            : "#7eb6ff";
      const r = isGhost ? 4 : isMyst ? 9 : 7;

      // Glyph only when a scenery landmark already owns this sky point —
      // avoids “Porch light” + full house name + pin label stacked illegibly.
      const hasLandmarkLabel = !!landmarkLabelAt(o.ra, o.dec, 1.35);
      // Ghosts: skip if landmark already paints that sky slot
      if (isGhost && hasLandmarkLabel) continue;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = isGhost ? 0.8 : 1.5;
      ctx.globalAlpha = isGhost
        ? 0.18
        : o.done
          ? 0.55
          : hasLandmarkLabel
            ? 0.35
            : 0.95;
      if (isMyst) {
        // plus
        ctx.moveTo(p.x - r, p.y);
        ctx.lineTo(p.x + r, p.y);
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x, p.y + r);
        ctx.stroke();
      } else {
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (!isGhost) {
          ctx.beginPath();
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.25;
          ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // Ghost overlays: no label (landmarks may show dim name only when close)
      if (o.name && !hasLandmarkLabel && !isGhost) {
        drawMarkerLabel(p.x + r + 8, p.y - 2, o.name, null, {
          hot: isMyst,
          near: o.kind === "claimed",
          ghost: false,
        });
      }
    }
  }

  function drawVignette(t = 0) {
    const cx = w * 0.5;
    const cy = h * 0.5;
    // Depth vignette — open center so compass / craft stay bright;
    // edges soft so rim N·E·S·W still punch after this layer.
    const g = ctx.createRadialGradient(
      cx,
      cy * 0.95,
      Math.min(w, h) * 0.22,
      cx,
      cy,
      Math.max(w, h) * 0.78
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.5, "rgba(0,0,0,0.06)");
    g.addColorStop(0.78, "rgba(0,0,0,0.22)");
    g.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Soft cool edge glow (cockpit glass depth)
    const edgePulse = 0.9 + 0.1 * Math.sin(t * 0.7);
    const edge = ctx.createRadialGradient(
      cx,
      cy,
      Math.min(w, h) * 0.38,
      cx,
      cy,
      Math.max(w, h) * 0.68
    );
    edge.addColorStop(0, "rgba(120, 160, 220, 0)");
    edge.addColorStop(0.7, `rgba(80, 120, 180, ${0.04 * edgePulse})`);
    edge.addColorStop(1, `rgba(40, 70, 120, ${0.12 * edgePulse})`);
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, w, h);

    if (throttle > 0.15 && (phase === "FLIGHT" || phase === "MYSTERY")) {
      const a = 0.04 + throttle * 0.1;
      const vg = ctx.createLinearGradient(0, 0, w, 0);
      vg.addColorStop(0, `rgba(5,8,16,${a})`);
      vg.addColorStop(0.15, "rgba(5,8,16,0)");
      vg.addColorStop(0.85, "rgba(5,8,16,0)");
      vg.addColorStop(1, `rgba(5,8,16,${a})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ——— Camera / flight API ———

  function getView() {
    return { ra: cam.ra, dec: cam.dec, fov: cam.fov, heading };
  }

  function getHeading() {
    return heading;
  }

  /**
   * Steer input −1 (left) … +1 (right) from game-loop.
   * Merged with windshield's own A/D · ←/→ capture listeners.
   */
  function setSteer(v) {
    const n = Number(v);
    gameSteer = Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
    recomputeSteer();
  }

  function clearKeySteer() {
    keySteer.left = false;
    keySteer.right = false;
    recomputeSteer();
  }

  function getSteer() {
    recomputeSteer();
    return steerInput;
  }

  /**
   * Desired nav heading toward a sky position (0°=N … 270°=W). Does not move cam.
   */
  function bearingNavDesired(ra, dec) {
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
    let tDec = Number(dec);
    if (tDec > DEC_HARD_LIMIT) tDec = DEC_HARD_LIMIT - 0.2;
    if (tDec < -DEC_HARD_LIMIT) tDec = -DEC_HARD_LIMIT + 0.2;
    const cosRaw = Math.cos((cam.dec * Math.PI) / 180);
    const cos =
      Math.sign(cosRaw || 1) *
      Math.max(Math.abs(cosRaw) || POLE_COS_FLOOR, POLE_COS_FLOOR);
    let dRa = wrapDeltaRa(Number(ra) - cam.ra) * cos;
    let dDec = tDec - cam.dec;
    if (Math.hypot(dRa, dDec) < 0.55 && Math.abs(cam.dec) > DEC_SOFT_LIMIT - 1) {
      return cam.dec > 0 ? 180 : 0;
    }
    if (Math.hypot(dRa, dDec) < 1e-6) return heading;
    if (
      Math.abs(cam.dec) > DEC_SOFT_LIMIT &&
      Math.abs(tDec) > DEC_SOFT_LIMIT &&
      Math.abs(dDec) < 2.5
    ) {
      dDec -= Math.sign(cam.dec || 1) * 0.8;
    }
    return ((Math.atan2(dRa, dDec) * 180) / Math.PI + 360) % 360;
  }

  /**
   * faceToward — RADAR ONLY by default (no ship turn, no soft assist).
   * opts.hard === true snaps heading (menu/debug only). Flight never uses hard.
   * Soft-face permanently removed (v1.7.53+); never reintroduce.
   */
  function faceToward(ra, dec, opts = {}) {
    const desired = bearingNavDesired(ra, dec);
    if (desired == null || !Number.isFinite(desired)) return heading;
    if (opts.hard === true) {
      heading = desired;
      publishCam();
    }
    // soft / default: do not change heading — radar lock is visual guidance only
    try {
      window.__ncFace = {
        desired: Math.round(desired),
        applied: opts.hard === true,
        mode: opts.hard === true ? "hard-snap" : "radar-only",
        shipTurn: opts.hard === true ? "snap" : "none",
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
    return heading;
  }

  /** No-op retained for game-loop call sites (soft-face fully removed). */
  function clearSoftFace() {
    /* intentionally empty — no soft-face state */
  }

  function goto(view, { hard = false, face = true } = {}) {
    if (!view) return;
    cam.ra = Number(view.ra);
    // Never park past pole hard limit (legacy Pole hold was 89.26°)
    let gd = Number(view.dec);
    if (Number.isFinite(gd)) {
      if (gd > DEC_HARD_LIMIT) gd = DEC_HARD_LIMIT;
      if (gd < -DEC_HARD_LIMIT) gd = -DEC_HARD_LIMIT;
    }
    cam.dec = gd;
    // Never snap to pin micro-FoV (1.5–3.5°) — keep chapter cruise-wide view
    const cruise = cruiseFovForChapter(chapterId);
    if (view.fov != null) {
      const requested = Number(view.fov);
      cam.fov = Number.isFinite(requested)
        ? Math.max(
            CRUISE_FOV_MIN,
            Math.min(CRUISE_FOV_MAX, requested < 12 ? cruise : requested)
          )
        : cruise;
    } else {
      cam.fov = cruise;
    }
    if (view.heading != null && Number.isFinite(Number(view.heading))) {
      heading = ((Number(view.heading) % 360) + 360) % 360;
    }
    panVelX = 0;
    panVelY = 0;
    if (hard) {
      lastGlideSpeed = 0;
      setMotionBlur(0);
      // Do NOT zero throttle here — Begin sets session throttle then glides
      panVelX = 0;
      panVelY = 0;
    }
    publishCam();
  }

  function publishCam() {
    try {
      window.__ncCam = {
        ra: cam.ra,
        dec: cam.dec,
        fov: cam.fov,
        heading,
        steer: steerInput,
        ok: true,
        path: "canvas",
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
  }

  /**
   * Game-loop hook: set throttle / report cam. Does NOT advance cam
   * (paintLoop is the sole integrator — prevents double yaw spin).
   */
  function glideStep(target, thr = 0.35, dtSec = 1 / 60) {
    const t = Math.max(0, Math.min(1, Number(thr) || 0));
    const dt = Math.min(0.05, Math.max(0.001, Number(dtSec) || 1 / 60));
    throttle = t;
    recomputeSteer();

    const hasTarget =
      target &&
      Number.isFinite(Number(target.ra)) &&
      Number.isFinite(Number(target.dec));

    let dist = 0;
    let bearingTo = null;
    if (hasTarget) {
      const cosRaw = Math.cos((cam.dec * Math.PI) / 180);
      const cos =
        Math.sign(cosRaw || 1) *
        Math.max(Math.abs(cosRaw) || POLE_COS_FLOOR, POLE_COS_FLOOR);
      const dRaTo = wrapDeltaRa(Number(target.ra) - cam.ra) * cos;
      const dDecTo = Number(target.dec) - cam.dec;
      dist = Math.hypot(dRaTo, dDecTo);
      if (dist > 1e-6) {
        // Nav bearing: 0°=N, 90°=E (matches HDG)
        bearingTo = ((Math.atan2(dRaTo, dDecTo) * 180) / Math.PI + 360) % 360;
      }
    }

    // Hold chapter cruise FoV (Gumdrop ~34° for peripheral candy).
    // Pin JSON fov is often 1.5–3.5° for arrive framing — never use as travel FoV.
    const cruise = cruiseFovForChapter(chapterId);
    const fovMin = Math.max(CRUISE_FOV_MIN, cruise - 4);
    const fovMax = Math.min(CRUISE_FOV_MAX, cruise + 2);
    if (hasTarget && dist < 1.8) {
      // Very close only: slight tighten, still wide enough to keep ring readable
      const tFov = Math.max(fovMin, cruise * 0.9);
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.2 * dt);
    } else {
      // Free travel / far from pin: restore and hold chapter cruise
      if (
        cam.fov < fovMin ||
        cam.fov > fovMax ||
        Math.abs(cam.fov - cruise) > 0.5
      ) {
        const targetFov = Math.max(fovMin, Math.min(fovMax, cruise));
        cam.fov = cam.fov + (targetFov - cam.fov) * Math.min(1, 0.55 * dt);
      }
    }

    // Motion blur from throttle only — steer must not invent “gliding” feel
    const speed = t > THR_MOVE_DEADZONE ? Math.min(1, t) : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    if (speed <= 0) lastGlideSpeed = 0;
    setMotionBlur(lastGlideSpeed);
    if (t <= THR_MOVE_DEADZONE) {
      panVelX = 0;
      panVelY = 0;
    }
    publishCam();

    // headingErr is telemetry only — never applied to yaw (was suction feel)
    let headingErr = null;
    if (bearingTo != null) {
      headingErr = wrapDeltaRa(bearingTo - heading);
    }

    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const scale = Math.max(1, w) / Math.max(2, cam.fov);

    try {
      window.__ncGlide = {
        dRa: 0,
        dDec: 0,
        movedDeg: lastGlideSpeed,
        applied: true,
        dist,
        thr: t,
        heading,
        steer,
        bearingTo,
        headingErr,
        path: "canvas",
        dxPx: panVelX * dt,
        dyPx: panVelY * dt,
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }

    return {
      ra: cam.ra,
      dec: cam.dec,
      fov: cam.fov,
      distDeg: dist,
      speed: lastGlideSpeed,
      applied: true,
      movedDeg: Math.hypot(panVelX, panVelY) * dt * (1 / Math.max(scale, 1)),
      dRa: 0,
      dDec: 0,
      dxPx: panVelX * dt,
      dyPx: panVelY * dt,
      heading,
      steer,
      bearingTo,
      headingErr,
    };
  }

  function throttleKick(target, thr, dtSec = 1 / 24) {
    const t = Math.max(0, Math.min(1, Number(thr) || 0));
    if (t <= 0.02) {
      throttle = 0;
      panVelX = 0;
      panVelY = 0;
      setMotionBlur(0);
      publishCam();
      return getView();
    }
    throttle = Math.min(1, t + 0.1);
    recomputeSteer();
    publishCam();
    return glideStep(target, throttle, dtSec);
  }

  function applyCam() {
    publishCam();
    return true;
  }

  function forcePointTo(ra, dec) {
    if (Number.isFinite(ra)) cam.ra = Number(ra);
    if (Number.isFinite(dec)) cam.dec = Number(dec);
    publishCam();
    return true;
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.08);
  }

  function setPhase(p) {
    phase = p || "MENU";
    if (phase === "MYSTERY") skyWarmth = Math.min(1, skyWarmth + 0.12);
    // Soft reticle cursor while flying (NOT a second ship — craft is canvas-only)
    try {
      const stage = document.getElementById("sky-stage");
      if (stage) {
        const fly =
          phase === "FLIGHT" ||
          phase === "MYSTERY" ||
          phase === "ARRIVE" ||
          phase === "REST";
        stage.classList.toggle("craft-cursor", fly);
      }
    } catch {
      /* ignore */
    }
  }

  function applyChapterSky(night) {
    chapterNight = night || null;
    chapterId = night?.id || chapterId || "soft-rainy-hold";
    const sky = night?.sky || { mood: night?.weather_mood || "rain" };
    setWeather(sky);
    // Re-seed after weather (setWeather → seedUniverse) with chapter pack
    seedLandmarks(night);
    // Drop sensor/bank state so new chapter never inherits old lean
    sensorTarget = null;
    craftBankSm = 0;
    sensorBlipAngSm = 0;
    hotTarget = null;
    const stage = document.getElementById("sky-stage");
    if (stage) {
      stage.dataset.weather = sky.mood || night?.weather_mood || "rain";
      stage.dataset.chapter = chapterId;
    }
    // Pull camera back for exploration chapters (Gumdrop spread map)
    const cruise = cruiseFovForChapter(chapterId);
    cam.fov = cruise;
    const allow = getChapterSensorAllowlist(night);
    try {
      window.__ncChapter = {
        id: chapterId,
        landmarks: landmarks.length,
        allow: allow.map((a) => a.label).filter(Boolean),
        title: night?.title || chapterId,
        cruiseFov: cruise,
        fov: cam.fov,
        t: performance.now(),
      };
      window.__ncCam = {
        ...(window.__ncCam || {}),
        fov: cam.fov,
        cruiseFov: cruise,
        chapter: chapterId,
      };
    } catch {
      /* ignore */
    }
    publishCam();
  }

  function setWeather(sky) {
    if (!sky) return;
    if (typeof sky === "string") {
      weatherMood = sky;
      const presets = {
        rain: { hue: 210, warmth: 0.1, starDensity: 0.9, cloudDensity: 1.6 },
        warm: { hue: 28, warmth: 0.75, starDensity: 1.25, cloudDensity: 0.7 },
        cold: { hue: 200, warmth: 0.05, starDensity: 1.4, cloudDensity: 0.35 },
        rose: { hue: 320, warmth: 0.55, starDensity: 1.1, cloudDensity: 0.9 },
      };
      sky = { mood: weatherMood, ...(presets[sky] || presets.rain) };
    }
    weatherMood = sky.mood || weatherMood;
    if (sky.hue != null) skyHue = sky.hue;
    if (sky.warmth != null) skyWarmth = sky.warmth;
    if (sky.starDensity != null) starDensity = sky.starDensity;
    if (sky.cloudDensity != null) cloudDensity = sky.cloudDensity;
    seedUniverse();
  }

  function setOverlays(sources = [], personal = []) {
    overlays = [];
    for (const s of sources) {
      if (s.ra == null || s.dec == null) continue;
      // Catalog overlays are always current-night only (from game-loop)
      overlays.push({
        ra: s.ra,
        dec: s.dec,
        name: s.name || "",
        kind: s.kind || "story",
        done: !!s.done,
        ghost: false,
        chapter: chapterId,
      });
    }
    for (const p of personal) {
      const ra = p.view?.ra ?? p.ra;
      const dec = p.view?.dec ?? p.dec;
      if (ra == null || dec == null) continue;
      const pinNight = p.nightId || p.chapterId || null;
      // STRICT: only THIS chapter personal pins. Drop ch1 / orphan / stale entirely.
      if (!pinNight || pinNight !== chapterId) continue;
      if (
        chapterId === "gumdrop-summer" &&
        nearStaleGumdrop(ra, dec, 1.2)
      ) {
        continue;
      }
      // Skip if landmark already paints this sky (avoids double 📌)
      if (landmarkLabelAt(ra, dec, 1.5)) continue;
      overlays.push({
        ra,
        dec,
        name: `📌 ${p.label || "pin"}`,
        kind: "personal",
        done: false,
        ghost: false,
        chapter: chapterId,
      });
    }
  }

  /** FX facade — game-loop still calls windshield.fx.* */
  const fx = {
    setThrottle(t) {
      throttle = Math.max(0, Math.min(1, t));
    },
    setPhase(p) {
      setPhase(p);
    },
    setWeather(sky) {
      setWeather(sky);
    },
    setSkyFromView() {
      /* cam already drives paint */
    },
    setCamDelta(dx, dy, dt = 1 / 60) {
      if (dt > 0 && (dx || dy)) {
        panVelX = panVelX * 0.3 + (dx / dt) * 0.7;
        panVelY = panVelY * 0.3 + (dy / dt) * 0.7;
      }
    },
    panBy(dx, dy) {
      for (const s of nearStars) {
        s.x += dx || 0;
        s.y += dy || 0;
      }
    },
    resize() {
      resize();
    },
    start() {},
    stop() {},
  };

  return {
    boot,
    whenReady,
    getView,
    getHeading,
    setSteer,
    clearKeySteer,
    getSteer,
    faceToward,
    clearSoftFace,
    goto,
    glideStep,
    throttleKick,
    applyCam,
    forcePointTo,
    setOverlays,
    setHotTarget,
    setRibbonApproach,
    setSensorTarget,
    sensorPingPulse,
    setGlassWhisper,
    nearestLandmark,
    listLandmarks,
    getChapterId,
    isChapterSensorAllowed,
    getChapterSensorAllowlist,
    approachIntensityFromLandmarks,
    setPhase,
    setMotionBlur,
    applyChapterSky,
    get fx() {
      return fx;
    },
    get aladin() {
      return null;
    },
    get ready() {
      return ready;
    },
    get cam() {
      return { ...cam, heading };
    },
    get heading() {
      return heading;
    },
  };
}
