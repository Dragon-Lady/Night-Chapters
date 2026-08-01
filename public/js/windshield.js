/**
 * Windshield — Aladin Lite as the cockpit glass.
 *
 * Scenery path (every rAF while throttle > 0):
 *   glideStep → cam delta → panScenery (wasm.goFromTo + pointTo)
 *            → draw catalogs → FX setCamDelta
 *
 * Mouse-drag uses goFromTo; setCenter alone can update getRaDec without
 * the HiPS/catalog paint pipeline keeping up. We use both.
 */

import { createFxLayer } from "./fx-layer.js";

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 8.0,
  survey: "P/DSS2/color",
};

/** Max sky speed (°/s). Keep low enough for HiPS tiles to load while moving. */
const MAX_DEG_PER_SEC = 6.5;
const MIN_DEG_PER_SEC = 0.9;

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
  let lastApplyAt = 0;
  let lastFovApplied = BOOT.fov;
  let progressiveCatsOrig = null;
  let lastAbsSyncAt = 0;

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
    patchProgressiveCats();
    unfreezeGlassCss();
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
      unfreezeGlassCss();
    }
    if (stage) {
      stage.classList.remove("glass-boot");
      stage.classList.add("glass-live");
    }

    // After first layout, force a resize so WebGL buffer matches glass
    requestAnimationFrame(() => {
      try {
        window.dispatchEvent(new Event("resize"));
        aladin?.view?.fixBy?.();
        applyCam(true);
      } catch {
        /* ignore */
      }
    });

    ready = true;
    while (waiters.length) waiters.shift()(aladin);
    return aladin;
  }

  /** Strip CSS that freezes WebGL compositing on the glass stack. */
  function unfreezeGlassCss() {
    const stage = document.getElementById("sky-stage");
    if (stage) {
      stage.style.isolation = "auto";
      // keep overflow hidden for chrome, but avoid filter/transform
      stage.style.filter = "none";
      stage.style.transform = "none";
    }
    const nodes = document.querySelectorAll(
      "#aladin-lite-div, .aladin-glass, .aladin-container, .aladin-imageCanvas, .aladin-catalogCanvas"
    );
    nodes.forEach((el) => {
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
      if (now - lastCats < 1500) return;
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
    syncCamFromAladin();
    return { ...cam };
  }

  function syncCamFromAladin() {
    if (!aladin) return;
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
  }

  function stopAladinAnimations() {
    if (!aladin) return;
    try {
      if (typeof aladin.stopAnimation === "function") aladin.stopAnimation();
      if (aladin.view?.zoom?.stopAnimation) aladin.view.zoom.stopAnimation();
      if (aladin.view?.animationParams) aladin.view.animationParams.running = false;
      if (aladin.animationParams) aladin.animationParams.running = false;
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
   * Mouse-equivalent scenery pan in degrees (ICRS).
   * This is what actually scrolls HiPS tiles in Aladin 3.x.
   * @returns {{dxPx:number,dyPx:number,ok:boolean}}
   */
  function panSceneryByDegrees(dRaDeg, dDecDeg) {
    if (!aladin?.view?.wasm) return { dxPx: 0, dyPx: 0, ok: false };
    const view = aladin.view;
    const wasm = view.wasm;
    const w = view.width || view.aladin?.aladinDiv?.clientWidth || 800;
    const h = view.height || view.aladin?.aladinDiv?.clientHeight || 600;
    if (w < 2 || h < 2) return { dxPx: 0, dyPx: 0, ok: false };

    let fovX = cam.fov;
    try {
      const f = aladin.getFov?.();
      if (Array.isArray(f) && Number.isFinite(f[0])) fovX = f[0];
      else if (Number.isFinite(f)) fovX = f;
    } catch {
      /* use cam.fov */
    }
    if (!Number.isFinite(fovX) || fovX <= 0) fovX = 8;
    const fovY = fovX * (h / w);
    const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;

    // Empirical (see goFromTo test): drag left (to.x < from.x) decreases RA.
    // To move center by +dRa, drag right by the matching pixel amount.
    const dxPx = (dRaDeg * cos * w) / fovX;
    const dyPx = (-dDecDeg * h) / fovY;

    if (Math.abs(dxPx) < 0.05 && Math.abs(dyPx) < 0.05) {
      return { dxPx: 0, dyPx: 0, ok: false };
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const toX = cx + dxPx;
    const toY = cy + dyPx;

    try {
      stopAladinAnimations();
      // Same order Aladin uses on mouse drag
      if (typeof wasm.moveMouse === "function") {
        wasm.moveMouse(cx, cy, toX, toY);
      }
      if (typeof wasm.goFromTo === "function") {
        wasm.goFromTo(cx, cy, toX, toY);
      }
      if (typeof view.updateCenter === "function") {
        view.updateCenter();
      }
      // Catalogs reproject from new view center
      view.needRedraw = true;
      if (typeof view.drawAllOverlays === "function") {
        view.drawAllOverlays();
      }
      if (typeof view.requestRedraw === "function") {
        view.requestRedraw();
      }
      return { dxPx, dyPx, ok: true };
    } catch (e) {
      console.warn("panSceneryByDegrees", e);
      return { dxPx: 0, dyPx: 0, ok: false };
    }
  }

  /**
   * Absolute snap — pointTo / setCenter + full catalog redraw.
   * Used on hard goto and periodic resync during glide.
   */
  function applyCam(force = false) {
    if (!aladin) return false;
    const now = performance.now();
    if (!force && now - lastApplyAt < 12) return false;
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
      unfreezeGlassCss();

      const view = aladin.view;
      const wasm = view?.wasm;

      // Public absolute API
      if (view && typeof view.pointTo === "function") {
        view.pointTo(ra, dec);
        path = "pointTo";
        ok = true;
      } else if (typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(ra, dec);
        path = "gotoRaDec";
        ok = true;
      }

      if (wasm && typeof wasm.setCenter === "function") {
        if (view) view.viewCenter = { ra, dec };
        wasm.setCenter(ra, dec);
        path = path === "none" ? "wasm.setCenter" : path + "+wasm";
        ok = true;
      }

      if (view && typeof view.updateCenter === "function") {
        // Keep viewCenter in sync with wasm after absolute set
        try {
          // updateCenter reads FROM wasm — only if we trust wasm center
        } catch {
          /* ignore */
        }
      }

      // FoV sparingly (zoom thrash blacks the glass)
      if (Number.isFinite(fov) && (force || Math.abs(fov - lastFovApplied) > 0.08)) {
        lastFovApplied = fov;
        if (typeof aladin.setFoV === "function") aladin.setFoV(fov);
        else if (typeof aladin.setFov === "function") aladin.setFov(fov);
        else if (view && typeof view.setFoV === "function") view.setFoV(fov);
      }

      // Catalogs + paint
      if (view) {
        view.needRedraw = true;
        if (typeof view.throttledPositionChanged === "function") {
          view.throttledPositionChanged(false);
        }
        if (typeof view.drawAllOverlays === "function") {
          view.drawAllOverlays();
        }
        if (typeof view.requestRedraw === "function") view.requestRedraw();
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

  function goto(viewIn, { hard = false } = {}) {
    if (!viewIn) return;
    cam.ra = Number(viewIn.ra);
    cam.dec = Number(viewIn.dec);
    if (viewIn.fov != null) cam.fov = Math.max(5, Number(viewIn.fov));
    stopAladinAnimations();
    applyCam(true);
    if (hard) {
      setMotionBlur(0);
      fx?.setSkyFromView(cam);
      fx?.setCamDelta?.(0, 0, 1 / 60, 0);
      fx?.setThrottle(0);
    }
  }

  /**
   * Live glide toward target each rAF.
   * Moves scenery via goFromTo (delta) + occasional absolute pointTo resync.
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

    // Tile-friendly speeds: t=0.35 → ~2.9°/s, t=1 → ~6.5°/s
    const maxDegPerSec =
      t <= 0.02 ? 0 : MIN_DEG_PER_SEC + t * (MAX_DEG_PER_SEC - MIN_DEG_PER_SEC);

    let dRa = 0;
    let dDec = 0;
    let dist = 0;

    if (hasTarget) {
      dRa = wrapDeltaRa(Number(target.ra) - cam.ra);
      dDec = Number(target.dec) - cam.dec;
      const cos = Math.cos((cam.dec * Math.PI) / 180) || 1;
      dist = Math.hypot(dRa * cos, dDec);
    }

    const approach = dist > 0 && dist < 3 ? Math.max(0.35, dist / 3) : 1;
    const stepDeg = maxDegPerSec * approach * dt;

    const prevRa = cam.ra;
    const prevDec = cam.dec;
    let movedRa = 0;
    let movedDec = 0;

    if (t > 0.02 && stepDeg > 0) {
      if (hasTarget && dist > 1e-4) {
        const move = Math.min(stepDeg, dist);
        const u = move / dist;
        movedRa = dRa * u;
        movedDec = dDec * u;
        let nRa = cam.ra + movedRa;
        let nDec = cam.dec + movedDec;
        nRa = ((nRa % 360) + 360) % 360;
        nDec = Math.max(-89.9, Math.min(89.9, nDec));
        cam.ra = nRa;
        cam.dec = nDec;
      } else if (!hasTarget) {
        movedRa = stepDeg * 0.25;
        cam.ra = (((cam.ra + movedRa) % 360) + 360) % 360;
      }
    }

    // Soft FoV toward target (wide cruise for visible scenery)
    if (hasTarget && target.fov != null && Number.isFinite(Number(target.fov))) {
      const tFov = Math.max(5.5, Number(target.fov));
      cam.fov = cam.fov + (tFov - cam.fov) * Math.min(1, 0.6 * dt);
    } else if (t > 0.04 && cam.fov < 7) {
      cam.fov = cam.fov + (8 - cam.fov) * Math.min(1, 0.4 * dt);
    }

    let pan = { dxPx: 0, dyPx: 0, ok: false };
    let applied = false;
    let path = "idle";

    if (t > 0.02 && (Math.abs(movedRa) > 1e-8 || Math.abs(movedDec) > 1e-8)) {
      // 1) Primary: mouse-style pan — moves HiPS scenery + catalogs
      pan = panSceneryByDegrees(movedRa, movedDec);
      if (pan.ok) {
        applied = true;
        path = "goFromTo";
        // Trust Aladin after pixel pan
        syncCamFromAladin();
      }

      // 2) Absolute pointTo every ~200ms (or if pan failed) so we don't drift
      const now = performance.now();
      if (!pan.ok || now - lastAbsSyncAt > 200) {
        // Re-assert desired cam (may have been set before pan sync)
        if (hasTarget && dist > 1e-4) {
          // keep cam as our intended step endpoint before pan overwrite
          // recompute intended from prev + moved
          cam.ra = (((prevRa + movedRa) % 360) + 360) % 360;
          cam.dec = Math.max(-89.9, Math.min(89.9, prevDec + movedDec));
        }
        const absOk = applyCam(true);
        if (absOk) {
          applied = true;
          path = pan.ok ? "goFromTo+pointTo" : "pointTo";
          lastAbsSyncAt = now;
        }
      } else {
        // Still force catalog overlay paint on pan-only frames
        try {
          const view = aladin.view;
          if (view) {
            view.needRedraw = true;
            view.drawAllOverlays?.();
            view.requestRedraw?.();
          }
        } catch {
          /* ignore */
        }
      }
    } else if (t > 0.02) {
      // Throttle up but no step (at target) — keep scenery alive
      applyCam(false);
    }

    // Screen-space delta for FX (prefer real pan pixels)
    let dxPx = pan.dxPx;
    let dyPx = pan.dyPx;
    if (!pan.ok) {
      const cosFx = Math.cos((cam.dec * Math.PI) / 180) || 1;
      const dRaMove = wrapDeltaRa(cam.ra - prevRa);
      const dDecMove = cam.dec - prevDec;
      const pxPerDeg = 64;
      dxPx = -dRaMove * cosFx * pxPerDeg;
      dyPx = dDecMove * pxPerDeg;
    } else {
      // goFromTo drag direction is opposite of feature motion on screen
      // Features move opposite to mouse drag; flip for star streaks with scenery
      dxPx = -pan.dxPx;
      dyPx = -pan.dyPx;
    }

    const movedDeg = Math.hypot(
      wrapDeltaRa(cam.ra - prevRa) * (Math.cos((cam.dec * Math.PI) / 180) || 1),
      cam.dec - prevDec
    );

    if (typeof fx?.setCamDelta === "function") {
      fx.setCamDelta(dxPx, dyPx, dt, t);
    } else {
      fx?.panBy?.(dxPx, dyPx);
    }
    fx?.setSkyFromView(cam);
    fx?.setThrottle(t);

    const speed =
      t > 0.04 && (dist > 0.02 || movedDeg > 0.0005)
        ? Math.min(1, t)
        : t > 0.04
          ? t * 0.4
          : 0;
    lastGlideSpeed = speed * 0.55 + lastGlideSpeed * 0.45;
    setMotionBlur(lastGlideSpeed);

    try {
      window.__ncCam = {
        ra: cam.ra,
        dec: cam.dec,
        fov: cam.fov,
        ok: applied,
        path,
        t: performance.now(),
      };
      window.__ncGlide = {
        movedDeg,
        applied,
        dist,
        thr: t,
        path,
        dxPx,
        dyPx,
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
      dxPx,
      dyPx,
      path,
    };
  }

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
    // Slightly larger step so W/S feels instant, still tile-safe
    return glideStep(target, Math.min(1, t + 0.15), Math.max(dtSec, 1 / 30));
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

      // Force catalog canvas paint after source change
      if (aladin.view) {
        aladin.view.needRedraw = true;
        aladin.view.drawAllOverlays?.();
        aladin.view.requestRedraw?.();
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
    panSceneryByDegrees,
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
