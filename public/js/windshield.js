/**
 * Windshield — custom canvas night sky (no Aladin).
 *
 * Gentle procedural scenery: deep gradient, milky haze, starfield, weather
 * wisps, and pin markers. Camera is RA/Dec/FoV; throttle glide pans the sky
 * every frame so stars and scenery actually move with W/S.
 *
 * Public API matches the former Aladin windshield so game-loop is unchanged.
 */

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 8.0,
};

const MAX_DEG_PER_SEC = 10;
const MIN_DEG_PER_SEC = 1.4;
const FIELD_STAR_N = 420;
const NEAR_STAR_N = 90;
const NEBULA_N = 7;
const CLOUD_N = 10;

export function createWindshield(
  containerSelector = "#sky-canvas",
  { fxCanvasId = "fx-canvas" } = {}
) {
  let canvas = null;
  let ctx = null;
  let ready = false;
  const waiters = [];

  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
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
  let overlays = []; // { ra, dec, name, kind, done }

  let running = false;
  let rafId = 0;
  let lastPaint = 0;
  let panVelX = 0;
  let panVelY = 0;

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

    seedNearStars();
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
   * Project RA/Dec onto screen pixels relative to cam.
   * Returns null if far outside the glass (with soft margin).
   */
  function project(ra, dec) {
    const fov = Math.max(2, cam.fov);
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRa = wrapDeltaRa(ra - cam.ra) * cos;
    const dDec = dec - cam.dec;
    const scale = w / fov; // px per degree horizontal
    const x = w * 0.5 + dRa * scale;
    const y = h * 0.5 - dDec * scale;
    const margin = Math.max(w, h) * 0.35;
    if (x < -margin || x > w + margin || y < -margin || y > h + margin) {
      return null;
    }
    return { x, y, scale };
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
    paint(dt, ts);
  }

  function paint(dt, ts) {
    const t = ts * 0.001;
    // Background
    drawAtmosphere();
    drawMilkyBand();
    drawNebulae();
    drawFieldStars(t);
    drawClouds(t);
    drawNearStars(dt, t);
    drawOverlays();
    drawVignette();
  }

  function drawAtmosphere() {
    const g = ctx.createRadialGradient(
      w * 0.5,
      h * 0.42,
      0,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.72
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
    const core = `hsla(${topHue + skyWarmth * 20}, ${sat}%, ${10 + skyWarmth * 8}%, 1)`;
    const mid = `hsla(${skyHue}, ${sat}%, 7%, 1)`;
    const edge = "#03040a";
    g.addColorStop(0, core);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, edge);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Soft horizon glow
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

  function drawMilkyBand() {
    // Soft galactic ribbon that scrolls with RA
    const fov = Math.max(2, cam.fov);
    const scale = w / fov;
    const bandDec = 20; // band center
    const y0 = h * 0.5 - (bandDec - cam.dec) * scale * 0.35;
    const tilt = Math.sin((cam.ra * Math.PI) / 180) * 0.12;

    ctx.save();
    ctx.translate(w * 0.5, y0);
    ctx.rotate(tilt);
    const band = ctx.createLinearGradient(0, -h * 0.15, 0, h * 0.15);
    const a = weatherMood === "cold" ? 0.14 : 0.1;
    band.addColorStop(0, "rgba(180,200,255,0)");
    band.addColorStop(0.5, `rgba(200, 210, 255, ${a})`);
    band.addColorStop(1, "rgba(180,200,255,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-w, -h * 0.2, w * 2, h * 0.4);
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
    const gliding = throttle > 0.04 && (phase === "FLIGHT" || phase === "MYSTERY");
    for (const s of fieldStars) {
      const p = project(s.ra, s.dec);
      if (!p) continue;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.4 + s.tw);
      const alpha = s.a * tw * (gliding ? 0.95 + throttle * 0.2 : 0.85);
      const col = s.warm ? "255, 230, 195" : "210, 225, 255";
      // Streak when gliding (opposite to pan direction of sky)
      if (gliding && throttle > 0.25 && s.z > 0.9) {
        const len = 4 + throttle * 14 * s.z;
        const mag = Math.hypot(panVelX, panVelY) || 1;
        // Features move opposite to cam motion; streaks trail behind
        const sx = panVelX / mag;
        const sy = panVelY / mag;
        ctx.strokeStyle = `rgba(${col}, ${alpha * 0.4})`;
        ctx.lineWidth = Math.max(0.6, s.r * 0.5);
        ctx.beginPath();
        ctx.moveTo(p.x - sx * len, p.y - sy * len);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col}, ${alpha})`;
      ctx.arc(p.x, p.y, s.r * (gliding ? 1 + throttle * 0.15 : 1), 0, Math.PI * 2);
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
    // Parallax layer in screen space — scrolls with pan velocity
    const gliding = throttle > 0.04 && (phase === "FLIGHT" || phase === "MYSTERY");
    for (const s of nearStars) {
      if (gliding) {
        s.x += panVelX * dt * s.z * 0.85;
        s.y += panVelY * dt * s.z * 0.85;
      }
      if (s.x < -6) s.x = w + 6;
      if (s.x > w + 6) s.x = -6;
      if (s.y < -6) s.y = h + 6;
      if (s.y > h + 6) s.y = -6;

      const tw = 0.55 + 0.45 * Math.sin(t * 2 + s.tw);
      const alpha = s.a * tw * 0.55;
      const col = s.warm ? "255, 230, 190" : "200, 220, 255";
      if (gliding && throttle > 0.35) {
        const len = 6 + throttle * 20 * s.z;
        const mag = Math.hypot(panVelX, panVelY) || 1;
        ctx.strokeStyle = `rgba(${col}, ${alpha * 0.5})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(s.x - (panVelX / mag) * len, s.y - (panVelY / mag) * len);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col}, ${alpha})`;
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Decay pan velocity when not gliding
    if (!gliding) {
      panVelX *= 0.9;
      panVelY *= 0.9;
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

  function drawVignette() {
    const g = ctx.createRadialGradient(
      w * 0.5,
      h * 0.4,
      Math.min(w, h) * 0.2,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.7
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = g;
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
    return { ra: cam.ra, dec: cam.dec, fov: cam.fov };
  }

  function goto(view, { hard = false } = {}) {
    if (!view) return;
    cam.ra = Number(view.ra);
    cam.dec = Number(view.dec);
    if (view.fov != null) cam.fov = Math.max(4, Number(view.fov));
    panVelX = 0;
    panVelY = 0;
    if (hard) {
      lastGlideSpeed = 0;
      setMotionBlur(0);
      throttle = 0;
    }
    publishCam();
  }

  function publishCam() {
    try {
      window.__ncCam = {
        ra: cam.ra,
        dec: cam.dec,
        fov: cam.fov,
        ok: true,
        path: "canvas",
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
  }

  /**
   * Throttle-driven glide toward target. Updates cam; paint loop shows motion.
   */
  function glideStep(target, thr = 0.35, dtSec = 1 / 60) {
    const t = Math.max(0, Math.min(1, Number(thr) || 0));
    const dt = Math.min(0.1, Math.max(0.001, Number(dtSec) || 1 / 60));
    throttle = t;

    const hasTarget =
      target &&
      Number.isFinite(Number(target.ra)) &&
      Number.isFinite(Number(target.dec));

    const maxDegPerSec =
      t <= 0.02
        ? 0
        : MIN_DEG_PER_SEC + t * (MAX_DEG_PER_SEC - MIN_DEG_PER_SEC);

    let dist = 0;
    let dRaTo = 0;
    let dDecTo = 0;
    if (hasTarget) {
      dRaTo = wrapDeltaRa(Number(target.ra) - cam.ra);
      dDecTo = Number(target.dec) - cam.dec;
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      dist = Math.hypot(dRaTo * cos, dDecTo);
    }

    const approach = dist > 0 && dist < 2.5 ? Math.max(0.4, dist / 2.5) : 1;
    const stepDeg = maxDegPerSec * approach * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;
    let dRa = 0;
    let dDec = 0;

    if (t > 0.02 && stepDeg > 0) {
      if (hasTarget && dist > 1e-4) {
        const move = Math.min(stepDeg, dist);
        const u = move / dist;
        dRa = dRaTo * u;
        dDec = dDecTo * u;
      } else if (!hasTarget) {
        dRa = stepDeg * 0.35;
      }
    }

    if (dRa !== 0 || dDec !== 0) {
      let nRa = cam.ra + dRa;
      let nDec = cam.dec + dDec;
      nRa = ((nRa % 360) + 360) % 360;
      nDec = Math.max(-89.5, Math.min(89.5, nDec));
      cam.ra = nRa;
      cam.dec = nDec;
    }

    // Soft FoV toward target
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(5.5, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.45 * dt);
    } else if (t > 0.04 && cam.fov < 8) {
      cam.fov = Math.min(10, cam.fov + 1.5 * dt);
    }

    // Screen-space velocity for near-star parallax (same delta as scenery)
    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const scale = w / Math.max(2, cam.fov);
    // Cam moves +RA → sky features slide left
    const dxPx = -dRaMove * cosFx * scale;
    const dyPx = dDecMove * scale;
    if (dt > 0) {
      panVelX = panVelX * 0.25 + (dxPx / dt) * 0.75;
      panVelY = panVelY * 0.25 + (dyPx / dt) * 0.75;
    }

    const movedDeg = Math.hypot(dRaMove * cosFx, dDecMove);
    const speed =
      t > 0.04 && movedDeg > 0.0002
        ? Math.min(1, t)
        : t > 0.04
          ? t * 0.35
          : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);
    publishCam();

    try {
      window.__ncGlide = {
        dRa,
        dDec,
        movedDeg,
        applied: true,
        dist,
        thr: t,
        path: "canvas",
        dxPx,
        dyPx,
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
      movedDeg,
      dRa,
      dDec,
      dxPx,
      dyPx,
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
    return glideStep(target, Math.min(1, t + 0.2), Math.max(dtSec, 1 / 28));
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
      return { ...cam };
    },
  };
}
