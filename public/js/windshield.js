/**
 * Windshield — Aladin Lite as the cockpit glass.
 * Real sky spine + soft pin/mystery catalog overlays.
 */

const BOOT = {
  ra: 83.8221,
  dec: -5.3911,
  fov: 3.5,
  survey: "P/DSS2/color",
};

export function createWindshield(containerSelector = "#aladin-lite-div") {
  let aladin = null;
  let ready = false;
  const waiters = [];
  let pinCatalog = null;
  let mysteryCatalog = null;

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

    // Soft catalogs — personal / story pins + mystery glows
    try {
      if (typeof A.catalog === "function") {
        pinCatalog = A.catalog({
          name: "Personal & story pins",
          sourceSize: 18,
          color: "#9ec9ff",
          displayLabel: true,
          labelColor: "#c8d0e0",
          labelFont: "11px sans-serif",
        });
        mysteryCatalog = A.catalog({
          name: "Mystery glows",
          sourceSize: 22,
          color: "#e8d5a3",
          displayLabel: true,
          labelColor: "#e8d5a3",
          labelFont: "12px sans-serif",
        });
        aladin.addCatalog(pinCatalog);
        aladin.addCatalog(mysteryCatalog);
      }
    } catch (e) {
      console.warn("catalog init", e);
    }

    ready = true;
    while (waiters.length) waiters.shift()(aladin);
    return aladin;
  }

  function getView() {
    if (!aladin) return { ...BOOT };
    let ra = BOOT.ra;
    let dec = BOOT.dec;
    let fov = BOOT.fov;
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
    return { ra: Number(ra), dec: Number(dec), fov: Number(fov) };
  }

  function goto(view, { hard = false } = {}) {
    if (!aladin || !view) return;
    try {
      if (hard && typeof aladin.gotoRaDec === "function") {
        aladin.gotoRaDec(view.ra, view.dec);
      }
      if (view.fov != null && typeof aladin.setFov === "function" && hard) {
        aladin.setFov(view.fov);
      }
    } catch (e) {
      console.warn("goto", e);
    }
  }

  function glideStep(target, throttle = 0.35) {
    const cur = getView();
    if (!aladin || !target) return { ...cur, distDeg: 0 };

    const t = Math.max(0, Math.min(1, throttle));
    const maxStep = 0.08 + t * 0.55;
    const dRa = wrapDeltaRa(target.ra - cur.ra);
    const dDec = target.dec - cur.dec;
    const dist = Math.hypot(dRa * Math.cos((cur.dec * Math.PI) / 180), dDec);

    let nRa = cur.ra;
    let nDec = cur.dec;
    if (dist > 1e-5) {
      const step = Math.min(maxStep, dist);
      const u = step / dist;
      nRa = cur.ra + dRa * u;
      nDec = cur.dec + dDec * u;
      nRa = ((nRa % 360) + 360) % 360;
      nDec = Math.max(-90, Math.min(90, nDec));
    }

    const tFov = target.fov ?? cur.fov;
    const nFov = cur.fov + (tFov - cur.fov) * (0.04 + t * 0.08);

    try {
      if (typeof aladin.gotoRaDec === "function") aladin.gotoRaDec(nRa, nDec);
      if (typeof aladin.setFov === "function") aladin.setFov(nFov);
    } catch {
      /* soft fail */
    }

    return { ra: nRa, dec: nDec, fov: nFov, distDeg: dist };
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

  /**
   * Refresh sky markers from story/personal/mystery source lists.
   * @param {{ra,dec,name,kind}[]} sources
   * @param {{ra,dec,name}[]} personal
   */
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
        const src = makeSource(s.ra, s.dec, s.name || "");
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
    setOverlays,
    get aladin() {
      return aladin;
    },
    get ready() {
      return ready;
    },
  };
}
