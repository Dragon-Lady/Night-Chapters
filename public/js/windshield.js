/**
 * Windshield — Aladin Lite as the cockpit glass.
 * Real sky spine. Free glide. No military overlay.
 */

const BOOT = {
  // M42 region — comfort default for Night Chapters
  ra: 83.8221,
  dec: -5.3911,
  fov: 3.5,
  survey: "P/DSS2/color",
};

export function createWindshield(containerSelector = "#aladin-lite-div") {
  let aladin = null;
  let ready = false;
  const waiters = [];

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

    // Prefer explicit goto after construct (Observatory pattern)
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

  /**
   * Soft step toward target view (one frame of glide).
   * @returns {{ ra, dec, fov, distDeg }}
   */
  function glideStep(target, throttle = 0.35) {
    const cur = getView();
    if (!aladin || !target) return { ...cur, distDeg: 0 };

    const t = Math.max(0, Math.min(1, throttle));
    // Max degrees of sky per frame at full throttle (gentle)
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

  return {
    boot,
    whenReady,
    getView,
    goto,
    glideStep,
    get aladin() {
      return aladin;
    },
    get ready() {
      return ready;
    },
  };
}
