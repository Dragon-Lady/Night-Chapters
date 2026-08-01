/**
 * Lightweight flight FX — starfield + soft cloud wisps on a canvas over the glass.
 * Star drift is driven by the SAME cam delta as Aladin (setCamDelta), so streaks
 * match throttle / glide. Vanilla JS only.
 */

const STAR_N = 72;
const CLOUD_N = 8;

export function createFxLayer(canvas) {
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { alpha: true });
  let w = 0;
  let h = 0;
  let stars = [];
  let clouds = [];
  let throttle = 0;
  let phase = "MENU";
  let running = true;
  let raf = 0;
  let last = 0;
  let skyHue = 220;
  let skyWarmth = 0;
  let starDensity = 1;
  let cloudDensity = 1;
  let weatherMood = "rain";

  /** Cam-linked velocity (px/sec) — smoothed from setCamDelta */
  let velX = 0;
  let velY = 0;
  /** Last frame cam delta (px) for streak direction */
  let lastDx = 0;
  let lastDy = 0;

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.floor(r.width));
    h = Math.max(1, Math.floor(r.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!stars.length) seed();
  }

  function seed() {
    const n = Math.round(STAR_N * starDensity);
    stars = [];
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * Math.max(1, w),
        y: Math.random() * Math.max(1, h),
        z: 0.25 + Math.random() * 1.4,
        r: 0.5 + Math.random() * 1.8,
        a: 0.3 + Math.random() * 0.7,
        tw: Math.random() * Math.PI * 2,
        warm: Math.random() > 0.8,
      });
    }
    clouds = [];
    const cn = Math.max(2, Math.round(CLOUD_N * cloudDensity));
    for (let i = 0; i < cn; i++) {
      clouds.push({
        x: Math.random() * Math.max(1, w),
        y: h * (0.15 + Math.random() * 0.7),
        s: 40 + Math.random() * 90,
        a: 0.03 + Math.random() * 0.06,
        v: 0.08 + Math.random() * 0.2,
      });
    }
  }

  function setThrottle(t) {
    throttle = Math.max(0, Math.min(1, t));
  }

  function setPhase(p) {
    phase = p || "MENU";
    if (phase === "MYSTERY") skyWarmth = Math.min(1, skyWarmth + 0.15);
    else skyWarmth = Math.max(0, skyWarmth - 0.02);
  }

  /**
   * Apply one frame of Aladin cam motion (pixels).
   * Same delta used for sky pointTo — stars streak with throttle.
   * @param {number} dxPx
   * @param {number} dyPx
   * @param {number} dtSec
   * @param {number} [thr]
   */
  function setCamDelta(dxPx, dyPx, dtSec = 1 / 60, thr = throttle) {
    const dx = Number(dxPx) || 0;
    const dy = Number(dyPx) || 0;
    const dt = Math.max(0.001, Number(dtSec) || 1 / 60);
    lastDx = dx;
    lastDy = dy;
    // Smooth velocity (px/sec)
    const vx = dx / dt;
    const vy = dy / dt;
    velX = velX * 0.35 + vx * 0.65;
    velY = velY * 0.35 + vy * 0.65;
    if (thr != null) throttle = Math.max(0, Math.min(1, thr));

    // Immediate pan so motion is frame-synced with Aladin
    if (!stars.length && w > 1) seed();
    applyPan(dx, dy);
  }

  function panBy(dx, dy) {
    applyPan(Number(dx) || 0, Number(dy) || 0);
  }

  function applyPan(dx, dy) {
    if (!stars.length) return;
    for (const s of stars) {
      const k = 0.4 + s.z * 0.75;
      s.x += dx * k;
      s.y += dy * k;
      wrapStar(s);
    }
    for (const c of clouds) {
      c.x += dx * 0.28;
      c.y += dy * 0.16;
      if (c.x < -c.s * 2) c.x = w + c.s;
      if (c.x > w + c.s * 2) c.x = -c.s;
    }
  }

  function wrapStar(s) {
    if (s.x < -6) s.x = w + 6;
    if (s.x > w + 6) s.x = -6;
    if (s.y < -6) s.y = h + 6;
    if (s.y > h + 6) s.y = -6;
  }

  function setSkyFromView(view) {
    if (!view) return;
    const base = skyHue;
    skyHue = base * 0.7 + (200 + ((view.ra || 0) % 360) * (40 / 360)) * 0.3;
    if (view.dec < 0) skyHue += 4;
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
      sky = presets[sky] || presets.rain;
    }
    weatherMood = sky.mood || weatherMood;
    if (sky.hue != null) skyHue = sky.hue;
    if (sky.warmth != null) skyWarmth = sky.warmth;
    starDensity = sky.starDensity ?? 1;
    cloudDensity = sky.cloudDensity ?? 1;
    if (w > 0) seed();
    const stage = document.getElementById("sky-stage");
    if (stage) stage.dataset.weather = weatherMood;
  }

  function tick(ts) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    if (w < 2 || h < 2) {
      resize();
      if (w < 2) return;
    }
    if (!stars.length) seed();

    const flying =
      throttle > 0.04 &&
      (phase === "FLIGHT" || phase === "MYSTERY" || phase === "ARRIVE");
    const speedMag = Math.hypot(velX, velY);
    // Glide if cam is moving OR throttle is up while flying
    const glide = flying && (throttle > 0.04 || speedMag > 8);

    // Decay velocity when no new cam deltas arrive
    velX *= 0.92;
    velY *= 0.92;
    if (Math.abs(velX) < 0.5) velX = 0;
    if (Math.abs(velY) < 0.5) velY = 0;

    ctx.clearRect(0, 0, w, h);

    // soft sky veil
    const g = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.5, h * 0.75);
    const sat = weatherMood === "cold" ? 55 : weatherMood === "warm" ? 50 : 45;
    const cool = `hsla(${skyHue}, ${sat}%, 12%, 0.18)`;
    const warmHue =
      weatherMood === "rose" ? 330 : weatherMood === "warm" ? 30 : 35 + skyHue * 0.05;
    const warm = `hsla(${warmHue}, 55%, 18%, ${0.1 + skyWarmth * 0.18})`;
    g.addColorStop(0, warm);
    g.addColorStop(0.55, cool);
    g.addColorStop(1, "rgba(0,0,0,0.28)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const cloudTint =
      weatherMood === "warm"
        ? "255, 210, 170"
        : weatherMood === "rose"
          ? "230, 180, 210"
          : weatherMood === "cold"
            ? "160, 200, 240"
            : "180, 200, 230";

    // Residual cam-velocity drift for clouds (setCamDelta already applied frame pan)
    const residual = glide ? 0.12 : 0;
    for (const c of clouds) {
      c.x += velX * dt * residual * 0.4;
      c.y += velY * dt * residual * 0.25;
      if (c.x < -c.s * 2) c.x = w + c.s;
      if (c.x > w + c.s * 2) c.x = -c.s;
      const grd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.s);
      grd.addColorStop(0, `rgba(${cloudTint}, ${c.a * (glide ? 1.35 : 1)})`);
      grd.addColorStop(1, `rgba(${cloudTint}, 0)`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.s * 1.6, c.s * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Unit direction of motion for streaks (prefer last frame delta)
    let streakDx = lastDx;
    let streakDy = lastDy;
    if (Math.hypot(streakDx, streakDy) < 0.2 && speedMag > 1) {
      streakDx = velX * dt;
      streakDy = velY * dt;
    }
    // If still almost zero but throttle high, invent leftward cruise streak
    if (glide && Math.hypot(streakDx, streakDy) < 0.15 && throttle > 0.2) {
      streakDx = -(8 + throttle * 40) * dt;
      streakDy = 0;
      // Keep stars crawling when cam delta is tiny but throttle is up
      for (const s of stars) {
        s.x += streakDx * (0.5 + s.z);
        wrapStar(s);
      }
    }

    const streakLen = glide
      ? Math.min(90, 12 + throttle * 50 + Math.hypot(streakDx, streakDy) * 1.8)
      : 0;

    for (const s of stars) {
      s.tw += dt * (1.2 + s.z);

      // Residual velocity crawl (cam delta already applied in setCamDelta)
      if (glide && residual > 0) {
        s.x += velX * dt * residual * s.z;
        s.y += velY * dt * residual * s.z * 0.6;
        wrapStar(s);
      }

      const twinkle = 0.55 + 0.45 * Math.sin(s.tw);
      const alpha = s.a * twinkle * (glide ? 0.95 + throttle * 0.4 : 0.75);
      const col = s.warm
        ? `255, 230, 190`
        : `210, 225, 255`;

      // Streaks along cam motion (opposite to pan so they trail behind)
      if (glide && streakLen > 4 && s.z > 0.45) {
        const len = streakLen * (0.35 + s.z * 0.65);
        const mag = Math.hypot(streakDx, streakDy) || 1;
        // Trail behind motion direction
        const tx = -(streakDx / mag) * len;
        const ty = -(streakDy / mag) * len;
        ctx.strokeStyle = `rgba(${col}, ${alpha * 0.55})`;
        ctx.lineWidth = Math.max(0.7, s.r * (0.6 + throttle * 0.5));
        ctx.beginPath();
        ctx.moveTo(s.x + tx, s.y + ty);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = `rgba(${col}, ${alpha})`;
      ctx.arc(s.x, s.y, s.r * (glide ? 1 + throttle * 0.35 : 1), 0, Math.PI * 2);
      ctx.fill();
    }

    // motion-blur side vignette
    if (glide && throttle > 0.15) {
      const blurA = 0.05 + throttle * 0.12;
      const vg = ctx.createLinearGradient(0, 0, w, 0);
      vg.addColorStop(0, `rgba(5, 8, 16, ${blurA})`);
      vg.addColorStop(0.12, "rgba(5, 8, 16, 0)");
      vg.addColorStop(0.88, "rgba(5, 8, 16, 0)");
      vg.addColorStop(1, `rgba(5, 8, 16, ${blurA})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function start() {
    running = true;
    resize();
    window.addEventListener("resize", resize);
    cancelAnimationFrame(raf);
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  }

  return {
    start,
    stop,
    resize,
    setThrottle,
    setPhase,
    setSkyFromView,
    setWeather,
    panBy,
    setCamDelta,
  };
}
