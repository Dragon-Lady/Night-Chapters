/**
 * Windshield — Aladin Lite as the cockpit glass.
 * Throttle → glideStep → wasm.setCenter every frame so the sky actually moves.
 *
 * Important: continuous flight must NOT call view.pointTo 60×/s (that schedules
 * progressive-catalog timeouts and can thrash rendering). Prefer wasm.setCenter
 * + requestRedraw for the live glide path.
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
  let lastFovApplied = BOOT.fov;
  let lastCamForFx = { ra: BOOT.ra, dec: BOOT.dec };

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
    lastCamForFx = { ra: cam.ra, dec: cam.dec };
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
      aladinDiv.style.filter = "none";
      aladinDiv.style.transform = "none";
      aladinDiv.style.willChange = "auto";
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
   * Stop Aladin's internal animateTo / zoom hermite so they don't fight glide.
   */
  function stopAladinAnimations() {
    if (!aladin) return;
    try {
      if (typeof aladin.stopAnimation === "function") aladin.stopAnimation();
      if (aladin.view?.zoom?.stopAnimation) aladin.view.zoom.stopAnimation();
      if (aladin.view?.animationParams) aladin.view.animationParams.running = false;
      if (aladin.animationParams) aladin.animationParams.running = false;
    } catch {
      /* ignore */
    }
  }

  /**
   * Push cam into Aladin WASM view.
   * Live glide uses wasm.setCenter (cheap). Hard jumps use pointTo/gotoRaDec.
   * @param {boolean} force  skip rate limit / use full public API
   */
  function applyCam(force = false) {
    if (!aladin) return false;
    const now = performance.now();
    // ~60 pushes/sec for continuous glide; always allow force
    if (!force && now - lastApplyAt < 12) return false;
    lastApplyAt = now;

    const ra = Number(cam.ra);
    const dec = Number(cam.dec);
    const fov = Number(cam.fov);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;

    let ok = false;
    try {
      stopAladinAnimations();

      const view = aladin.view;
      const wasm = view?.wasm;

      // Fast continuous path: wasm.setCenter — no progressive-cat setTimeout thrash
      if (wasm && typeof wasm.setCenter === "function") {
        if (view.viewCenter) {
          view.viewCenter.ra = ra;
          view.viewCenter.dec = dec;
        } else {
          view.viewCenter = { ra, dec };
        }
        wasm.setCenter(ra, dec);
        ok = true;
      } else if (view && typeof view.pointTo === "function") {
        view.pointTo(ra, dec);
        ok = true;
      } else if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(ra, dec);
        ok = true;
      }

      // FoV only when it meaningfully changes (avoids zoom-state thrash)
      if (Number.isFinite(fov) && (force || Math.abs(fov - lastFovApplied) > 0.02)) {
        lastFovApplied = fov;
        if (typeof aladin.setFoV === "function") {
          aladin.setFoV(fov);
        } else if (typeof aladin.setFov === "function") {
          aladin.setFov(fov);
        } else if (view && typeof view.setFoV === "function") {
          view.setFoV(fov);
        } else if (wasm && typeof wasm.setFieldOfView === "function") {
          wasm.setFieldOfView(fov);
        }
      }

      // Nudge paint every push
      if (view && typeof view.requestRedraw === "function") {
        view.requestRedraw();
      } else if (typeof aladin.requestRedraw === "function") {
        aladin.requestRedraw();
      }
    } catch (e) {
      console.warn("applyCam", e);
      return false;
    }

    try {
      window.__ncCam = { ra, dec, fov, ok, t: now, path: "wasm" };
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
    lastCamForFx = { ra: cam.ra, dec: cam.dec };
    stopAladinAnimations();
    if (hard) {
      // Hard jump: use public API so catalogs refresh once
      try {
        if (aladin?.view && typeof aladin.view.pointTo === "function") {
          aladin.view.pointTo(cam.ra, cam.dec);
        } else if (typeof aladin?.gotoRaDec === "function") {
          aladin.gotoRaDec(cam.ra, cam.dec);
        }
        if (Number.isFinite(cam.fov)) {
          if (typeof aladin?.setFoV === "function") aladin.setFoV(cam.fov);
          else if (typeof aladin?.setFov === "function") aladin.setFov(cam.fov);
        }
        aladin?.view?.requestRedraw?.();
        lastFovApplied = cam.fov;
      } catch {
        applyCam(true);
      }
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      fx?.panBy?.(0, 0);
      fx?.setThrottle(0);
      return;
    }
    applyCam(true);
  }

  /**
   * Live glide toward target — throttle (0–1) scales degrees/sec (dt-aware).
   * Always mutates cam and calls applyCam so Aladin updates.
   * @param {object} target  {ra, dec, fov?}
   * @param {number} throttle 0–1
   * @param {number} [dtSec] frame delta seconds (default ~1/60)
   */
  function glideStep(target, throttle = 0.35, dtSec = 1 / 60) {
    if (!target || !aladin) {
      return { ...cam, distDeg: 0, speed: 0, applied: false };
    }

    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    const dt = Math.min(0.1, Math.max(0.001, Number(dtSec) || 1 / 60));

    // Visible motion: t=0.35 → ~18°/s; t=1 → ~48°/s (was ~0.9°/frame ≈ 54°/s at 60fps)
    // Keep strong so empty deep-sky fields still read as travel via coord + FX
    const maxDegPerSec = t <= 0.02 ? 0 : 8 + t * 40;

    const dRa = wrapDeltaRa(Number(target.ra) - cam.ra);
    const dDec = Number(target.dec) - cam.dec;
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dist = Math.hypot(dRa * cos, dDec);

    const approach = dist < 4 ? Math.max(0.25, dist / 4) : 1;
    const stepDeg = maxDegPerSec * approach * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;

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

    // Soft FoV approach — keep a minimum cruise FoV so sky structure stays visible
    if (target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(2.2, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, (0.35 + t * 0.5) * dt * 4);
    }

    const applied = applyCam(t > 0.02);

    // FX parallax from actual cam delta (degrees → screen drift)
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    // Scale deg → px: ~40 px per degree at typical glass size (feel, not exact)
    const pxPerDeg = 48;
    fx?.panBy?.(-dRaMove * cosFx * pxPerDeg, dDecMove * pxPerDeg);
    fx?.setSkyFromView(cam);
    fx?.setThrottle(t);

    const speed = t > 0.04 && dist > 0.02 ? Math.min(1, t) : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);
    lastCamForFx = { ra: cam.ra, dec: cam.dec };

    return {
      ra: cam.ra,
      dec: cam.dec,
      fov: cam.fov,
      distDeg: dist,
      speed: lastGlideSpeed,
      applied,
      movedDeg: Math.hypot(dRaMove * cosFx, dDecMove),
    };
  }

  /**
   * Instant nudge used when throttle keys/slider change (extra push).
   */
  function throttleKick(target, throttle, dtSec = 1 / 30) {
    if (!target) return null;
    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    if (t <= 0.02) {
      applyCam(true);
      fx?.setThrottle(0);
      setMotionBlur(0);
      return getView();
    }
    // One boosted step for immediate feedback on key/slider
    const boost = Math.min(1, t + 0.2);
    return glideStep(target, boost, Math.max(dtSec, 1 / 40));
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.12);
    // Intentionally do NOT filter/transform #aladin-lite-div — freezes WASM canvas
    const glass = document.querySelector(".aladin-glass, #aladin-lite-div");
    if (glass) {
      glass.style.filter = "none";
      glass.style.transform = "none";
      glass.style.willChange = "auto";
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
