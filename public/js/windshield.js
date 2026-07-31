/**
 * Windshield — Aladin Lite as the cockpit glass.
 * Smooth glide easing, glowing pin catalogs, sky mood hooks for FX layer.
 */

import { createFxLayer } from "./fx-layer.js";

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 3.5,
  survey: "P/DSS2/color",
};

export function createWindshield(
  containerSelector = "#aladin-lite-div",
  { fxCanvasId = "fx-canvas" } = {}
) {
  let aladin = null;
  let ready = false;
  const waiters = [];
  let pinCatalog = null;
  let mysteryCatalog = null;
  let fx = null;

  // Smoothed camera state (lerp target for prettier motion)
  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
  let lastGlideSpeed = 0;

  function whenReady(fn) {
    if (ready && aladin) fn(aladin);
    else waiters.push(fn);
  }

  function boot() {
    if (typeof A === "undefined") {
      console.warn("Aladin not loaded yet");
      return null;
    }
    if (aladin) return aladin;

    const stage = document.getElementById("sky-stage");
    if (stage) stage.classList.add("glass-boot");

    aladin = A.aladin(containerSelector, {
      survey: BOOT.survey,
      fov: BOOT.fov,
      target: `${BOOT.ra} ${BOOT.dec}`,
      showReticle: false,
      showZoomControl: true,
      showFullscreenControl: true,
      showLayersControl: false,
      showGotoControl: false,
      showShareControl: false,
      showSimbadPointerControl: false,
      showCooGridControl: false,
      showFrame: false,
      fullScreen: false,
    });

    try {
      if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(BOOT.ra, BOOT.dec);
      }
      if (typeof aladin.setFov === "function") {
        aladin.setFov(BOOT.fov);
      }
    } catch (e) {
      console.warn("windshield boot nudge", e);
    }

    cam = { ...BOOT };

    // Glowing catalogs — larger soft markers
    try {
      if (typeof A.catalog === "function") {
        pinCatalog = A.catalog({
          name: "Story & house pins",
          sourceSize: 26,
          color: "#7eb6ff",
          displayLabel: true,
          labelColor: "#dce8ff",
          labelFont: "12px sans-serif",
          shape: "circle",
        });
        mysteryCatalog = A.catalog({
          name: "Mystery glows",
          sourceSize: 32,
          color: "#ffd78a",
          displayLabel: true,
          labelColor: "#ffe9b8",
          labelFont: "12px sans-serif",
          shape: "plus",
        });
        aladin.addCatalog(pinCatalog);
        aladin.addCatalog(mysteryCatalog);
      }
    } catch (e) {
      console.warn("catalog init", e);
    }

    // FX layer (stars / clouds / veil)
    const fxEl = document.getElementById(fxCanvasId);
    if (fxEl) {
      fx = createFxLayer(fxEl);
      fx.start();
    }

    // CSS glass polish
    const aladinDiv = document.querySelector(containerSelector);
    if (aladinDiv) aladinDiv.classList.add("aladin-glass");
    if (stage) {
      stage.classList.remove("glass-boot");
      stage.classList.add("glass-live");
    }

    ready = true;
    while (waiters.length) waiters.shift()(aladin);
    return aladin;
  }

  function getView() {
    if (!aladin) return { ...cam };
    let ra = cam.ra;
    let dec = cam.dec;
    let fov = cam.fov;
    try {
      if (typeof aladin.getRaDec === "function") {
        const rd = aladin.getRaDec();
        if (Array.isArray(rd)) {
          ra = rd[0];
          dec = rd[1];
        } else if (rd && typeof rd === "object") {
          ra = rd.ra ?? rd[0] ?? ra;
          dec = rd.dec ?? rd[1] ?? dec;
        }
      }
      if (typeof aladin.getFov === "function") {
        const f = aladin.getFov();
        fov = Array.isArray(f) ? f[0] : f || fov;
      }
    } catch {
      /* keep last */
    }
    cam = { ra: Number(ra), dec: Number(dec), fov: Number(fov) };
    return { ...cam };
  }

  function applyCam() {
    if (!aladin) return;
    try {
      if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(cam.ra, cam.dec);
      }
      if (typeof aladin.setFov === "function") {
        aladin.setFov(cam.fov);
      }
    } catch {
      /* soft */
    }
  }

  function goto(view, { hard = false } = {}) {
    if (!view) return;
    if (hard) {
      cam.ra = view.ra;
      cam.dec = view.dec;
      if (view.fov != null) cam.fov = view.fov;
      applyCam();
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      return;
    }
    // soft goto: single eased step used by callers over frames
    glideStep(view, 0.5);
  }

  /**
   * Smooth eased glide toward target (ease-out cubic blend).
   * @returns {{ ra, dec, fov, distDeg, speed }}
   */
  function glideStep(target, throttle = 0.35) {
    const cur = getView();
    if (!aladin || !target) {
      return { ...cur, distDeg: 0, speed: 0 };
    }

    const t = Math.max(0, Math.min(1, throttle));
    // Ease: higher responsiveness mid-throttle, softer near target
    const dRa = wrapDeltaRa(target.ra - cur.ra);
    const dDec = target.dec - cur.dec;
    const cos = Math.cos((cur.dec * Math.PI) / 180);
    const dist = Math.hypot(dRa * cos, dDec);

    // ease-out factor: approach slows near pin (prettier dock)
    const approach = dist < 2 ? 0.35 + dist * 0.2 : 1;
    const maxStep = (0.06 + t * 0.48) * approach;

    let nRa = cur.ra;
    let nDec = cur.dec;
    if (dist > 1e-5) {
      const step = Math.min(maxStep, dist * (0.12 + t * 0.22));
      const u = Math.min(1, step / dist);
      // smoothstep blend
      const s = u * u * (3 - 2 * u);
      nRa = cur.ra + dRa * s;
      nDec = cur.dec + dDec * s;
      nRa = ((nRa % 360) + 360) % 360;
      nDec = Math.max(-90, Math.min(90, nDec));
    }

    const tFov = target.fov ?? cur.fov;
    const nFov = cur.fov + (tFov - cur.fov) * (0.05 + t * 0.1);

    cam = { ra: nRa, dec: nDec, fov: nFov };
    applyCam();

    const speed = dist > 0.01 ? Math.min(1, maxStep / 0.5) * t : 0;
    lastGlideSpeed = speed * 0.7 + lastGlideSpeed * 0.3;
    setMotionBlur(lastGlideSpeed);
    fx?.setThrottle(t);
    fx?.setSkyFromView(cam);

    return { ra: nRa, dec: nDec, fov: nFov, distDeg: dist, speed: lastGlideSpeed };
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    const glass = document.querySelector(".aladin-glass");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.12);
    if (glass) {
      // subtle CSS blur + scale for motion feel (lightweight)
      const blur = (a * 0.55).toFixed(2);
      const scale = (1 + a * 0.012).toFixed(4);
      glass.style.filter = a > 0.08 ? `blur(${blur}px) brightness(1.05)` : "";
      glass.style.transform = a > 0.08 ? `scale(${scale})` : "";
    }
  }

  function setPhase(phase) {
    fx?.setPhase(phase);
    const stage = document.getElementById("sky-stage");
    if (stage) stage.dataset.phase = phase || "";
  }

  /** Apply chapter sky mood + optional Aladin survey */
  function applyChapterSky(night) {
    const sky = night?.sky || { mood: night?.weather_mood || "rain" };
    fx?.setWeather(sky);
    const stage = document.getElementById("sky-stage");
    if (stage) stage.dataset.weather = sky.mood || night?.weather_mood || "rain";
    if (aladin && sky.survey && typeof aladin.setBaseImageLayer === "function") {
      try {
        aladin.setBaseImageLayer(sky.survey);
      } catch {
        /* survey may not exist on all builds */
      }
    } else if (aladin && sky.survey && typeof aladin.setImageSurvey === "function") {
      try {
        aladin.setImageSurvey(sky.survey);
      } catch {
        /* ignore */
      }
    }
  }

  function wrapDeltaRa(d) {
    let x = d;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return x;
  }

  function makeSource(ra, dec, name) {
    if (typeof A.source === "function") return A.source(ra, dec, { name });
    if (typeof A.marker === "function") return A.marker(ra, dec, { popupTitle: name });
    return null;
  }

  function setOverlays(sources = [], personal = []) {
    if (!aladin || !pinCatalog) return;
    try {
      if (typeof pinCatalog.removeAll === "function") pinCatalog.removeAll();
      if (mysteryCatalog && typeof mysteryCatalog.removeAll === "function") {
        mysteryCatalog.removeAll();
      }

      const pinSrc = [];
      const mystSrc = [];

      for (const s of sources) {
        const label =
          s.kind === "story" || s.kind === undefined
            ? `✦ ${s.name || ""}`
            : s.name || "";
        const src = makeSource(s.ra, s.dec, label);
        if (!src) continue;
        if (s.kind === "drift" || s.kind === "chapter" || s.kind === "claimed") {
          mystSrc.push(src);
        } else {
          pinSrc.push(src);
        }
      }
      for (const p of personal) {
        if (p.view == null && p.ra == null) continue;
        const ra = p.view?.ra ?? p.ra;
        const dec = p.view?.dec ?? p.dec;
        const src = makeSource(ra, dec, `📌 ${p.label || "pin"}`);
        if (src) pinSrc.push(src);
      }

      if (typeof pinCatalog.addSources === "function") pinCatalog.addSources(pinSrc);
      else pinSrc.forEach((s) => pinCatalog.addSources([s]));

      if (mysteryCatalog) {
        if (typeof mysteryCatalog.addSources === "function") {
          mysteryCatalog.addSources(mystSrc);
        } else {
          mystSrc.forEach((s) => mysteryCatalog.addSources([s]));
        }
      }

      // pulse stage when pins refresh
      const stage = document.getElementById("sky-stage");
      if (stage) {
        stage.classList.remove("pins-pulse");
        void stage.offsetWidth;
        stage.classList.add("pins-pulse");
      }
    } catch (e) {
      console.warn("setOverlays", e);
    }
  }

  return {
    boot,
    whenReady,
    getView,
    goto,
    glideStep,
    setOverlays,
    setPhase,
    setMotionBlur,
    get fx() {
      return fx;
    },
    get aladin() {
      return aladin;
    },
    get ready() {
      return ready;
    },
  };
}
