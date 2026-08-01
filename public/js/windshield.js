/**
 * Windshield — Aladin Lite as the cockpit glass.
 *
 * Visual path (every rAF while throttle > 0):
 *   glideStep → mutate cam → applyCam (gotoRaDec / pointTo / wasm.setCenter)
 *              → FX setCamDelta (stars streak with same delta)
 *
 * applyThrottleToSky (W/S/slider) calls throttleKick → same path immediately.
 */

import { createFxLayer } from "./fx-layer.js";

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 6.0,
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

  // Internal camera — sole source of truth for continuous glide
  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
  let lastGlideSpeed = 0;
  let lastApplyAt = 0;
  let lastFovApplied = BOOT.fov;
  let progressiveCatsOrig = null;

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
      window.__aladin = aladin;
      window.__ncCam = () => ({ ...cam });
      window.__ncApplyCam = (force) => applyCam(!!force);
    } catch {
      /* ignore */
    }

    cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };

    // During continuous glide, pointTo schedules progressive-cat timeouts every
    // call. Patch to a throttled version so we can safely call pointTo each frame.
    patchProgressiveCats();

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

  /**
   * pointTo schedules refreshProgressiveCats via setTimeout(1s) every call.
   * Throttle that to once per 2s so 60fps pointTo is safe.
   */
  function patchProgressiveCats() {
    const view = aladin?.view;
    if (!view || typeof view.refreshProgressiveCats !== "function") return;
    if (view.__ncProgPatched) return;
    progressiveCatsOrig = view.refreshProgressiveCats.bind(view);
    let lastCats = 0;
    view.refreshProgressiveCats = function ncThrottledCats() {
      const now = performance.now();
      if (now - lastCats < 2000) return;
      lastCats = now;
      try {
        progressiveCatsOrig();
      } catch {
        /* ignore */
      }
    };
    view.__ncProgPatched = true;
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

  function stopAladinAnimations() {
    if (!aladin) return;
    try {
      if (typeof aladin.stopAnimation === "function") aladin.stopAnimation();
      if (aladin.view?.zoom?.stopAnimation) aladin.view.zoom.stopAnimation();
      if (aladin.view?.animationParams) {
        aladin.view.animationParams.running = false;
      }
      if (aladin.animationParams) aladin.animationParams.running = false;
      // Kill any residual pan/inertia that would fight programmatic center
      if (aladin.view) {
        aladin.view.pan = null;
        aladin.view.dragging = false;
        aladin.view.realDragging = false;
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Push cam into Aladin so the sky actually re-renders.
   * Uses the full public path (gotoRaDec → view.pointTo → wasm.setCenter)
   * plus needRedraw so WebGL paints the new center every frame.
   */
  function applyCam(force = false) {
    if (!aladin) return false;
    const now = performance.now();
    // Live glide always passes force=true; rate-limit only soft calls
    if (!force && now - lastApplyAt < 10) return false;
    lastApplyAt = now;

    const ra = Number(cam.ra);
    const dec = Number(cam.dec);
    const fov = Number(cam.fov);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;

    let path = "none";
    let ok = false;

    try {
      stopAladinAnimations();
      patchProgressiveCats();

      const view = aladin.view;
      const wasm = view?.wasm;

      // 1) Public API — gotoRaDec → view.pointTo → wasm.setCenter + POSITION_CHANGED
      if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(ra, dec);
        path = "gotoRaDec";
        ok = true;
      } else if (view && typeof view.pointTo === "function") {
        view.pointTo(ra, dec);
        path = "pointTo";
        ok = true;
      }

      // 2) Reinforce WASM center (in case public path no-ops under load)
      if (wasm && typeof wasm.setCenter === "function") {
        if (view) {
          view.viewCenter = { ra, dec };
        }
        wasm.setCenter(ra, dec);
        if (!ok) {
          path = "wasm.setCenter";
          ok = true;
        } else {
          path = path + "+wasm";
        }
      }

      // 3) FoV when it changes (min cruise FoV keeps starfields readable)
      if (Number.isFinite(fov) && (force || Math.abs(fov - lastFovApplied) > 0.03)) {
        lastFovApplied = fov;
        if (typeof aladin.setFoV === "function") aladin.setFoV(fov);
        else if (typeof aladin.setFov === "function") aladin.setFov(fov);
        else if (view && typeof view.setFoV === "function") view.setFoV(fov);
        else if (wasm && typeof wasm.setFieldOfView === "function") {
          wasm.setFieldOfView(fov);
        }
      }

      // 4) Force a paint this frame
      if (view) {
        view.needRedraw = true;
        if (typeof view.requestRedraw === "function") view.requestRedraw();
      } else if (typeof aladin.requestRedraw === "function") {
        aladin.requestRedraw();
      }
    } catch (e) {
      console.warn("applyCam", e);
      return false;
    }

    try {
      window.__ncCam = { ra, dec, fov, ok, path, t: now };
    } catch {
      /* ignore */
    }
    return ok;
  }

  function goto(view, { hard = false } = {}) {
    if (!view) return;
    cam.ra = Number(view.ra);
    cam.dec = Number(view.dec);
    if (view.fov != null) cam.fov = Math.max(3.5, Number(view.fov));
    stopAladinAnimations();
    applyCam(true);
    if (hard) {
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      fx?.setCamDelta?.(0, 0, 1 / 60);
      fx?.setThrottle(0);
    }
  }

  /**
   * Live glide toward target. Mutates cam, pushes Aladin every frame, drives FX.
   * @param {object} target {ra, dec, fov?}
   * @param {number} throttle 0–1
   * @param {number} [dtSec]
   */
  function glideStep(target, throttle = 0.35, dtSec = 1 / 60) {
    if (!aladin) {
      return { ...cam, distDeg: 0, speed: 0, applied: false, movedDeg: 0 };
    }
    // Allow glide even without target: small drift so throttle always reads
    const hasTarget =
      target &&
      Number.isFinite(Number(target.ra)) &&
      Number.isFinite(Number(target.dec));

    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    const dt = Math.min(0.1, Math.max(0.001, Number(dtSec) || 1 / 60));

    // Visible travel: t=0.35 → ~22°/s, t=1 → ~55°/s
    const maxDegPerSec = t <= 0.02 ? 0 : 12 + t * 43;

    let dRa = 0;
    let dDec = 0;
    let dist = 0;

    if (hasTarget) {
      dRa = wrapDeltaRa(Number(target.ra) - cam.ra);
      dDec = Number(target.dec) - cam.dec;
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      dist = Math.hypot(dRa * cos, dDec);
    }

    const approach = dist > 0 && dist < 5 ? Math.max(0.3, dist / 5) : 1;
    let stepDeg = maxDegPerSec * approach * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;

    if (t > 0.02 && stepDeg > 0) {
      if (hasTarget && dist > 1e-4) {
        const move = Math.min(stepDeg, dist);
        const u = move / dist;
        let nRa = cam.ra + dRa * u;
        let nDec = cam.dec + dDec * u;
        nRa = ((nRa % 360) + 360) % 360;
        nDec = Math.max(-89.9, Math.min(89.9, nDec));
        cam.ra = nRa;
        cam.dec = nDec;
      } else if (!hasTarget) {
        // No heading: gentle RA cruise so throttle still moves the glass
        cam.ra = (((cam.ra + stepDeg * 0.35) % 360) + 360) % 360;
      }
    }

    // Cruise FoV: keep wide enough that HiPS structure is readable while moving
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(4.0, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, (0.4 + t * 0.5) * dt * 3);
    } else if (t > 0.04) {
      // gently open FoV while flying if no target fov
      const cruise = 6.5;
      cam.fov = cam.fov + (cruise - cam.fov) * Math.min(1, dt * 1.5);
    }

    // ALWAYS push Aladin when throttle is up (force — skip rate limit)
    const applied = t > 0.02 ? applyCam(true) : applyCam(false);

    // Cam delta → screen pixels for FX streaks (same motion as sky)
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    // Stronger px scale so streaks are unmistakable on the glass
    const pxPerDeg = 72;
    const dxPx = -dRaMove * cosFx * pxPerDeg;
    const dyPx = dDecMove * pxPerDeg;
    const movedDeg = Math.hypot(dRaMove * cosFx, dDecMove);

    // Drive FX from the same delta as Aladin
    if (typeof fx?.setCamDelta === "function") {
      fx.setCamDelta(dxPx, dyPx, dt, t);
    } else {
      fx?.panBy?.(dxPx, dyPx);
    }
    fx?.setSkyFromView(cam);
    fx?.setThrottle(t);

    const speed = t > 0.04 && (dist > 0.02 || movedDeg > 0.001) ? Math.min(1, t) : t > 0.04 ? t * 0.5 : 0;
    lastGlideSpeed = speed * 0.6 + lastGlideSpeed * 0.4;
    setMotionBlur(lastGlideSpeed);

    return {
      ra: cam.ra,
      dec: cam.dec,
      fov: cam.fov,
      distDeg: dist,
      speed: lastGlideSpeed,
      applied,
      movedDeg,
      dxPx,
      dyPx,
    };
  }

  /**
   * Immediate push on key/slider change (before next rAF).
   */
  function throttleKick(target, throttle, dtSec = 1 / 24) {
    if (!aladin) return null;
    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    if (t <= 0.02) {
      applyCam(true);
      fx?.setThrottle(0);
      fx?.setCamDelta?.(0, 0, 1 / 60, 0);
      setMotionBlur(0);
      return getView();
    }
    // Boosted step so W/S feels instant
    return glideStep(target, Math.min(1, t + 0.25), Math.max(dtSec, 1 / 30));
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.08);
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
