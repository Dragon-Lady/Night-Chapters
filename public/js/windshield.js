/**
 * Windshield — Aladin Lite as the cockpit glass.
 *
 * Every rAF while throttle > 0:
 *   glideStep → cam += delta(throttle)
 *            → view.pointTo(cam.ra, cam.dec)   // force Aladin camera
 *            → catalog redraw
 *            → FX setCamDelta(same delta)
 */

import { createFxLayer } from "./fx-layer.js";

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 8.0,
  survey: "P/DSS2/color",
};

/** Sky speed °/s — fast enough to see, slow enough for HiPS tiles */
const MAX_DEG_PER_SEC = 8;
const MIN_DEG_PER_SEC = 1.2;

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

  let cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
  let lastGlideSpeed = 0;
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
    } catch {
      /* ignore */
    }

    cam = { ra: BOOT.ra, dec: BOOT.dec, fov: BOOT.fov };
    patchProgressiveCats();
    unfreezeGlassCss();
    forcePointTo(cam.ra, cam.dec, true);

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
    if (aladinDiv) aladinDiv.classList.add("aladin-glass");
    unfreezeGlassCss();

    if (stage) {
      stage.classList.remove("glass-boot");
      stage.classList.add("glass-live");
    }

    requestAnimationFrame(() => {
      try {
        window.dispatchEvent(new Event("resize"));
        forcePointTo(cam.ra, cam.dec, true);
      } catch {
        /* ignore */
      }
    });

    ready = true;
    while (waiters.length) waiters.shift()(aladin);
    return aladin;
  }

  function unfreezeGlassCss() {
    const stage = document.getElementById("sky-stage");
    if (stage) {
      stage.style.isolation = "auto";
      stage.style.filter = "none";
      stage.style.transform = "none";
    }
    document
      .querySelectorAll(
        "#aladin-lite-div, .aladin-glass, .aladin-container, .aladin-imageCanvas, .aladin-catalogCanvas"
      )
      .forEach((el) => {
        el.style.filter = "none";
        el.style.transform = "none";
        el.style.willChange = "auto";
        el.style.isolation = "auto";
      });
  }

  function patchProgressiveCats() {
    const view = aladin?.view;
    if (!view || typeof view.refreshProgressiveCats !== "function") return;
    if (view.__ncProgPatched) return;
    progressiveCatsOrig = view.refreshProgressiveCats.bind(view);
    let lastCats = 0;
    view.refreshProgressiveCats = function ncThrottledCats() {
      const now = performance.now();
      if (now - lastCats < 1200) return;
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
    if (syncFromAladin) syncCamFromAladin();
    return { ra: cam.ra, dec: cam.dec, fov: cam.fov };
  }

  function syncCamFromAladin() {
    if (!aladin) return;
    try {
      const rd = aladin.getRaDec?.();
      if (Array.isArray(rd) && Number.isFinite(rd[0])) {
        cam.ra = Number(rd[0]);
        cam.dec = Number(rd[1]);
      }
      const f = aladin.getFov?.();
      const v = Array.isArray(f) ? f[0] : f;
      if (Number.isFinite(v)) cam.fov = Number(v);
    } catch {
      /* keep cam */
    }
  }

  /**
   * Force Aladin camera to (ra, dec) via view.pointTo every time.
   * Also refreshes catalog canvas so markers glide with scenery.
   * @returns {boolean}
   */
  function forcePointTo(ra, dec, forceFov = false) {
    if (!aladin) return false;
    ra = Number(ra);
    dec = Number(dec);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return false;

    const view = aladin.view;
    let ok = false;
    let path = "none";

    try {
      // Stop any animateTo that would fight continuous glide
      if (typeof aladin.stopAnimation === "function") aladin.stopAnimation();
      if (aladin.animationParams) aladin.animationParams.running = false;
      if (view?.animationParams) view.animationParams.running = false;
      if (view) {
        view.pan = null;
        view.dragging = false;
      }

      // --- Primary: view.pointTo (wasm.setCenter + POSITION_CHANGED) ---
      if (view && typeof view.pointTo === "function") {
        view.pointTo(ra, dec);
        path = "pointTo";
        ok = true;
      } else if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(ra, dec);
        path = "gotoRaDec";
        ok = true;
      }

      // Reinforce wasm center (belt-and-suspenders)
      if (view?.wasm && typeof view.wasm.setCenter === "function") {
        view.viewCenter = { ra, dec };
        view.wasm.setCenter(ra, dec);
        path = path === "none" ? "wasm" : path + "+wasm";
        ok = true;
      }

      // FoV only when forced or meaningfully changed
      const fov = Number(cam.fov);
      if (
        Number.isFinite(fov) &&
        (forceFov || Math.abs(fov - lastFovApplied) > 0.1)
      ) {
        lastFovApplied = fov;
        if (typeof aladin.setFoV === "function") aladin.setFoV(fov);
        else if (typeof aladin.setFov === "function") aladin.setFov(fov);
      }

      // --- Catalog refresh so overlays track the new center ---
      refreshCatalogs(view);

      try {
        window.__ncCam = {
          ra,
          dec,
          fov: cam.fov,
          ok,
          path,
          t: performance.now(),
        };
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.warn("forcePointTo", e);
      return false;
    }
    return ok;
  }

  /** Redraw Aladin catalog/overlay canvas after a camera move. */
  function refreshCatalogs(view) {
    if (!view) view = aladin?.view;
    if (!view) return;
    try {
      view.needRedraw = true;
      // Reproject catalog sources into the new view
      if (typeof view.drawAllOverlays === "function") {
        view.drawAllOverlays();
      }
      if (typeof view.requestRedraw === "function") {
        view.requestRedraw();
      }
      // Nudge position pipeline (tile fetch + progressive cats, throttled)
      if (typeof view.throttledPositionChanged === "function") {
        view.throttledPositionChanged(false);
      }
    } catch {
      /* ignore */
    }
  }

  /** @deprecated name kept for game-loop callers — maps to forcePointTo */
  function applyCam(force = false) {
    return forcePointTo(cam.ra, cam.dec, !!force);
  }

  function goto(viewIn, { hard = false } = {}) {
    if (!viewIn) return;
    cam.ra = Number(viewIn.ra);
    cam.dec = Number(viewIn.dec);
    if (viewIn.fov != null) cam.fov = Math.max(5, Number(viewIn.fov));
    forcePointTo(cam.ra, cam.dec, true);
    if (hard) {
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      fx?.setCamDelta?.(0, 0, 1 / 60, 0);
      fx?.setThrottle(0);
    }
  }

  /**
   * Every rAF: throttle → sky delta → pointTo + catalog + FX (same delta).
   */
  function glideStep(target, throttle = 0.35, dtSec = 1 / 60) {
    if (!aladin) {
      return { ...cam, distDeg: 0, speed: 0, applied: false, movedDeg: 0 };
    }

    const hasTarget =
      target &&
      Number.isFinite(Number(target.ra)) &&
      Number.isFinite(Number(target.dec));

    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    const dt = Math.min(0.1, Math.max(0.001, Number(dtSec) || 1 / 60));

    // Degrees this frame from throttle
    const maxDegPerSec =
      t <= 0.02
        ? 0
        : MIN_DEG_PER_SEC + t * (MAX_DEG_PER_SEC - MIN_DEG_PER_SEC);

    let dist = 0;
    let dRaToTarget = 0;
    let dDecToTarget = 0;

    if (hasTarget) {
      dRaToTarget = wrapDeltaRa(Number(target.ra) - cam.ra);
      dDecToTarget = Number(target.dec) - cam.dec;
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      dist = Math.hypot(dRaToTarget * cos, dDecToTarget);
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
        dRa = dRaToTarget * u;
        dDec = dDecToTarget * u;
      } else if (!hasTarget) {
        // No pin: cruise in RA so throttle still moves scenery
        dRa = stepDeg * 0.35;
        dDec = 0;
      }
    }

    // Apply incremental RA/Dec shift to internal cam
    if (dRa !== 0 || dDec !== 0) {
      let nRa = cam.ra + dRa;
      let nDec = cam.dec + dDec;
      nRa = ((nRa % 360) + 360) % 360;
      nDec = Math.max(-89.9, Math.min(89.9, nDec));
      cam.ra = nRa;
      cam.dec = nDec;
    }

    // Soft FoV (wide enough for scenery to read)
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(6, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.5 * dt);
    } else if (t > 0.04 && cam.fov < 7.5) {
      cam.fov = Math.min(9, cam.fov + 2 * dt);
    }

    // --- FORCE Aladin camera every frame with the new absolute center ---
    // User requirement: pointTo with the incremental shift result every rAF
    let applied = false;
    if (t > 0.02 && (dRa !== 0 || dDec !== 0)) {
      applied = forcePointTo(cam.ra, cam.dec, false);
    } else if (t > 0.02) {
      // At target but throttle up — keep center asserted
      applied = forcePointTo(cam.ra, cam.dec, false);
    }

    // Same delta for FX stars (degrees → screen px)
    const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
    const dRaMove = wrapDeltaRa(cam.ra - prevRa);
    const dDecMove = cam.dec - prevDec;
    const pxPerDeg = 70;
    const dxPx = -dRaMove * cosFx * pxPerDeg;
    const dyPx = dDecMove * pxPerDeg;
    const movedDeg = Math.hypot(dRaMove * cosFx, dDecMove);

    if (typeof fx?.setCamDelta === "function") {
      fx.setCamDelta(dxPx, dyPx, dt, t);
    } else {
      fx?.panBy?.(dxPx, dyPx);
    }
    fx?.setSkyFromView(cam);
    fx?.setThrottle(t);

    const speed =
      t > 0.04 && movedDeg > 0.0002
        ? Math.min(1, t)
        : t > 0.04
          ? t * 0.35
          : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);

    try {
      window.__ncGlide = {
        dRa,
        dDec,
        movedDeg,
        applied,
        dist,
        thr: t,
        path: window.__ncCam?.path || "pointTo",
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
      applied,
      movedDeg,
      dRa,
      dDec,
      dxPx,
      dyPx,
    };
  }

  function throttleKick(target, throttle, dtSec = 1 / 24) {
    if (!aladin) return null;
    const t = Math.max(0, Math.min(1, Number(throttle) || 0));
    if (t <= 0.02) {
      forcePointTo(cam.ra, cam.dec, true);
      fx?.setThrottle(0);
      fx?.setCamDelta?.(0, 0, 1 / 60, 0);
      setMotionBlur(0);
      return getView();
    }
    // Immediate boosted step on key/slider — still uses pointTo path
    return glideStep(target, Math.min(1, t + 0.2), Math.max(dtSec, 1 / 28));
  }

  function setMotionBlur(amount) {
    const stage = document.getElementById("sky-stage");
    if (!stage) return;
    const a = Math.max(0, Math.min(1, amount));
    stage.style.setProperty("--glide", String(a));
    stage.classList.toggle("is-gliding", a > 0.08);
    unfreezeGlassCss();
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
    if (typeof A.marker === "function") {
      return A.marker(ra, dec, { popupTitle: name });
    }
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

      if (typeof pinCatalog.addSources === "function") {
        pinCatalog.addSources(pinSrc);
      } else {
        pinSrc.forEach((s) => pinCatalog.addSources([s]));
      }

      if (mysteryCatalog) {
        if (typeof mysteryCatalog.addSources === "function") {
          mysteryCatalog.addSources(mystSrc);
        } else {
          mystSrc.forEach((s) => mysteryCatalog.addSources([s]));
        }
      }

      refreshCatalogs(aladin.view);
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
    forcePointTo,
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
