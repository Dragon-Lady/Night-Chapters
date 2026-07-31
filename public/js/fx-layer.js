/**
 * Lightweight flight FX — starfield + soft cloud wisps on a canvas over the glass.
 * Vanilla JS only. Driven by throttle / phase for wonder, not spectacle overload.
 */

const STAR_N = 48;
const CLOUD_N = 7;

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
  let skyHue = 220; // blue-night default
  let skyWarmth = 0; // 0 cool → 1 gold (mystery)
  let starDensity = 1;
  let cloudDensity = 1;
  let weatherMood = "rain";

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
    stars = [];
    for (let i = 0; i < STAR_N; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.3 + Math.random() * 1.2,
        r: 0.4 + Math.random() * 1.6,
        a: 0.25 + Math.random() * 0.75,
        tw: Math.random() * Math.PI * 2,
        warm: Math.random() > 0.82,
      });
    }
    clouds = [];
    for (let i = 0; i < CLOUD_N; i++) {
      clouds.push({
        x: Math.random() * w,
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

  /** Shift ambient hue from view (ra/dec) — subtle, not disco */
  function setSkyFromView(view) {
    if (!view) return;
    // map RA → hue drift, dec → cool/warm lean
    skyHue = 200 + ((view.ra || 0) % 360) * (40 / 360);
    if (view.dec < 0) skyHue += 8;
  }

  function tick(ts) {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    if (w < 2 || h < 2) return;

    const glide = throttle > 0.04 && (phase === "FLIGHT" || phase === "MYSTERY");
    const speed = glide ? 20 + throttle * 90 : 4;

    // clear
    ctx.clearRect(0, 0, w, h);

    // soft sky veil (color shift)
    const g = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.5, h * 0.75);
    const cool = `hsla(${skyHue}, 45%, 12%, 0.22)`;
    const warm = `hsla(${35 + skyHue * 0.05}, 55%, 18%, ${0.12 + skyWarmth * 0.18})`;
    g.addColorStop(0, warm);
    g.addColorStop(0.55, cool);
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // clouds (behind brighter stars feel)
    for (const c of clouds) {
      if (glide) c.x -= c.v * speed * dt * 8;
      if (c.x < -c.s * 2) c.x = w + c.s;
      const grd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.s);
      grd.addColorStop(0, `rgba(180, 200, 230, ${c.a * (glide ? 1.3 : 1)})`);
      grd.addColorStop(1, "rgba(180, 200, 230, 0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.s * 1.6, c.s * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // stars
    for (const s of stars) {
      s.tw += dt * (1.2 + s.z);
      if (glide) {
        s.x -= speed * s.z * dt * 12;
        s.y += Math.sin(s.tw * 0.3) * throttle * 4 * dt;
      }
      if (s.x < -4) {
        s.x = w + 4;
        s.y = Math.random() * h;
      }
      const twinkle = 0.55 + 0.45 * Math.sin(s.tw);
      const alpha = s.a * twinkle * (glide ? 0.9 + throttle * 0.35 : 0.75);
      ctx.beginPath();
      ctx.fillStyle = s.warm
        ? `rgba(255, 230, 190, ${alpha})`
        : `rgba(210, 225, 255, ${alpha})`;
      ctx.arc(s.x, s.y, s.r * (glide ? 1 + throttle * 0.25 : 1), 0, Math.PI * 2);
      ctx.fill();
      // tiny streak when gliding faster
      if (glide && throttle > 0.45 && s.z > 0.9) {
        ctx.strokeStyle = s.warm
          ? `rgba(255, 230, 190, ${alpha * 0.35})`
          : `rgba(200, 220, 255, ${alpha * 0.3})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + throttle * 10 * s.z, s.y);
        ctx.stroke();
      }
    }

    // motion-blur vignette edges (subtle)
    if (glide && throttle > 0.2) {
      const blurA = 0.04 + throttle * 0.1;
      const vg = ctx.createLinearGradient(0, 0, w, 0);
      vg.addColorStop(0, `rgba(5, 8, 16, ${blurA})`);
      vg.addColorStop(0.15, "rgba(5, 8, 16, 0)");
      vg.addColorStop(0.85, "rgba(5, 8, 16, 0)");
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
  };
}
