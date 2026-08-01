/**
 * Windshield — custom canvas night sky (no Aladin).
 *
 * Camera: RA / Dec / FoV + heading. Projection is heading-aligned:
 *   forward (heading) = up on glass, so A/D yaws the whole sky.
 * Throttle translates cam along heading; world anchors slide correctly.
 */

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  /** Wider default — easier to find ribbon + anchors while yawing */
  fov: 16,
  /** Bearing on sky: 0° = +RA (east), 90° = +Dec (north) */
  heading: 90,
};

/** Cruise FoV floor (zoom-out comfort) */
const CRUISE_FOV_MIN = 14;
const CRUISE_FOV_MAX = 22;

/** Low-end crawl so ~5% throttle feels gentle; high end still readable */
const MAX_DEG_PER_SEC = 11;
const MIN_DEG_PER_SEC = 0.35;
/** Curve exponent: higher = slower at low throttle (5% stays crawl) */
const THROTTLE_CURVE = 1.65;
/** Max yaw rate while holding A/D (°/s) — gentle turn, not spin */
const MAX_YAW_DEG_PER_SEC = 42;
/** Hard cap per frame so bad dt / double-ticks never runaway */
const MAX_YAW_DEG_PER_FRAME = 1.8;
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

    seedLandmarks();
    seedNearStars();
  }

  /**
   * Large world-fixed scenery anchors. Fixed in RA/Dec — when the camera
   * pans they slide on screen so turn/throttle read as real motion.
   */
  function seedLandmarks() {
    // Named “stations” around the story sky + a few mid-path beacons
    const fixed = [
      { ra: 83.82, dec: -5.39, kind: "nebula", label: "Orion lamp", hue: 28, size: 1.35 },
      { ra: 279.23, dec: 38.78, kind: "beacon", label: "Vega porch", hue: 200, size: 1.0 },
      { ra: 210.8, dec: 54.35, kind: "spiral", label: "Whirlpool", hue: 260, size: 1.15 },
      { ra: 41.97, dec: 21.39, kind: "glow", label: "Rain glow", hue: 210, size: 0.95 },
      { ra: 180.0, dec: 20.0, kind: "beacon", label: "Drift spark", hue: 50, size: 0.85 },
      { ra: 245.0, dec: 46.0, kind: "glow", label: "Quiet spark", hue: 320, size: 0.85 },
      { ra: 14.18, dec: 60.72, kind: "cluster", label: "Cass W", hue: 190, size: 1.05 },
      { ra: 37.95, dec: 89.26, kind: "beacon", label: "Pole hold", hue: 200, size: 0.9 },
      { ra: 56.75, dec: 24.12, kind: "cluster", label: "Seven Sisters", hue: 45, size: 1.1 },
      { ra: 297.7, dec: 8.87, kind: "beacon", label: "Altair porch", hue: 35, size: 0.95 },
      { ra: 310.36, dec: 45.28, kind: "nebula", label: "Deneb tail", hue: 300, size: 1.2 },
      { ra: 120.0, dec: -15.0, kind: "cloud", label: "Soft bank", hue: 215, size: 1.4 },
      { ra: 330.0, dec: 10.0, kind: "cloud", label: "Night veil", hue: 250, size: 1.3 },
      { ra: 90.0, dec: 40.0, kind: "spiral", label: "Far wheel", hue: 270, size: 1.0 },
      { ra: 200.0, dec: -30.0, kind: "nebula", label: "South bloom", hue: 15, size: 1.25 },
      { ra: 0.0, dec: 0.0, kind: "beacon", label: "Zero meridian", hue: 180, size: 0.8 },
    ];
    landmarks = fixed.map((f, i) => ({
      ...f,
      tw: hash01(i, 90) * Math.PI * 2,
      pulse: 0.85 + hash01(i, 91) * 0.3,
    }));
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
    const y = h * 0.5 - north * scale;
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
    // Apply same rotation as world layer: rot = heading - 90°
    const rot = ((heading - 90) * Math.PI) / 180;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const rdx = dx * c - dy * s;
    const rdy = dx * s + dy * c;
    // Yaw spin: features orbit opposite to nose turn
    const yawRad = (yawDeg * Math.PI) / 180;
    const spin = Math.min(w, h) * 0.4 * yawRad;
    return { dx: rdx + spin, dy: rdy };
  }

  /** Degrees to rotate world so heading points up (north-up → heading-up). */
  function worldRotationRad() {
    // north-up has north = up. We want heading = up → rotate by (heading - 90°)
    return ((heading - 90) * Math.PI) / 180;
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

  /** Merge game-loop + local key state → steerInput −1..1 */
  function recomputeSteer() {
    const fromKeys = (keySteer.right ? 1 : 0) - (keySteer.left ? 1 : 0);
    const fromGame = Math.max(-1, Math.min(1, gameSteer || 0));
    // Prefer any non-zero source (keys win on tie for responsiveness)
    if (fromKeys !== 0) steerInput = fromKeys;
    else steerInput = fromGame;
    try {
      window.__ncSteer = {
        steerInput,
        keySteer: { ...keySteer },
        gameSteer,
        heading,
        phase,
      };
    } catch {
      /* ignore */
    }
  }

  /**
   * Own capture listeners so A/D · ←/→ reach the glass.
   * Bind once on window only (not window+document — that double-fired).
   */
  function bindFlightKeys() {
    if (flightKeysBound || typeof window === "undefined") return;
    flightKeysBound = true;

    const onDown = (e) => {
      if (!isFlightPhase()) return;
      if (isTextTarget(e.target)) return;
      // Arrows while focus in instruments → let panel scroll (don't steer)
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
        // No discrete yaw kick — all turning is dt-limited in advanceCam
        e.preventDefault();
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

    // Single target only — document+window both capture = 2× events
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
  }

  /**
   * Single integration step: yaw (capped) then move along heading.
   * Called at most once per rAF via paintLoop (not also from glideStep).
   */
  function advanceCam(dtRaw) {
    recomputeSteer();
    // Clamp dt so tab-hitch / double-call never spins the sky
    const dt = Math.min(0.05, Math.max(0.001, Number(dtRaw) || 0.016));
    const t = throttle;
    const steer = Math.max(-1, Math.min(1, steerInput || 0));
    const prevHeading = heading;

    // —— Yaw: updates heading (view rotation via project()) ——
    let yawApplied = 0;
    if (Math.abs(steer) > 0.02) {
      let yaw = steer * MAX_YAW_DEG_PER_SEC * dt;
      if (yaw > MAX_YAW_DEG_PER_FRAME) yaw = MAX_YAW_DEG_PER_FRAME;
      if (yaw < -MAX_YAW_DEG_PER_FRAME) yaw = -MAX_YAW_DEG_PER_FRAME;
      yawApplied = yaw;
      heading = (heading + yaw + 360) % 360;
    }

    // —— Throttle: translate cam along heading (after yaw this frame) ——
    const tCurve = Math.pow(Math.max(0, Math.min(1, t)), THROTTLE_CURVE);
    const maxDegPerSec =
      t <= 0.02
        ? 0
        : MIN_DEG_PER_SEC + tCurve * (MAX_DEG_PER_SEC - MIN_DEG_PER_SEC);
    const stepDeg = maxDegPerSec * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;
    let dRa = 0;
    let dDec = 0;

    if (t > 0.02 && stepDeg > 0) {
      const rad = (heading * Math.PI) / 180;
      const cosDec = Math.cos((cam.dec * Math.PI) / 180) || 1;
      const moveEast = Math.cos(rad) * stepDeg;
      const moveNorth = Math.sin(rad) * stepDeg;
      dRa = cosDec !== 0 ? moveEast / cosDec : 0;
      dDec = moveNorth;
    }

    if (dRa !== 0 || dDec !== 0) {
      let nRa = cam.ra + dRa;
      let nDec = cam.dec + dDec;
      nRa = ((nRa % 360) + 360) % 360;
      if (nDec > 89.5) nDec = 89.5;
      else if (nDec < -89.5) nDec = -89.5;
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
    if (dt > 0) {
      panVelX = panVelX * 0.25 + (dxPx / dt) * 0.75;
      panVelY = panVelY * 0.25 + (dyPx / dt) * 0.75;
    }
    const movedDeg = Math.hypot(eastMove, northMove);
    lastAdvanceAt = performance.now();
    return {
      dRa: dRaMove,
      dDec: dDecMove,
      movedDeg,
      dxPx,
      dyPx,
      heading,
      prevHeading,
      yawApplied,
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
    // Sole integrator: yaw heading + throttle translate every paint frame
    recomputeSteer();
    if (isFlightPhase() && (throttle > 0.02 || Math.abs(steerInput) > 0.02)) {
      advanceCam(dt);
      publishCam();
    }
    paint(dt, ts);
  }

  function paint(dt, ts) {
    const t = ts * 0.001;
    // Static backdrop (doesn't need yaw — pure black depth)
    drawAtmosphere();

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
    drawCardinalRim();
    drawCompassRose(t);
    drawRibbonBearingCue();
    drawHeadingHud();
    drawVignette(t);
  }

  /**
   * Faint compass rose that turns with sky heading (screen-fixed center,
   * ticks rotate so N/E/S/W move as you yaw).
   */
  function drawCompassRose(t) {
    if (!isFlightPhase()) return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.16;
    // World rot maps sky north → screen; rose ticks use same rot
    const rot = worldRotationRad();
    const pulse = 0.85 + 0.15 * Math.sin(t * 1.4);

    ctx.save();
    ctx.translate(cx, cy);
    // Outer ring
    ctx.strokeStyle = `rgba(158, 201, 255, ${0.18 * pulse})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    // Rotating cardinal ticks (sky-fixed)
    const dirs = [
      { name: "N", ang: 0, gold: true },
      { name: "E", ang: Math.PI / 2, gold: false },
      { name: "S", ang: Math.PI, gold: false },
      { name: "W", ang: -Math.PI / 2, gold: false },
    ];
    for (const d of dirs) {
      // north-up angle: N = -π/2 in screen before world rot... 
      // unit in north-up: N=(0,-1), E=(1,0)
      const east = Math.sin(d.ang);
      const north = Math.cos(d.ang);
      let dx = east;
      let dy = -north;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const rdx = dx * cosR - dy * sinR;
      const rdy = dx * sinR + dy * cosR;
      const len = Math.hypot(rdx, rdy) || 1;
      const ux = rdx / len;
      const uy = rdy / len;
      ctx.strokeStyle = d.gold
        ? `rgba(255, 220, 160, ${0.55 * pulse})`
        : `rgba(170, 195, 230, ${0.28 * pulse})`;
      ctx.lineWidth = d.gold ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(ux * (R - 10), uy * (R - 10));
      ctx.lineTo(ux * R, uy * R);
      ctx.stroke();
      ctx.font = d.gold ? "bold 11px system-ui, sans-serif" : "10px system-ui, sans-serif";
      ctx.fillStyle = d.gold
        ? `rgba(255, 220, 160, ${0.7 * pulse})`
        : `rgba(180, 200, 230, ${0.4 * pulse})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(d.name, ux * (R + 12), uy * (R + 12));
    }
    // Faint heading line (nose always up = −Y)
    ctx.strokeStyle = `rgba(232, 213, 163, ${0.35 * pulse})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.15);
    ctx.lineTo(0, -R * 0.85);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
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

  /**
   * Nose always UP (world is rotated under us). Pip fixed; hdg number updates.
   */
  function drawHeadingHud() {
    if (!isFlightPhase()) return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const len = Math.min(w, h) * 0.09;

    ctx.save();
    ctx.strokeStyle = "rgba(158, 201, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, len + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(232, 213, 163, 0.95)";
    ctx.fillStyle = "rgba(232, 213, 163, 0.95)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 4);
    ctx.lineTo(cx, cy - len);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - len - 2);
    ctx.lineTo(cx - 6, cy - len + 9);
    ctx.lineTo(cx + 6, cy - len + 9);
    ctx.closePath();
    ctx.fill();
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(220, 232, 255, 0.85)";
    ctx.textAlign = "center";
    ctx.fillText(
      `hdg ${Math.round(heading)}° · FoV ${cam.fov.toFixed(0)}°`,
      cx,
      cy + len + 26
    );
    if (Math.abs(steerInput) > 0.02) {
      ctx.fillStyle = "rgba(255, 215, 138, 0.95)";
      ctx.fillText(
        steerInput > 0 ? "turning right →" : "← turning left",
        cx,
        cy + len + 42
      );
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
   * Pulsing glow + trail so it pops against the faded grid.
   */
  function drawMilkyBand(t = 0) {
    const samples = 40;
    const halfSpan = Math.max(55, cam.fov * 2.4);
    const breath = 0.85 + 0.15 * Math.sin(t * 0.9);
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
    const baseW = Math.max(32, Math.min(w, h) * 0.1);

    // Wide outer halo (trail)
    strokePts(core, baseW * 2.4, 0.05 * breath, "180, 200, 255");
    strokePts(core, baseW * 1.6, 0.09 * breath, "200, 215, 255");
    // Bright core
    strokePts(core, baseW * 0.95, 0.2 * breath, "220, 230, 255");
    strokePts(core, baseW * 0.35, 0.28 * breath, "235, 240, 255");
    // Parallel wisps
    strokePts(collect(17.5), baseW * 0.5, 0.1 * breath, "200, 210, 255");
    strokePts(collect(22.5), baseW * 0.45, 0.09 * breath, "200, 210, 255");

    // Soft sparkles along ribbon
    for (let i = 0; i < core.length; i += 3) {
      const p = core[i];
      const tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.7);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10 + tw * 8);
      g.addColorStop(0, `rgba(230, 240, 255, ${0.12 * tw * breath})`);
      g.addColorStop(1, "rgba(200, 220, 255, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12 + tw * 6, 0, Math.PI * 2);
      ctx.fill();
    }

    const mid = project(cam.ra, 20);
    if (mid && mid.x > 40 && mid.x < w - 40 && mid.y > 20 && mid.y < h - 20) {
      const lp = 0.7 + 0.3 * Math.sin(t * 1.5);
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(12, 16, 28, ${0.35 * lp})`;
      ctx.fillText("∽ ribbon", mid.x + 1, mid.y - baseW * 0.55 + 1);
      ctx.fillStyle = `rgba(210, 225, 255, ${0.55 * lp})`;
      ctx.fillText("∽ ribbon", mid.x, mid.y - baseW * 0.55);
    }
    ctx.restore();
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
   * Screen-edge N/E/S/W so yaw has absolute orientation
   * (world is rotated under a fixed nose-up pip).
   */
  function drawCardinalRim() {
    if (!isFlightPhase() && phase !== "MENU") return;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.42;
    // Map celestial directions into north-up screen, then same rot as world
    const dirs = [
      { name: "N", east: 0, north: 1 },
      { name: "E", east: 1, north: 0 },
      { name: "S", east: 0, north: -1 },
      { name: "W", east: -1, north: 0 },
    ];
    const rot = worldRotationRad();
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    ctx.save();
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const d of dirs) {
      // north-up unit → screen before rot: east→+x, north→−y
      let dx = d.east;
      let dy = -d.north;
      const rdx = dx * cosR - dy * sinR;
      const rdy = dx * sinR + dy * cosR;
      const len = Math.hypot(rdx, rdy) || 1;
      const x = cx + (rdx / len) * R;
      const y = cy + (rdy / len) * R;
      ctx.fillStyle =
        d.name === "N"
          ? "rgba(255, 220, 160, 0.75)"
          : "rgba(180, 200, 230, 0.5)";
      ctx.fillText(d.name, x, y);
      // small tick toward center
      ctx.strokeStyle = "rgba(180, 200, 230, 0.25)";
      ctx.beginPath();
      ctx.moveTo(cx + (rdx / len) * (R - 14), cy + (rdy / len) * (R - 14));
      ctx.lineTo(cx + (rdx / len) * (R - 4), cy + (rdy / len) * (R - 4));
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * World-fixed anchors (RA/Dec). They do not stick to the camera — when you
   * pan/turn they slide across the glass so motion is obvious.
   */
  function drawLandmarks(t) {
    for (const L of landmarks) {
      const p = project(L.ra, L.dec);
      if (!p) continue;
      const pulse =
        0.7 + 0.3 * Math.sin(t * 1.35 * L.pulse + L.tw);
      // Keep anchors readable even at wide cruise FoV
      const base = Math.max(34, 60 * L.size * (p.scale / 40));
      const hue = L.hue;

      // Shared outer pulse ring — easy to catch while yawing
      const ringR = base * (1.15 + 0.2 * pulse);
      ctx.strokeStyle = `hsla(${hue}, 70%, 70%, ${0.2 + 0.25 * pulse})`;
      ctx.lineWidth = 1.5 + pulse;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      // Soft halo under every kind
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, ringR * 1.5);
      halo.addColorStop(0, `hsla(${hue}, 75%, 65%, ${0.14 * pulse})`);
      halo.addColorStop(0.55, `hsla(${hue}, 60%, 50%, ${0.06 * pulse})`);
      halo.addColorStop(1, `hsla(${hue}, 50%, 40%, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringR * 1.5, 0, Math.PI * 2);
      ctx.fill();

      if (L.kind === "nebula") {
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
      } else {
        // beacon / glow — bright cross + halo
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

      // Stronger labels so anchors read while yawing
      if (L.label && p.x > 8 && p.x < w - 8 && p.y > 14 && p.y < h - 8) {
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = `rgba(8, 12, 20, ${0.35 * pulse})`;
        ctx.fillText(L.label, p.x + 11, p.y - 7);
        ctx.fillStyle = `rgba(240, 244, 255, ${0.7 + 0.25 * pulse})`;
        ctx.fillText(L.label, p.x + 10, p.y - 8);
      }
    }
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
    const gliding = throttle > 0.04;
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
    const gliding = throttle > 0.04;
    const speedMag = Math.hypot(panVelX, panVelY);
    for (const s of nearStars) {
      // Always apply pan velocity when flying (strong parallax)
      if (gliding || speedMag > 4) {
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
      const isMyst =
        o.kind === "drift" || o.kind === "chapter" || o.kind === "claimed";
      const color = isMyst ? "#ffd78a" : o.done ? "#9ec9ff" : "#7eb6ff";
      const r = isMyst ? 9 : 7;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = o.done ? 0.55 : 0.95;
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
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.25;
        ctx.arc(p.x, p.y, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (o.name) {
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillStyle = isMyst ? "#ffe9b8" : "#dce8ff";
        ctx.globalAlpha = 0.9;
        ctx.fillText(o.name, p.x + r + 6, p.y + 4);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawVignette(t = 0) {
    const cx = w * 0.5;
    const cy = h * 0.5;
    // Depth vignette — darker corners, open center for ribbon
    const g = ctx.createRadialGradient(
      cx,
      cy * 0.95,
      Math.min(w, h) * 0.18,
      cx,
      cy,
      Math.max(w, h) * 0.72
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.55, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0.55)");
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

  function getSteer() {
    recomputeSteer();
    return steerInput;
  }

  /**
   * Point flight heading toward a sky position (next pin / mystery).
   */
  function faceToward(ra, dec) {
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return heading;
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRa = wrapDeltaRa(Number(ra) - cam.ra) * cos;
    const dDec = Number(dec) - cam.dec;
    if (Math.hypot(dRa, dDec) < 1e-6) return heading;
    // atan2(dDec, dRa): 0 = +RA, 90 = +Dec
    heading = ((Math.atan2(dDec, dRa) * 180) / Math.PI + 360) % 360;
    publishCam();
    return heading;
  }

  function goto(view, { hard = false, face = true } = {}) {
    if (!view) return;
    cam.ra = Number(view.ra);
    cam.dec = Number(view.dec);
    if (view.fov != null) cam.fov = Math.max(CRUISE_FOV_MIN * 0.7, Number(view.fov));
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
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      const dRaTo = wrapDeltaRa(Number(target.ra) - cam.ra) * cos;
      const dDecTo = Number(target.dec) - cam.dec;
      dist = Math.hypot(dRaTo, dDecTo);
      if (dist > 1e-6) {
        bearingTo = ((Math.atan2(dDecTo, dRaTo) * 180) / Math.PI + 360) % 360;
      }
    }

    // Keep a comfortable zoom-out cruise FoV (ribbon + anchors readable)
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov)) && dist < 6) {
      const tFov = Math.max(CRUISE_FOV_MIN * 0.85, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.35 * dt);
    } else if (cam.fov < CRUISE_FOV_MIN) {
      cam.fov = cam.fov + (CRUISE_FOV_MIN - cam.fov) * Math.min(1, 0.8 * dt);
    } else if (cam.fov > CRUISE_FOV_MAX) {
      cam.fov = cam.fov + (CRUISE_FOV_MAX - cam.fov) * Math.min(1, 0.5 * dt);
    }

    const steer = Math.max(-1, Math.min(1, steerInput || 0));
    const speed =
      t > 0.04
        ? Math.min(1, t)
        : Math.abs(steer) > 0.02
          ? 0.15
          : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);
    publishCam();

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
  }

  function applyChapterSky(night) {
    const sky = night?.sky || { mood: night?.weather_mood || "rain" };
    setWeather(sky);
    const stage = document.getElementById("sky-stage");
    if (stage) {
      stage.dataset.weather = sky.mood || night?.weather_mood || "rain";
    }
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
      overlays.push({
        ra: s.ra,
        dec: s.dec,
        name: s.name || "",
        kind: s.kind || "story",
        done: !!s.done,
      });
    }
    for (const p of personal) {
      const ra = p.view?.ra ?? p.ra;
      const dec = p.view?.dec ?? p.dec;
      if (ra == null || dec == null) continue;
      overlays.push({
        ra,
        dec,
        name: `📌 ${p.label || "pin"}`,
        kind: "personal",
        done: false,
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
    getSteer,
    faceToward,
    goto,
    glideStep,
    throttleKick,
    applyCam,
    forcePointTo,
    setOverlays,
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
