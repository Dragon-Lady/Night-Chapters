/**
 * Windshield — Aladin Lite as the cockpit glass.
 * Throttle → glideStep → wasm.setCenter every frame so the sky actually moves.
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

  // Internal camera — source of truth for continuous glide
  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
  let lastGlideSpeed = 0;
  let lastApplyAt = 0;

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

    // Expose for console diagnosis
    try {
      window.__aladin = aladin;
      window.__ncCam = () => ({ ...cam });
    } catch {
      /* ignore */
    }

    cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
    applyCam(true);

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

    const fxEl = document.getElementById(fxCanvasId);
    if (fxEl) {
      fx = createFxLayer(fxEl);
      fx.start();
    }

    const aladinDiv = document.querySelector(containerSelector);
    if (aladinDiv) {
      aladinDiv.classList.add("aladin-glass");
      // Never put CSS filter/transform on this node — freezes WebGL paints
      aladinDiv.style.filter = "";
      aladinDiv.style.transform = "";
    }
    if (stage) {
      stage.classList.remove("glass-boot");
      stage.classList.add("glass-live");
    }

    ready = true;
    while (waiters.length) waiters.shift()(aladin);
    return aladin;
  }

  function getView({ syncFromAladin = false } = {}) {
    if (!aladin || !syncFromAladin) {
      return { ra: cam.ra, dec: cam.dec, fov: cam.fov };
    }
    try {
      if (typeof aladin.getRaDec === "function") {
        const rd = aladin.getRaDec();
        if (Array.isArray(rd) && Number.isFinite(rd[0])) {
          cam.ra = Number(rd[0]);
          cam.dec = Number(rd[1]);
        }
      }
      if (typeof aladin.getFov === "function") {
        const f = aladin.getFov();
        const v = Array.isArray(f) ? f[0] : f;
        if (Number.isFinite(v)) cam.fov = Number(v);
      }
    } catch {
      /* keep cam */
    }
    return { ...cam };
  }

  /**
   * Push cam into Aladin WASM view. Prefer view.pointTo (direct wasm.setCenter).
   * @param {boolean} force  skip throttle
   */
  function applyCam(force = false) {
    if (!aladin) return false;
    const now = performance.now();
    // Allow up to ~60 pushes/sec; always allow force
    if (!force && now - lastApplyAt < 12) return false;
    lastApplyAt = now;

    const ra = Number(cam.ra);
    const dec = Number(cam.dec);
    const fov = Number(cam.fov);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;

    let ok = false;
    try {
      // Fast path: View.pointTo → wasm.setCenter (Aladin 3.x)
      if (aladin.view && typeof aladin.view.pointTo === "function") {
        aladin.view.pointTo(ra, dec);
        ok = true;
      } else if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(ra, dec);
        ok = true;
      }

      // FoV: Aladin exposes setFoV (alias setFov)
      if (Number.isFinite(fov)) {
        if (typeof aladin.setFoV === "function") {
          aladin.setFoV(fov);
        } else if (typeof aladin.setFov === "function") {
          aladin.setFov(fov);
        } else if (aladin.view && typeof aladin.view.setFoV === "function") {
          aladin.view.setFoV(fov);
        }
      }

      // Nudge paint
      if (aladin.view && typeof aladin.view.requestRedraw === "function") {
        aladin.view.requestRedraw();
      } else if (typeof aladin.requestRedraw === "function") {
        aladin.requestRedraw();
      }
    } catch (e) {
      console.warn("applyCam", e);
      return false;
    }

    try {
      window.__ncCam = { ra, dec, fov, ok, t: now };
    } catch {
      /* ignore */
    }
    return ok;
  }

  function goto(view, { hard = false } = {}) {
    if (!view) return;
    cam.ra = Number(view.ra);
    cam.dec = Number(view.dec);
    if (view.fov != null) cam.fov = Number(view.fov);
    if (hard) {
      applyCam(true);
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      fx?.setThrottle(0);
      return;
    }
    applyCam(true);
  }

  /**
   * Live glide toward target — throttle (0–1) scales degrees/frame.
   * Always mutates cam and calls applyCam so Aladin updates.
   */
  function glideStep(target, throttle = 0.35) {
    if (!target || !aladin) {
      return { ...cam, distDeg: 0, speed: 0, applied: false };
    }

    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    // Visible motion: t=0.35 → ~0.85°/frame; t=1 → ~2.2°/frame
    const maxStep = t <= 0.02 ? 0 : 0.2 + t * 2.0;

    const dRa = wrapDeltaRa(Number(target.ra) - cam.ra);
    const dDec = Number(target.dec) - cam.dec;
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dist = Math.hypot(dRa * cos, dDec);

    const approach = dist < 4 ? Math.max(0.2, dist / 4) : 1;
    const stepDeg = maxStep * approach;

    if (dist > 1e-4 && stepDeg > 0) {
      const move = Math.min(stepDeg, dist);
      const u = move / dist;
      let nRa = cam.ra + dRa * u;
      let nDec = cam.dec + dDec * u;
      nRa = ((nRa % 360) + 360) % 360;
      nDec = Math.max(-89.9, Math.min(89.9, nDec));
      cam.ra = nRa;
      cam.dec = nDec;
    }

    if (target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Number(target.fov);
      cam.fov = cam.fov + (tFov - cam.fov) * (0.1 + t * 0.2);
    }

    const applied = applyCam(t > 0.04); // force apply while gliding

    const speed = t > 0.04 && dist > 0.02 ? Math.min(1, t) : 0;
    lastGlideSpeed = speed * 0.6 + lastGlideSpeed * 0.4;
    setMotionBlur(lastGlideSpeed);
    fx?.setThrottle(t);
    fx?.setSkyFromView(cam);

    return {
      ra: cam.ra,
      dec: cam.dec,
      fov: cam.fov,
      distDeg: dist,
      speed: lastGlideSpeed,
      applied,
    };
  }

  /**
   * Instant nudge used when throttle keys/slider change (extra push).
   */
  function throttleKick(target, throttle) {
    if (!target) return null;
    // One larger step for immediate feedback
    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    if (t <= 0.02) {
      applyCam(true);
      fx?.setThrottle(0);
      setMotionBlur(0);
      return getView();
    }
    // Temporarily boost for one frame feel
    const boost = Math.min(1, t + 0.15);
    return glideStep(target, boost);
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.12);
    // Intentionally do NOT filter/transform #aladin-lite-div — freezes WASM canvas
    const glass = document.querySelector(".aladin-glass");
    if (glass) {
      glass.style.filter = "";
      glass.style.transform = "";
    }
  }

  function setPhase(phase) {
    fx?.setPhase(phase);
    const stage = document.getElementById("sky-stage");
    if (stage) stage.dataset.phase = phase || "";
  }

  function applyChapterSky(night) {
    const sky = night?.sky || { mood: night?.weather_mood || "rain" };
    fx?.setWeather(sky);
    const stage = document.getElementById("sky-stage");
    if (stage) stage.dataset.weather = sky.mood || night?.weather_mood || "rain";
    if (!aladin || !sky.survey) return;
    try {
      if (typeof aladin.setImageSurvey === "function") {
        aladin.setImageSurvey(sky.survey);
      } else if (typeof aladin.setBaseImageLayer === "function") {
        aladin.setBaseImageLayer(sky.survey);
      }
    } catch {
      /* ignore */
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
    throttleKick,
    applyCam,
    setOverlays,
    setPhase,
    setMotionBlur,
    applyChapterSky,
    get fx() {
      return fx;
    },
    get aladin() {
      return aladin;
    },
    get ready() {
      return ready;
    },
    get cam() {
      return { ...cam };
    },
  };
}
