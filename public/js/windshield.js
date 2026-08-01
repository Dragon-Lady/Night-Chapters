/**
 * Windshield — custom canvas night sky (no Aladin).
 *
 * Camera: RA / Dec / FoV + flight heading (bearing on the sky).
 * Every rAF: steer (A/D · ←/→) turns heading; throttle (W/S) moves along it.
 * You can turn around and fly back to passed pins.
 */

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 8.0,
  /** Bearing on sky: 0° = +RA (east), 90° = +Dec (north) */
  heading: 90,
};

const MAX_DEG_PER_SEC = 14;
const MIN_DEG_PER_SEC = 2.2;
/** Max yaw rate while holding A/D (°/s) */
const MAX_YAW_DEG_PER_SEC = 80;
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
  /** Continuous steer input −1..+1 (left/right held keys) */
  let steerInput = 0;
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
    // Keep projecting well outside glass so stars stream onto screen
    const margin = Math.max(w, h) * 0.85;
    if (x < -margin || x > w + margin || y < -margin || y > h + margin) {
      return null;
    }
    return { x, y, scale, dRa, dDec };
  }

  /**
   * Advance RA/Dec from throttle + heading (shared by glideStep and paint catch-up).
   * @returns {{ dRa:number, dDec:number, movedDeg:number, dxPx:number, dyPx:number }}
   */
  function advanceCam(dt) {
    const t = throttle;
    const steer = Math.max(-1, Math.min(1, steerInput || 0));
    if (Math.abs(steer) > 0.02) {
      heading = (heading + steer * MAX_YAW_DEG_PER_SEC * dt + 360) % 360;
    }

    const maxDegPerSec =
      t <= 0.02
        ? 0
        : MIN_DEG_PER_SEC + t * (MAX_DEG_PER_SEC - MIN_DEG_PER_SEC);
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
      nDec = Math.max(-89.5, Math.min(89.5, nDec));
      if (nDec !== cam.dec + dDec) {
        heading = (360 - heading + 360) % 360;
      }
      cam.ra = nRa;
      cam.dec = nDec;
    }

    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const scale = Math.max(1, w) / Math.max(2, cam.fov);
    const dxPx = -dRaMove * cosFx * scale;
    const dyPx = dDecMove * scale;
    // Dust layer scrolls with sky (features move opposite cam)
    dustOx = (dustOx + dxPx) % 256;
    dustOy = (dustOy + dyPx) % 256;
    if (dt > 0) {
      panVelX = panVelX * 0.2 + (dxPx / dt) * 0.8;
      panVelY = panVelY * 0.2 + (dyPx / dt) * 0.8;
    }
    const movedDeg = Math.hypot(dRaMove * cosFx, dDecMove);
    lastAdvanceAt = performance.now();
    return { dRa: dRaMove, dDec: dDecMove, movedDeg, dxPx, dyPx };
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
    // If game-loop didn't call glideStep recently, still advance cam so the
    // glass never freezes while throttle is up.
    const now = performance.now();
    const flying =
      throttle > 0.02 || Math.abs(steerInput) > 0.02;
    if (flying && now - lastAdvanceAt > 28) {
      advanceCam(dt);
      publishCam();
    }
    paint(dt, ts);
  }

  function paint(dt, ts) {
    const t = ts * 0.001;
    drawAtmosphere();
    drawDustLayer();
    drawMilkyBand();
    drawNebulae();
    drawFieldStars(t);
    drawClouds(t);
    drawNearStars(dt, t);
    drawCoordGrid();
    drawOverlays();
    drawVignette();
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

  /** Dense dust that scrolls in screen space — obvious pan cue */
  function drawDustLayer() {
    const cell = 48;
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (let yy = -cell; yy < h + cell; yy += cell) {
      for (let xx = -cell; xx < w + cell; xx += cell) {
        const px = xx + dustOx;
        const py = yy + dustOy;
        const fx = ((px % cell) + cell) % cell;
        const fy = ((py % cell) + cell) % cell;
        const x = xx + fx * 0.15;
        const y = yy + fy * 0.15;
        const n = hash01(Math.floor(px / cell), Math.floor(py / cell));
        if (n < 0.35) continue;
        const r = 0.4 + n * 1.2;
        ctx.fillStyle =
          n > 0.85
            ? `rgba(255, 230, 200, ${0.25 + n * 0.4})`
            : `rgba(200, 220, 255, ${0.2 + n * 0.35})`;
        ctx.beginPath();
        ctx.arc(x + n * cell * 0.5, y + (1 - n) * cell * 0.5, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawMilkyBand() {
    const fov = Math.max(2, cam.fov);
    const scale = w / fov;
    const bandDec = 20;
    const y0 = h * 0.5 - (bandDec - cam.dec) * scale * 0.55;
    const xShift = -wrapDeltaRa(cam.ra - 90) * scale * 0.08;
    const tilt = Math.sin((cam.ra * Math.PI) / 180) * 0.18;

    ctx.save();
    ctx.translate(w * 0.5 + xShift, y0);
    ctx.rotate(tilt);
    const band = ctx.createLinearGradient(0, -h * 0.18, 0, h * 0.18);
    const a = weatherMood === "cold" ? 0.18 : 0.14;
    band.addColorStop(0, "rgba(180,200,255,0)");
    band.addColorStop(0.5, `rgba(200, 210, 255, ${a})`);
    band.addColorStop(1, "rgba(180,200,255,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-w * 1.2, -h * 0.22, w * 2.4, h * 0.44);
    ctx.restore();
  }

  /** Faint RA/Dec grid — makes pan/turn obvious */
  function drawCoordGrid() {
    const fov = Math.max(2, cam.fov);
    const scale = w / fov;
    const step = fov > 12 ? 10 : fov > 6 ? 5 : 2;
    ctx.save();
    ctx.strokeStyle = "rgba(140, 170, 220, 0.12)";
    ctx.lineWidth = 1;
    // Vertical lines = constant RA
    const ra0 = Math.floor(cam.ra / step) * step - step * 4;
    for (let i = 0; i < 12; i++) {
      const ra = ra0 + i * step;
      const p = project(ra, cam.dec);
      if (!p) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, h);
      ctx.stroke();
    }
    // Horizontal lines = constant Dec
    const dec0 = Math.floor(cam.dec / step) * step - step * 4;
    for (let i = 0; i < 12; i++) {
      const dec = dec0 + i * step;
      if (dec < -90 || dec > 90) continue;
      const p = project(cam.ra, dec);
      if (!p) continue;
      ctx.beginPath();
      ctx.moveTo(0, p.y);
      ctx.lineTo(w, p.y);
      ctx.stroke();
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
    return { ra: cam.ra, dec: cam.dec, fov: cam.fov, heading };
  }

  function getHeading() {
    return heading;
  }

  /**
   * Steer input −1 (left) … +1 (right). Held keys update every frame via game-loop.
   */
  function setSteer(v) {
    const n = Number(v);
    steerInput = Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  }

  function getSteer() {
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
    if (view.fov != null) cam.fov = Math.max(4, Number(view.fov));
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
   * Each rAF from game-loop: set throttle, advance cam, return dist to target.
   * Paint loop also catch-up advances if this isn't called in time.
   */
  function glideStep(target, thr = 0.35, dtSec = 1 / 60) {
    const t = Math.max(0, Math.min(1, Number(thr) || 0));
    const dt = Math.min(0.1, Math.max(0.001, Number(dtSec) || 1 / 60));
    throttle = t;

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

    // Advance camera every glideStep (primary path)
    const moved = advanceCam(dt);

    // Soft FoV toward pin when near
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(5.5, Number(target.fov));
      if (dist < 8) {
        cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.45 * dt);
      }
    } else if (t > 0.04 && cam.fov < 8) {
      cam.fov = Math.min(10, cam.fov + 1.5 * dt);
    }

    const speed =
      t > 0.04 && moved.movedDeg > 0.0002
        ? Math.min(1, t)
        : t > 0.04
          ? t * 0.35
          : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);
    publishCam();

    const steer = Math.max(-1, Math.min(1, steerInput || 0));
    let headingErr = null;
    if (bearingTo != null) {
      headingErr = wrapDeltaRa(bearingTo - heading);
    }

    try {
      window.__ncGlide = {
        dRa: moved.dRa,
        dDec: moved.dDec,
        movedDeg: moved.movedDeg,
        applied: true,
        dist,
        thr: t,
        heading,
        steer,
        bearingTo,
        headingErr,
        path: "canvas",
        dxPx: moved.dxPx,
        dyPx: moved.dyPx,
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
      movedDeg: moved.movedDeg,
      dRa: moved.dRa,
      dDec: moved.dDec,
      dxPx: moved.dxPx,
      dyPx: moved.dyPx,
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
    return glideStep(target, Math.min(1, t + 0.15), Math.max(dtSec, 1 / 28));
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
