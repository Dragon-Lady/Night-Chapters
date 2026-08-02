/**
 * Night Chapters — core game loop (complete)
 *
 * BOOT → MENU → FLIGHT ⇄ ARRIVE ⇄ MYSTERY ⇄ REST → CLOSEOUT → MENU
 *
 * FLIGHT: throttle + steer (A/D · ←/→); spoon fuel drains while moving.
 * REST: Space / Rest button — throttle 0, spoons recover, no failure.
 * MYSTERY: drift glows mid-path + chapter mystery; P claims → personal pin + score.
 *
 * Wonder-first. Vanilla JS. Not a military sim.
 */

/* NC_BUILD 1.7.64 — gumdrop markers spread; unvisited ribbon */
import { loadNight, listNights } from "./nights.js?v=1.7.64";
import { createWindshield } from "./windshield.js?v=1.7.64";
import {
  createFlightSession,
  currentWaypoint,
  markArrived,
  setThrottle,
  tickSpoons,
  fuelOfNight,
  closeoutLines,
  nearestDriftMystery,
  claimDriftMystery,
  claimChapterMystery,
  recordFreePin,
  discoveryCount,
  catalogSourcesForNight,
  maybeApplyPerfectBonus,
  scoreTable,
  skyDistanceDeg,
  selectSensorTarget,
  dedupeSensorPool,
  shouldSoftStealRibbon,
  pickClosestSensorContact,
  firstUnvisitedStoryPin,
  unvisitedStoryPins,
  isStoryRibbonComplete as ribbonCompleteFromVisited,
  syncPinIndexToUnvisited,
  ARRIVE_DEG,
  MYSTERY_NEAR_DEG,
  MYSTERY_NOTICE_DEG,
  mysteryRadiiForFov,
  SCORE,
} from "./flight.js?v=1.7.64";
import {
  claimPin,
  loadPersonalPins,
  scrubStaleChapterPins,
  renderPersonalPinList,
  saveBestScore,
  loadBestScore,
  saveChapterBest,
  getChapterBest,
  loadChapterBests,
} from "./pins.js?v=1.7.64";
import {
  recordChapterComplete,
  isChapterCompleted,
  buildReflection,
  saveReflection,
  recordNamingEvent,
  renderProgressSummary,
} from "./progress.js?v=1.7.64";
import { createAudio } from "./audio.js?v=1.7.64";
import {
  exportPinsFile,
  exportReflectionsFile,
  exportFullHouseFile,
  shareSoftSummary,
  copyToClipboard,
  toJson,
  buildExportPayload,
} from "./export.js?v=1.7.64";
import {
  setKeyHandler,
  setKeyUpHandler,
  rebindKeys,
  bindKeys,
  focusShell,
  ensureKeySink,
} from "./keys.js?v=1.7.64";

/** Scanner + craft HUD build — must match index.html / main.js cache bust */
export const CORE_LOOP_VERSION = "1.7.64";
export const NC_SENSOR_BUILD = "1.7.64-wide-fov";

const State = {
  BOOT: "BOOT",
  MENU: "MENU",
  FLIGHT: "FLIGHT",
  ARRIVE: "ARRIVE",
  MYSTERY: "MYSTERY",
  REST: "REST",
  CLOSEOUT: "CLOSEOUT",
};

const ACTIVE = new Set([
  State.FLIGHT,
  State.ARRIVE,
  State.MYSTERY,
  State.REST,
]);

export function startGame(ui) {
  const windshield = createWindshield("#sky-canvas");
  const audio = createAudio();
  let night = null;
  let session = null;
  let selectedNightId = "soft-rainy-hold";
  let state = State.BOOT;
  /** State to return to when leaving REST */
  let resumeState = State.FLIGHT;
  let raf = 0;
  let sitTimer = null;
  let lastTs = 0;
  let lowSpoonsWhispered = false;
  let mysteryHumAt = 0;

  const el = {
    whisper: () => document.getElementById("whisper"),
    state: () => document.getElementById("state-chip"),
    heading: () => document.getElementById("heading-bug"),
    throttle: () => document.getElementById("throttle"),
    fuel: () => document.getElementById("fuel"),
    fuelBar: () => document.getElementById("fuel-bar"),
    score: () => document.getElementById("score"),
    discovered: () => document.getElementById("discovered"),
    best: () => document.getElementById("best-score"),
    chapterBest: () => document.getElementById("chapter-best"),
    chapters: () => document.getElementById("chapter-list"),
    pins: () => document.getElementById("pin-list"),
    housePins: () => document.getElementById("house-pins"),
    progressSummary: () => document.getElementById("progress-summary"),
    reflection: () => document.getElementById("reflection-screen"),
    reflectionBody: () => document.getElementById("reflection-body"),
    reflectionScore: () => document.getElementById("reflection-score"),
    instruments: () => document.querySelector(".instruments"),
    navLog: () => document.getElementById("nav-log"),
    btnBegin: () => document.getElementById("btn-begin"),
    btnNext: () => document.getElementById("btn-next"),
    btnSkip: () => document.getElementById("btn-skip"),
    btnRest: () => document.getElementById("btn-rest"),
    btnEnd: () => document.getElementById("btn-end"),
    btnPin: () => document.getElementById("btn-pin"),
    btnReflectionDone: () => document.getElementById("btn-reflection-done"),
    btnReflectionAgain: () => document.getElementById("btn-reflection-again"),
    btnMute: () => document.getElementById("btn-mute"),
    btnHelp: () => document.getElementById("btn-help"),
    btnExport: () => document.getElementById("btn-export"),
    helpScreen: () => document.getElementById("help-screen"),
    exportScreen: () => document.getElementById("export-screen"),
    btnHelpClose: () => document.getElementById("btn-help-close"),
    btnExportClose: () => document.getElementById("btn-export-close"),
    btnExportPins: () => document.getElementById("btn-export-pins"),
    btnExportReflections: () => document.getElementById("btn-export-reflections"),
    btnExportFull: () => document.getElementById("btn-export-full"),
    btnExportCopy: () => document.getElementById("btn-export-copy"),
    btnExportShare: () => document.getElementById("btn-export-share"),
  };

  function syncMuteButton() {
    const b = el.btnMute();
    if (!b) return;
    b.textContent = audio.muted ? "🔇 Sound off" : "🔊 Sound on";
    b.setAttribute("aria-pressed", audio.muted ? "true" : "false");
  }

  function chapterMood() {
    return night?.sky?.mood || night?.weather_mood || "rain";
  }

  /**
   * Panel whisper + optional on-glass fade (canvas).
   * @param {string} text
   * @param {{ glass?: boolean, holdMs?: number, kind?: string }} [opts]
   *   glass defaults true during active flight so passage hooks appear on sky.
   */
  function setWhisper(text, opts = {}) {
    const msg = text == null ? "" : String(text);
    const w = el.whisper();
    if (w) w.textContent = msg;
    const compact = document.getElementById("whisper-compact");
    if (compact) {
      compact.textContent = msg;
      // show compact line only while panel is collapsed
      compact.hidden = !document.body.classList.contains("panel-collapsed");
    }
    // On-glass: default on while flying so hooks aren't panel-only
    const flying =
      state === State.FLIGHT ||
      state === State.MYSTERY ||
      state === State.ARRIVE ||
      state === State.REST;
    const wantGlass = opts.glass !== undefined ? !!opts.glass : flying;
    if (wantGlass && msg.trim()) {
      const kind =
        opts.kind ||
        (msg.includes("✧") || /heart|drift|spark/i.test(msg)
          ? "drift"
          : msg.includes("✦") || /chapter|porch/i.test(msg)
            ? "mystery"
            : "soft");
      const glassOpts = {
        holdMs: opts.holdMs ?? 12000,
        fadeIn: opts.fadeIn ?? 0.5,
        fadeOut: opts.fadeOut ?? 2.5,
        kind,
        // Passage hooks force onto glass; soft lines do not clobber them
        force:
          opts.forceGlass === true ||
          kind === "drift" ||
          kind === "mystery",
      };
      // Prefer windshield API; also hit DOM plate directly if canvas path is buried
      if (typeof windshield.setGlassWhisper === "function") {
        windshield.setGlassWhisper(msg, glassOpts);
      } else {
        pushGlassWhisperDomFallback(msg, kind, glassOpts.holdMs);
      }
    }
  }

  /** Fallback if windshield not ready — still show on-sky plate */
  function pushGlassWhisperDomFallback(text, kind, holdMs) {
    const el = document.getElementById("glass-whisper");
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.classList.remove("is-show", "is-soft");
    void el.offsetWidth;
    el.classList.add("is-show");
    if (kind === "soft") el.classList.add("is-soft");
    const life = (holdMs || 12000) + 2500;
    clearTimeout(pushGlassWhisperDomFallback._t);
    pushGlassWhisperDomFallback._t = setTimeout(() => {
      el.hidden = true;
      el.classList.remove("is-show");
    }, life);
  }

  function setState(next) {
    const prev = state;
    state = next;
    const chip = el.state();
    if (chip) chip.textContent = next;
    document.body.dataset.phase = next;
    windshield.setPhase?.(next);
    const list = el.chapters();
    if (list) {
      list.hidden = !(
        next === State.MENU ||
        next === State.CLOSEOUT ||
        next === State.BOOT
      );
    }
    // Auto-collapse instruments during flight so sky stays open;
    // expand again on menu / closeout for chapter pick.
    if (
      next === State.FLIGHT ||
      next === State.MYSTERY ||
      next === State.ARRIVE ||
      next === State.REST
    ) {
      if (prev === State.MENU || prev === State.CLOSEOUT || prev === State.BOOT) {
        setPanelCollapsed(true);
      }
    } else if (next === State.MENU || next === State.CLOSEOUT) {
      setPanelCollapsed(false);
    }
    // Audio phase cues
    if (next === State.REST && prev !== State.REST) {
      audio.enterRestSilence();
    } else if (prev === State.REST && next !== State.REST) {
      audio.leaveRestSilence();
    }
    if (next === State.MYSTERY && prev !== State.MYSTERY) {
      const now = performance.now();
      if (now - mysteryHumAt > 2500) {
        audio.mysteryHum();
        mysteryHumAt = now;
      }
    }
    if (next === State.CLOSEOUT || next === State.MENU) {
      audio.setWind(0);
      if (next === State.MENU) audio.stopAmbient({ fade: 1.5 });
    }
    syncButtons();
    try {
      updateFlightBar();
    } catch {
      /* defined later; ignore at early setState */
    }
  }

  function inFlightLike() {
    return (
      state === State.FLIGHT ||
      state === State.ARRIVE ||
      state === State.MYSTERY ||
      state === State.REST
    );
  }

  function syncButtons() {
    const flying = inFlightLike();
    if (el.btnBegin()) {
      el.btnBegin().disabled = !(
        state === State.MENU || state === State.CLOSEOUT
      );
    }
    if (el.btnNext()) {
      el.btnNext().disabled = !(
        state === State.FLIGHT ||
        state === State.ARRIVE ||
        state === State.MYSTERY ||
        state === State.REST
      );
    }
    if (el.btnSkip()) {
      el.btnSkip().disabled = !(
        state === State.ARRIVE || state === State.FLIGHT
      );
    }
    if (el.btnRest()) el.btnRest().disabled = !flying;
    if (el.btnEnd()) el.btnEnd().disabled = state === State.BOOT || state === State.MENU;
    if (el.btnPin()) el.btnPin().disabled = state === State.BOOT;
  }

  function refreshOverlays() {
    if (!night || !windshield.ready) return;
    // Drop pre-spread / orphan / other-chapter pins — force scrub every refresh
    let personal = loadPersonalPins();
    try {
      const scrub = scrubStaleChapterPins(night, { force: true });
      personal = scrub.pins || personal;
      // Extra filter: only current-night personal pins reach the glass
      personal = personal.filter((p) => {
        const pn = p.nightId || p.chapterId || null;
        if (pn !== night.id) return false;
        // Drop pre-spread pancake coords even if scrub missed
        if (night.id === "gumdrop-summer") {
          const ra = Number(p.view?.ra ?? p.ra);
          const dec = Number(p.view?.dec ?? p.dec);
          const stale = [
            [298.2, 7.5],
            [288, 24],
            [305, 40],
            [290.5, 28.5],
            [300, 20],
            [285, 15],
          ];
          for (const [sra, sdec] of stale) {
            const cos = Math.cos((dec * Math.PI) / 180) || 1;
            let dRa = ra - sra;
            while (dRa > 180) dRa -= 360;
            while (dRa < -180) dRa += 360;
            if (Math.hypot(dRa * cos, dec - sdec) <= 1.2) return false;
          }
        }
        return true;
      });
      try {
        window.__ncPinScrub = {
          removed: scrub.removed,
          kept: personal.length,
          rev: "gumdrop-spread-1.7.64",
          chapter: night.id,
          t: performance.now(),
        };
      } catch {
        /* ignore */
      }
    } catch {
      /* scrub optional */
    }
    windshield.setOverlays(
      catalogSourcesForNight(night, session),
      personal
    );
  }

  function renderHousePins() {
    renderPersonalPinList(el.housePins(), {
      onFly: (p) => {
        if (p.view) windshield.goto(p.view, { hard: true });
        setWhisper(`Flying to house pin: ${p.label}`);
        // leave reflection if open
        hideReflection();
      },
      onDelete: () => {
        refreshOverlays();
        setWhisper("House pin removed.");
      },
      onClear: () => {
        refreshOverlays();
        setWhisper("House pins cleared. Progress kept.");
      },
    });
  }

  function renderProgress() {
    renderProgressSummary(el.progressSummary());
  }

  function renderChapterMenu() {
    const root = el.chapters();
    if (!root) return;
    const bests = loadChapterBests();
    root.innerHTML = "";
    root.hidden = !(
      state === State.MENU ||
      state === State.CLOSEOUT ||
      state === State.BOOT
    );
    for (const c of listNights()) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `chapter-card weather-${c.weather_mood || "rain"}`;
      if (c.id === selectedNightId) card.classList.add("selected");
      const done = isChapterCompleted(c.id);
      if (done) card.classList.add("completed");
      const best = bests[c.id] || 0;
      card.innerHTML = `
        <span class="chapter-title">${done ? "✓ " : ""}${escapeHtml(c.title)}</span>
        <span class="chapter-blurb">${escapeHtml(c.blurb || c.tone || "")}</span>
        <span class="chapter-meta">${done ? "flown · " : ""}best ${best} · ${escapeHtml(c.weather_mood || "")}</span>
      `;
      card.addEventListener("click", () => selectChapter(c.id));
      root.appendChild(card);
    }
  }

  function showReflection(reflection) {
    const screen = el.reflection();
    const body = el.reflectionBody();
    const scoreEl = el.reflectionScore();
    if (!screen || !body) return;
    body.innerHTML = reflection.lines
      .map((line) => {
        const html = escapeHtml(line).replace(
          /\*\*(.+?)\*\*/g,
          "<strong>$1</strong>"
        );
        return `<p class="reflection-line">${html}</p>`;
      })
      .join("");
    if (scoreEl) {
      scoreEl.textContent = String(reflection.score);
    }
    screen.hidden = false;
    screen.setAttribute("aria-hidden", "false");
    screen.removeAttribute("inert");
    screen.style.pointerEvents = "auto";
    screen.style.display = "grid";
    screen.style.visibility = "visible";
    document.body.classList.add("reflection-open");
  }

  function hideReflection() {
    const screen = el.reflection();
    if (!screen) return;
    screen.hidden = true;
    screen.setAttribute("aria-hidden", "true");
    screen.setAttribute("inert", "");
    screen.style.pointerEvents = "none";
    document.body.classList.remove("reflection-open");
    resumeFlightInput("reflection-close");
  }

  function setModalOpen(screen, show, resumeReason) {
    if (!screen) return;
    screen.hidden = !show;
    screen.setAttribute("aria-hidden", show ? "false" : "true");
    if (show) {
      screen.removeAttribute("inert");
      screen.style.pointerEvents = "auto";
      screen.style.display = "grid";
      screen.style.visibility = "visible";
    } else {
      screen.setAttribute("inert", "");
      screen.style.pointerEvents = "none";
      // Force layout drop even if [hidden] is fought by extensions/CSS
      screen.style.display = "none";
      screen.style.visibility = "hidden";
      resumeFlightInput(resumeReason);
    }
  }

  function showHelp(show = true) {
    setModalOpen(el.helpScreen(), show, "help-close");
  }

  function showExport(show = true) {
    setModalOpen(el.exportScreen(), show, "export-close");
  }

  /** Click / focus the glass → close overlays and reclaim flight controls */
  function onSkyPointer(e) {
    // Ignore flight-bar buttons (they handle themselves)
    if (e.target && e.target.closest && e.target.closest("#flight-bar")) {
      return;
    }
    // Dismiss any leftover modal layer that still covers the map
    const help = el.helpScreen();
    const exp = el.exportScreen();
    if (help && !help.hidden) showHelp(false);
    if (exp && !exp.hidden) showExport(false);
    if (document.body.classList.contains("reflection-open")) {
      hideReflection();
    }
    // Ensure stage is the keyboard home
    try {
      const stage = document.getElementById("sky-stage");
      if (stage && typeof stage.focus === "function") {
        stage.focus({ preventScroll: true });
      }
    } catch {
      /* ignore */
    }
    resumeFlightInput("sky-click");
    // Soft nudge: if parked mid-flight with thr=0, whisper how to go
    if (session && ACTIVE.has(state) && Number(session.throttle || 0) < 0.04) {
      setWhisper("Glass focus on — W throttle · A/D steer · Space rest.");
    }
  }

  const THROTTLE_STEP = 0.1;
  let lastThrottleKeyAt = 0;
  /** Held steer keys — continuous yaw while flying */
  const heldSteer = { left: false, right: false };

  function syncSteerInput() {
    const v = (heldSteer.right ? 1 : 0) - (heldSteer.left ? 1 : 0);
    windshield.setSteer?.(v);
  }

  function clearSteer() {
    heldSteer.left = false;
    heldSteer.right = false;
    windshield.setSteer?.(0);
    windshield.clearKeySteer?.();
  }

  /** After panel/menu/prompt: unstick focus so W/A/S/D reach the glass again */
  function resumeFlightInput(reason = "") {
    clearSteer();
    const ae = document.activeElement;
    if (
      ae &&
      ae !== document.body &&
      ae.id !== "nc-key-sink" &&
      ae.closest &&
      (ae.closest("#instruments, #instruments-body, .instruments") ||
        ae.tagName === "BUTTON" ||
        ae.tagName === "INPUT" ||
        ae.tagName === "A")
    ) {
      // Don't steal focus mid-slider drag
      if (!(ae.tagName === "INPUT" && ae.type === "range" && reason === "pointer")) {
        try {
          ae.blur();
        } catch {
          /* ignore */
        }
      }
    }
    // Hidden panel must not keep focus (display:none traps keys in some browsers)
    if (document.body.classList.contains("panel-collapsed")) {
      const body = document.getElementById("instruments-body");
      if (body && document.activeElement === body) {
        try {
          body.blur();
        } catch {
          /* ignore */
        }
      }
    }
    armKeyboard(reason || "resume");
    if (session && (state === State.FLIGHT || state === State.MYSTERY || state === State.ARRIVE)) {
      // Parked (thr≈0) is not REST — allow free flight again
      if (session.throttle >= 0.04) session.resting = false;
    }
  }

  /**
   * Next ribbon pin for radar HUD only.
   * NEVER turns the ship (soft-face removed; hard snap forbidden in flight).
   * Player A/D + W own all motion; pickSensorTarget is display guidance only.
   */
  function faceCurrentWaypoint() {
    if (!night || !session) return;
    const wp = currentWaypoint(night, session);
    // Stash desired bearing for debug HUD — never snap / assist heading
    if (wp?.view && typeof windshield.faceToward === "function") {
      windshield.faceToward(wp.view.ra, wp.view.dec, { hard: false });
    }
    try {
      windshield.clearSoftFace?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {number} delta  + up / − down
   * @param {{ repeat?: boolean }} [opts]
   */
  /**
   * Push current throttle into the sky immediately (don't wait for rAF).
   * Called from W/S keys, slider input, and flight-bar buttons.
   */
  function applyThrottleToSky(reason = "") {
    if (!session || !night || !windshield.ready) return;
    if (state === State.MENU || state === State.BOOT || state === State.CLOSEOUT) {
      return;
    }
    const thr = Number(session.throttle || 0);
    let step = null;
    if (thr > 0.04 && !session.resting && session.spoons > 0.02) {
      if (state === State.REST) leaveRestIfNeeded();
      if (state === State.ARRIVE) setState(State.FLIGHT);
      const wp = currentWaypoint(night, session);
      const target = wp?.view || null;
      if (typeof windshield.throttleKick === "function") {
        step = windshield.throttleKick(target, thr, 1 / 24);
      } else {
        step = windshield.glideStep(target, thr, 1 / 24);
      }
    } else {
      windshield.fx?.setThrottle(0);
      windshield.fx?.setCamDelta?.(0, 0, 1 / 60, 0);
      windshield.setMotionBlur?.(0);
    }
    try {
      window.__ncThrottle = {
        thr,
        state,
        reason,
        cam: windshield.cam,
        step,
        path: window.__ncCam?.path,
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
  }

  function nudgeThrottle(delta, opts = {}) {
    // Allow throttle while a flight session is open (FLIGHT/MYSTERY/ARRIVE/REST)
    if (!session) return;
    if (
      state === State.MENU ||
      state === State.BOOT ||
      state === State.CLOSEOUT
    ) {
      return;
    }
    // Key-repeat can fire ~30/s — rate-limit for controllable glide
    const now = performance.now();
    if (opts.repeat && now - lastThrottleKeyAt < 80) return;
    lastThrottleKeyAt = now;

    const step = opts.repeat ? THROTTLE_STEP * 0.5 : THROTTLE_STEP;
    const signed = delta > 0 ? step : delta < 0 ? -step : 0;
    if (!signed) return;

    const slider = el.throttle();
    const cur = Number(session.throttle || 0);
    const next = Math.max(0, Math.min(1, Math.round((cur + signed) * 100) / 100));
    if (slider) slider.value = String(next);
    setThrottle(session, next);
    if (session.throttle > 0.04) session.resting = false;
    if (state === State.REST && next > 0.04) leaveRestIfNeeded();
    if (state === State.ARRIVE && next > 0.04) setState(State.FLIGHT);
    try {
      audio.setWind(session.resting ? 0 : next);
    } catch {
      /* ignore */
    }
    windshield.fx?.setThrottle(session.resting ? 0 : next);
    applyThrottleToSky("nudge");
    renderMeters();
    updateFlightBar();
  }

  function setPanelCollapsed(collapsed) {
    document.body.classList.toggle("panel-collapsed", !!collapsed);
    const btn = document.getElementById("btn-panel-toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.textContent = collapsed ? "Show panel ▴" : "Hide panel ▾";
      btn.title = collapsed
        ? "Expand choose-a-night / instruments"
        : "Collapse panel for full sky";
    }
    // Closing the panel: release focus from instruments so keys drive the sky again
    if (collapsed) {
      requestAnimationFrame(() => resumeFlightInput("panel-close"));
    }
    // Aladin / FX need a resize after layout change
    requestAnimationFrame(() => {
      try {
        window.dispatchEvent(new Event("resize"));
      } catch {
        /* ignore */
      }
      windshield.fx?.resize?.();
    });
  }

  function togglePanel() {
    setPanelCollapsed(!document.body.classList.contains("panel-collapsed"));
  }

  function selectChapterByIndex(i) {
    const nights = listNights();
    if (!nights[i]) return;
    if (state !== State.MENU && state !== State.CLOSEOUT && state !== State.BOOT) {
      setWhisper("Pick chapters from the menu after closeout.");
      return;
    }
    selectChapter(nights[i].id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function selectChapter(id) {
    selectedNightId = id;
    night = await loadNight(id);
    sensorLock = null;
    lastSensorPingAt = 0;
    windshield.applyChapterSky?.(night);
    audio.setChapterMood(chapterMood());
    audio.uiTap();
    const first = night.pins?.[0]?.view;
    if (first && windshield.ready) windshield.goto(first, { hard: true });
    refreshOverlays();
    renderChapterMenu();
    if (el.chapterBest()) {
      el.chapterBest().textContent = String(getChapterBest(id));
    }
    const T = scoreTable(night);
    setWhisper(
      `${night.title} — ${night.blurb || night.tone || ""}. Score: story +${T.STORY_PIN}, drift +${T.DRIFT_MYSTERY}, chapter +${T.CHAPTER_MYSTERY}. Begin when ready.`
    );
    renderMeters();
  }

  function renderPins() {
    const ul = el.pins();
    if (!ul || !night) return;
    ul.innerHTML = "";
    night.pins.forEach((p, i) => {
      const li = document.createElement("li");
      li.textContent = p.label;
      if (session?.fixesVisited.includes(p.id)) li.classList.add("done");
      if (
        session &&
        i === session.pinIndex &&
        state !== State.CLOSEOUT &&
        !session.fixesVisited.includes(p.id)
      ) {
        li.classList.add("current");
      }
      // after markArrived, pinIndex already advanced — highlight last arrived briefly via done
      ul.appendChild(li);
    });
    for (const m of session?.driftMysteries || []) {
      const li = document.createElement("li");
      li.classList.add("drift");
      li.textContent = m.claimed
        ? `✧ ${m.claimed_label || "found"}`
        : m.noticed
          ? "✧ drift glow"
          : "✧ ?";
      if (m.claimed) li.classList.add("done");
      if (session?.activeDriftId === m.id) li.classList.add("current");
      ul.appendChild(li);
    }
    if (night.mystery) {
      const li = document.createElement("li");
      li.textContent = session?.mysteryClaimed
        ? `✦ ${night.mystery.claimed_label || night.mystery.label || "mystery"}`
        : night.mystery.claimed_label || night.mystery.label
          ? `✦ ${night.mystery.claimed_label || night.mystery.label}`
          : "✦ chapter mystery";
      if (session?.mysteryClaimed) li.classList.add("done");
      if (
        session &&
        isStoryRibbonComplete() &&
        !session.mysteryClaimed
      ) {
        li.classList.add("current");
      }
      ul.appendChild(li);
    }
  }

  function renderMeters() {
    const wp = night && session ? currentWaypoint(night, session) : null;
    if (el.heading()) {
      let h = "—";
      const bearing =
        typeof windshield.getHeading === "function"
          ? Math.round(
              ((windshield.getHeading() % 360) + 360) % 360
            )
          : null;
      // Nav compass card (0=N … 270=W)
      const cards = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      const card =
        bearing != null
          ? cards[Math.round(bearing / 45) % 8]
          : "";
      const br =
        bearing != null ? ` · hdg ${bearing}° ${card}` : "";
      if (session?.activeDriftId) {
        const d = session.driftMysteries.find(
          (m) => m.id === session.activeDriftId
        );
        h = d ? `✧ ${d.claimed_label || "drift glow"}${br}` : h;
      } else if (wp) {
        const label =
          wp.kind === "mystery" ? "✦ chapter mystery" : wp.pin.label;
        h = `${label}${br}`;
      } else if (bearing != null) {
        h = `hdg ${bearing}° ${card}`;
      }
      el.heading().textContent = h;
    }
    if (session) {
      const f = fuelOfNight(session);
      if (el.fuel()) {
        el.fuel().textContent = `${Math.round(f * 100)}% spoons${
          state === State.REST || session.resting ? " · resting" : ""
        }`;
      }
      if (el.fuelBar()) {
        el.fuelBar().style.width = `${Math.round(f * 100)}%`;
        el.fuelBar().dataset.level =
          f < 0.2 ? "low" : f < 0.5 ? "mid" : "ok";
      }
      if (el.score()) el.score().textContent = String(session.score);
      if (el.discovered()) {
        el.discovered().textContent = String(discoveryCount(session));
      }
      if (el.navLog()) {
        el.navLog().textContent =
          session.navLog.slice(-6).join("\n") ||
          "Nav log empty — soft start.";
      }
    } else if (el.score()) {
      el.score().textContent = "0";
    }
    if (el.best()) el.best().textContent = String(loadBestScore());
    if (el.chapterBest()) {
      el.chapterBest().textContent = String(
        getChapterBest(session?.nightId || selectedNightId)
      );
    }
    renderPins();
    if (state === State.MENU || state === State.CLOSEOUT) {
      renderChapterMenu();
    }
  }

  // ——— REST ———
  function enterRest({ reason = "manual" } = {}) {
    if (!session || !ACTIVE.has(state) && state !== State.REST) {
      if (!session || state === State.CLOSEOUT || state === State.MENU) return;
    }
    if (state !== State.REST) {
      resumeState =
        state === State.REST
          ? resumeState
          : state === State.BOOT || state === State.MENU
            ? State.FLIGHT
            : state;
    }
    setThrottle(session, 0);
    session.resting = true; // intentional REST — not mere parked throttle
    if (el.throttle()) el.throttle().value = "0";
    clearSteer();
    windshield.setMotionBlur?.(0);
    windshield.fx?.setThrottle(0);
    audio.setWind(0);
    setState(State.REST);
    if (reason === "empty") {
      setWhisper(
        "Spoons empty — rest in the glass. No failure. Recovery is the play."
      );
    } else {
      setWhisper("Rest. Spoons recover. Space or throttle to fly again.");
    }
  }

  function leaveRestIfNeeded() {
    if (state !== State.REST || !session) return;
    if (session.spoons <= 0.02) return;
    if (session.throttle > 0.04) {
      session.resting = false;
      const next =
        resumeState === State.REST || resumeState === State.CLOSEOUT
          ? State.FLIGHT
          : resumeState === State.ARRIVE
            ? State.FLIGHT
            : resumeState;
      setState(next);
      resumeFlightInput("leave-rest");
      setWhisper(
        next === State.MYSTERY
          ? "Back to the glow… A/D steer · W throttle."
          : "Glide resumes — A/D steer · W throttle."
      );
    }
  }

  // ——— rAF tick ———
  function tick(ts) {
    raf = requestAnimationFrame(tick);
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 1 / 60;
    lastTs = ts;

    if (!session || !night || !windshield.ready) return;
    if (!ACTIVE.has(state)) {
      renderMeters();
      return;
    }

    // Spoon fuel: drain on glide, recover on rest
    const before = session.spoons;
    tickSpoons(session, dt);

    if (session.spoons <= 0.02 && before > 0.02) {
      if (el.throttle()) el.throttle().value = "0";
      enterRest({ reason: "empty" });
      lowSpoonsWhispered = true;
    } else if (
      session.spoons < 0.25 &&
      !session.resting &&
      state !== State.REST &&
      !lowSpoonsWhispered
    ) {
      setWhisper("Spoons running low — Rest or Space to recover.");
      lowSpoonsWhispered = true;
    } else if (session.spoons > 0.4) {
      lowSpoonsWhispered = false;
    }

    // Keep slider synced when auto-rest clamps throttle
    if (
      (session.resting || state === State.REST) &&
      el.throttle() &&
      Number(el.throttle().value) > 0.04
    ) {
      el.throttle().value = String(session.throttle);
    }

    // REST: spoons recover; throttle-up leaves rest; A/D still yaws the glass
    if (state === State.REST) {
      windshield.fx?.setThrottle(0);
      syncSteerInput(); // look around while resting
      leaveRestIfNeeded();
      // Drift/chapter still notice while resting (cam can sit on a glow)
      const restView = windshield.getView?.() || null;
      if (restView) evaluateProximity(restView);
      if (state === State.REST) {
        renderMeters();
        updateFlightBar();
        return;
      }
    }

    // ARRIVE: short park — but throttle-up continues toward next pin
    if (state === State.ARRIVE) {
      if (session.throttle > 0.08 && session.spoons > 0.02 && !session.resting) {
        // Auto-depart: user is flying, don't strand them on a whisper
        setState(State.FLIGHT);
        setWhisper("Glide on — heading continues.");
      } else {
        windshield.fx?.setThrottle(0);
        windshield.setMotionBlur?.(0);
        // Allow noticing glows while docked on a story pin
        const arrView = windshield.getView?.() || null;
        if (arrView) evaluateProximity(arrView);
        renderMeters();
        updateFlightBar();
        return;
      }
    }

    // FLIGHT + MYSTERY (+ ARRIVE fallthrough): steer (A/D) + throttle (W/S)
    // Parked (thr≈0) is free flight, not locked — only intentional REST blocks glide.
    const thr = Number(session.throttle || 0);
    syncSteerInput();
    const flightActive =
      state === State.FLIGHT ||
      state === State.MYSTERY ||
      state === State.ARRIVE;
    // Intentionally resting (Space) blocks auto-glide; steer still via paintLoop
    const intentionalRest = state === State.REST || !!session.resting;
    // Match windshield THR_MOVE_DEADZONE (~0.045) — tiny thr must not crawl
    const canGlide =
      flightActive && !intentionalRest && thr > 0.045 && session.spoons > 0.02;
    const steering =
      flightActive && (heldSteer.left || heldSteer.right);

    if (canGlide || steering) {
      const wp = currentWaypoint(night, session);
      // Every rAF: report cam; paintLoop is sole integrator for yaw/throttle motion
      // CRITICAL: never invent thr from steer — that caused random crawl (v1.7.52–54).
      const thrForSky = canGlide ? thr : 0;
      const step = windshield.glideStep(wp?.view || null, thrForSky, dt);

      if (canGlide) {
        // Don't abort the whole frame before proximity — closeout after checks
        if (wp) {
          windshield.fx?.setThrottle(thr);
          try {
            audio.setWind(thr);
          } catch {
            /* ignore */
          }
          if (typeof ui?.onGlide === "function") ui.onGlide(step, wp);

          // Story pin arrival still uses heading-bug distance
          if (step.distDeg < ARRIVE_DEG && wp.kind === "pin") {
            onArrivePin(wp);
          }
        }
      } else {
        // Steer-only: yaw without translation. thr stays 0 on the glass.
        windshield.fx?.setThrottle(0);
        windshield.setMotionBlur?.(0);
      }
    } else if (flightActive) {
      windshield.fx?.setThrottle(session?.throttle || 0);
      // Even at idle throttle, clear cam velocity so streaks stop
      if (thr <= 0.04) {
        windshield.fx?.setCamDelta?.(0, 0, dt, 0);
        windshield.setMotionBlur?.(0);
      }
      try {
        audio.setWind(intentionalRest ? 0 : session?.throttle || 0);
      } catch {
        /* ignore */
      }
    }

    // Always cam-centered (not heading-bug). Use live getView so paintLoop
    // motion and free-flight both count for Drift spark / Rain glow.
    const live = windshield.getView?.() || null;
    if (live) evaluateProximity(live);

    // Closeout only after proximity had a chance this frame
    if (
      canGlide &&
      !currentWaypoint(night, session) &&
      state !== State.CLOSEOUT
    ) {
      beginCloseout();
      return;
    }

    renderMeters();
    updateFlightBar();
  }

  /** Truncate on word boundary only (never mid-word → misreads like “sewers”). */
  function shortHouseLabel(s, max = 20) {
    const t = String(s || "").trim();
    if (!t) return "";
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    const base = sp > 6 ? cut.slice(0, sp) : cut;
    return `${base}…`;
  }

  /** Soft sensor ping pacing (ms since last cue) */
  let lastSensorPingAt = 0;
  /**
   * Sticky sensor lock (hysteresis). Prevents pointer thrash when several
   * markers sit in a cluster (e.g. Altair porch neighborhood).
   * { ra, dec, label, kind, distDeg } | null
   */
  let sensorLock = null;

  /**
   * Story ribbon complete = every pin is in fixesVisited (arrived / skipped / begin).
   * Do NOT use pinIndex alone — Skip used to advance pinIndex past unlit pins and
   * free-cruise then looped found drifts while Lantern stayed dark.
   */
  function isStoryRibbonComplete() {
    return ribbonCompleteFromVisited(night, session);
  }

  /**
   * Forward scanner (v1.7.64 ribbon-guided + local approach steal).
   * Guided default: first UNVISITED story pin (Porch → Lantern → Dragon).
   * Soft-steal: candy drifts / house / chapter glow light radar when close
   * (even on the ribbon path) — then re-lock to story pin when you leave.
   * Free-cruise: after all story pins visited.
   * Lock is RADAR ONLY — never feeds yaw/position pull.
   */
  function pickSensorTarget(camView) {
    if (!night || !session || !camView) return null;

    const hit = (ra, dec, label, kind, ribbon, meta = {}) => {
      const r = Number(ra);
      const d0 = Number(dec);
      if (!Number.isFinite(r) || !Number.isFinite(d0)) return null;
      const distDeg = skyDistanceDeg(camView, { ra: r, dec: d0 });
      if (!Number.isFinite(distDeg)) return null;
      return {
        ra: r,
        dec: d0,
        label: String(label || "contact").slice(0, 28),
        kind: kind || "nav",
        distDeg,
        ribbon: !!ribbon,
        claimed: !!meta.claimed,
        unclaimed: !!meta.unclaimed,
        preferred: !!meta.preferred,
        catalogOnly: !!meta.catalogOnly,
        pinId: meta.pinId || null,
      };
    };

    const remaining = unvisitedStoryPins(night, session);
    const nextPin = firstUnvisitedStoryPin(night, session);
    syncPinIndexToUnvisited(night, session);
    const ribbonComplete = remaining.length === 0;
    const pinsLeft = remaining.length;
    const lastRibbonHunt = !ribbonComplete && pinsLeft <= 1;
    /** Guided until every story pin is visited/skipped */
    const ribbonGuided = !ribbonComplete;

    // Next required story pin from visited-set (not pinIndex alone)
    let ribbon = null;
    if (nextPin?.view) {
      ribbon = hit(
        nextPin.view.ra,
        nextPin.view.dec,
        nextPin.label || "next light",
        "pin",
        true,
        { pinId: nextPin.id, unclaimed: true, preferred: true }
      );
    } else if (!ribbonGuided) {
      const wp = currentWaypoint(night, session);
      if (wp?.kind === "mystery" && wp.view) {
        ribbon = hit(
          wp.view.ra,
          wp.view.dec,
          night.mystery?.claimed_label ||
            night.mystery?.label ||
            "chapter glow",
          "chapter",
          true,
          { unclaimed: !session.mysteryClaimed }
        );
      }
    }

    const chapterOk =
      typeof windshield.isChapterSensorAllowed === "function"
        ? (ra, dec) => windshield.isChapterSensorAllowed(ra, dec, night)
        : () => true;

    /** Local approach pool: drifts, house, chapter glow, candy landmarks */
    const buildLocalPool = () => {
      const pool = [];
      const seenLabels = new Set();
      const pushUnique = (c) => {
        if (!c) return;
        const key = `${c.kind}|${c.label}|${c.ra.toFixed(2)}|${c.dec.toFixed(2)}`;
        if (seenLabels.has(key)) return;
        seenLabels.add(key);
        pool.push(c);
      };

      for (const m of session.driftMysteries || []) {
        if (!m?.seed) continue;
        const claimed = !!(m.claimed || m.house_named);
        pushUnique(
          hit(
            m.seed.ra,
            m.seed.dec,
            m.claimed_label || m.label || "drift glow",
            "drift",
            false,
            { claimed, unclaimed: !claimed, preferred: true }
          )
        );
      }
      for (const hp of night.house_pins || []) {
        if (!hp?.view) continue;
        pushUnique(
          hit(
            hp.view.ra,
            hp.view.dec,
            hp.label || hp.claimed_label || "house light",
            "house",
            false,
            { claimed: true, preferred: true }
          )
        );
      }
      if (night.mystery?.seed) {
        pushUnique(
          hit(
            night.mystery.seed.ra,
            night.mystery.seed.dec,
            night.mystery.claimed_label ||
              night.mystery.label ||
              "chapter glow",
            "chapter",
            false,
            {
              unclaimed: !session.mysteryClaimed,
              claimed: !!session.mysteryClaimed,
              preferred: true,
            }
          )
        );
      }
      // Candy / rail landmarks from chapter pack (not prior-chapter ghosts)
      if (typeof windshield.listLandmarks === "function") {
        for (const L of windshield.listLandmarks() || []) {
          if (!L?.label || L.ra == null || L.ghost) continue;
          if (L.chapter && L.chapter !== night.id) continue;
          if (!chapterOk(L.ra, L.dec)) continue;
          const role = L.role || "beacon";
          // Soft-steal pool: drifts, house, chapter, and gumdrop candy beacons
          if (role === "story" || role === "pin") continue; // story via ribbon only
          if (
            night.id === "gumdrop-summer" &&
            role === "beacon" &&
            !/gumdrop|candy|sticky|warm|rail|porch/i.test(String(L.label || ""))
          ) {
            continue;
          }
          const kind =
            role === "house" || role === "drift" || role === "chapter"
              ? role
              : "beacon";
          pushUnique(
            hit(L.ra, L.dec, L.label, kind, false, {
              preferred: true,
              unclaimed: role === "drift" || role === "chapter",
            })
          );
        }
      }
      return pool;
    };

    // —— GUIDED: story pin default + soft-steal local candy/house on approach ——
    if (ribbonGuided) {
      const guide = ribbon;
      const localPool = buildLocalPool();
      const local = pickClosestSensorContact(localPool);

      let chosen = guide;
      let mode = "ribbon-guided";
      if (guide && local && shouldSoftStealRibbon(guide, local, { lastRibbonHunt })) {
        chosen = local;
        mode = "ribbon-steal";
      } else if (!guide && local) {
        chosen = local;
        mode = "ribbon-local";
      }

      // Sticky: hold approach lock while still near it; else snap back to guide
      if (sensorLock && chosen) {
        const same =
          skyDistanceDeg(sensorLock, chosen) <= 2.5 ||
          (sensorLock.label &&
            chosen.label &&
            sensorLock.label === chosen.label);
        if (!same) {
          // If sticky was a steal target still close, keep until you leave
          const stickyLocal = localPool.find(
            (c) =>
              skyDistanceDeg(sensorLock, c) <= 2.5 ||
              (sensorLock.label && c.label === sensorLock.label)
          );
          if (
            stickyLocal &&
            stickyLocal.distDeg <= 12 &&
            stickyLocal.kind !== "pin" &&
            stickyLocal.kind !== "story"
          ) {
            chosen = stickyLocal;
            mode = "ribbon-steal-hold";
          }
        }
      }

      sensorLock = chosen
        ? {
            ra: chosen.ra,
            dec: chosen.dec,
            label: chosen.label,
            kind: chosen.kind,
            distDeg: chosen.distDeg,
            mode,
            pinId: chosen.pinId || (chosen.ribbon ? nextPin?.id : null),
            ribbon: !!chosen.ribbon,
          }
        : null;

      try {
        window.__ncSensorPick = {
          build: NC_SENSOR_BUILD,
          chapter: night.id,
          mode,
          shipTurn: "none",
          ribbonComplete: false,
          pinsLeft,
          chosen: sensorLock?.label || null,
          dist: sensorLock ? +sensorLock.distDeg.toFixed(2) : null,
          ribbon: guide?.label || null,
          local: local
            ? { label: local.label, kind: local.kind, d: +local.distDeg.toFixed(2) }
            : null,
          remaining: remaining.map((p) => p.label),
          t: performance.now(),
        };
        window.__ncRibbon = {
          complete: false,
          guided: true,
          next: guide?.label || null,
          nextRa: guide?.ra ?? null,
          nextDec: guide?.dec ?? null,
          steal: mode.startsWith("ribbon-steal") ? sensorLock?.label : null,
          pinIndex: session.pinIndex,
          visited: (session.fixesVisited || []).slice(),
          remaining: remaining.map((p) => ({
            id: p.id,
            label: p.label,
            ra: p.view?.ra,
            dec: p.view?.dec,
          })),
        };
      } catch {
        /* ignore */
      }

      return sensorLock
        ? {
            ra: sensorLock.ra,
            dec: sensorLock.dec,
            label: sensorLock.label,
            kind: sensorLock.kind,
            distDeg: sensorLock.distDeg,
          }
        : null;
    }

    // —— FREE-CRUISE: ribbon complete — any chapter marker may soft-steal ——
    const pool = buildLocalPool();
    // Also include story pins (visited) for free re-visit radar
    for (const p of night.pins || []) {
      if (!p?.view) continue;
      const visited = session.fixesVisited?.includes(p.id);
      const c = hit(
        p.view.ra,
        p.view.dec,
        p.label || "pin",
        "story",
        false,
        { claimed: !!visited, unclaimed: !visited, preferred: true }
      );
      if (c) pool.push(c);
    }

    let liveHeading = null;
    try {
      liveHeading =
        typeof windshield.getHeading === "function"
          ? windshield.getHeading()
          : camView.heading;
    } catch {
      liveHeading = camView.heading;
    }

    if (sensorLock && !chapterOk(sensorLock.ra, sensorLock.dec)) {
      sensorLock = null;
    }

    const chosen = selectSensorTarget({
      ribbon: null, // free-cruise: pure closest among pool
      pool,
      prev: sensorLock,
      lastRibbonHunt: false,
      cam: camView,
      heading: liveHeading,
      chapterId: night.id,
    });

    let lock = chosen;
    if (lock && !chapterOk(lock.ra, lock.dec)) lock = null;

    sensorLock = lock
      ? {
          ra: lock.ra,
          dec: lock.dec,
          label: lock.label,
          kind: lock.kind,
          distDeg: lock.distDeg,
        }
      : null;

    if (!sensorLock) return null;

    try {
      const top = dedupeSensorPool(pool)
        .slice()
        .sort((a, b) => a.distDeg - b.distDeg)
        .slice(0, 5)
        .map((c) => ({
          label: c.label,
          kind: c.kind,
          d: +c.distDeg.toFixed(2),
        }));
      window.__ncSensorPick = {
        build: NC_SENSOR_BUILD,
        chapter: night.id,
        mode: "free-cruise",
        ribbonComplete: true,
        chosen: sensorLock.label,
        dist: +sensorLock.distDeg.toFixed(2),
        sticky: !!chosen?.sticky,
        top,
        t: performance.now(),
      };
      window.__ncRibbon = {
        complete: true,
        guided: false,
        next: null,
        pinIndex: session.pinIndex,
        visited: (session.fixesVisited || []).slice(),
      };
    } catch {
      /* ignore */
    }

    return {
      ra: sensorLock.ra,
      dec: sensorLock.dec,
      label: sensorLock.label,
      kind: sensorLock.kind,
      distDeg: sensorLock.distDeg,
    };
  }

  /**
   * Push scanner target to windshield + soft range-linked ping.
   * Hard-requires setSensorTarget (no silent no-op on missing API).
   */
  function updateNavSensor(camView) {
    if (!windshield || !camView) return;
    const flying =
      state === State.FLIGHT ||
      state === State.MYSTERY ||
      state === State.ARRIVE ||
      state === State.REST;

    if (!flying) {
      sensorLock = null;
      if (typeof windshield.setSensorTarget === "function") {
        windshield.setSensorTarget(null);
      }
      return;
    }

    const target = pickSensorTarget(camView);
    if (typeof windshield.setSensorTarget !== "function") {
      try {
        window.__ncSensor = {
          error: "setSensorTarget missing — stale windshield cache?",
          build: NC_SENSOR_BUILD,
          t: performance.now(),
        };
      } catch {
        /* ignore */
      }
      return;
    }

    if (!target) {
      windshield.setSensorTarget(null);
      return;
    }

    windshield.setSensorTarget(target);

    const d = target.distDeg;
    // Faster, clearer pings when closing / near path
    let interval = 3800;
    if (d < 6) interval = 700;
    else if (d < 12) interval = 1100;
    else if (d < 22) interval = 1700;
    else if (d < 40) interval = 2600;
    if (state === State.REST || session?.resting) interval *= 1.8;
    if (d > 70) interval = 5000;
    if (d < 0.9) interval = 1200;

    const now = performance.now();
    if (now - lastSensorPingAt >= interval) {
      lastSensorPingAt = now;
      const strength = d < 8 ? 0.9 : d < 25 ? 0.65 : 0.45;
      const closing = d < 18;
      try {
        if (typeof audio.sensorPing === "function") {
          audio.sensorPing({ strength, closing });
        }
      } catch {
        /* optional */
      }
      if (typeof windshield.sensorPingPulse === "function") {
        windshield.sensorPingPulse(strength);
      }
    }

    try {
      window.__ncSensor = {
        build: NC_SENSOR_BUILD,
        version: CORE_LOOP_VERSION,
        label: target.label,
        kind: target.kind,
        distDeg: +d.toFixed(2),
        ra: target.ra,
        dec: target.dec,
        t: now,
      };
      window.__ncBuild = CORE_LOOP_VERSION;
    } catch {
      /* ignore */
    }
  }

  /**
   * Cam-centered proximity for drift + chapter glows.
   * Drift spark landmark = drift seed (e.g. RA 180°, Dec 20° on Soft Rainy Hold).
   * Must fire whisper + nav log on passage — not visual-only.
   */
  function evaluateProximity(view) {
    if (!session || !night || !view) return;
    // Allow FLIGHT / MYSTERY; also ARRIVE/REST so a docked/resting cam still notices
    if (
      state !== State.FLIGHT &&
      state !== State.MYSTERY &&
      state !== State.ARRIVE &&
      state !== State.REST
    ) {
      return;
    }

    const ra = Number(view.ra);
    const dec = Number(view.dec);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;

    const camView = { ra, dec, fov: Number(view.fov) || 22 };
    const { noticeDeg, nearDeg } = mysteryRadiiForFov(camView.fov);

    let hot = null;
    let holdMystery = false; // stay in MYSTERY state (claimable field)
    const ribbonDone = isStoryRibbonComplete();

    // —— Drift mysteries (include house-named / already claimed) ——
    // Per-pass arm/fire (absolute °), tuned for slow ribbon-highway passes:
    //   d > FIRE  → re-arm
    //   d ≤ FIRE && armed + cooled → fire glass (force:true), disarm
    // Plus: re-arm after any +0.55° climb from closest approach (small turnaround).
    // v1.7.16 arm=2.0/fire=1.4 was too strict — loops out to ~1.5–1.9° never re-armed.
    const PASS_FIRE_DEG = 3.0;
    const PASS_COOLDOWN_MS = 1000;
    const nowPass = performance.now();

    for (const m of session.driftMysteries || []) {
      if (!m.seed) continue;
      const d = skyDistanceDeg(camView, m.seed);
      if (!Number.isFinite(d)) continue;
      if (m._passArmed === undefined) m._passArmed = true;
      const prevD = m._lastPassD;
      m._lastPassD = d;

      // Re-arm outside fire bubble (any direction)
      if (d > PASS_FIRE_DEG) {
        m._passArmed = true;
        m._centerWhispered = false;
        m._inCenter = false;
        m._minPassD = Infinity;
      }

      // Closest-approach turnaround: left the min by 0.55° while still near
      if (d < (m._minPassD ?? Infinity)) m._minPassD = d;
      if (
        prevD != null &&
        m._minPassD != null &&
        Number.isFinite(m._minPassD) &&
        d > m._minPassD + 0.55 &&
        d > 0.85
      ) {
        m._passArmed = true;
        m._centerWhispered = false;
      }

      let fired = false;
      let skipped = null;
      if (m._passArmed && d <= PASS_FIRE_DEG) {
        const cooled =
          !m._lastCenterGlassAt ||
          nowPass - m._lastCenterGlassAt >= PASS_COOLDOWN_MS;
        if (!cooled) {
          skipped = `cooldown ${Math.round(
            PASS_COOLDOWN_MS - (nowPass - (m._lastCenterGlassAt || nowPass))
          )}ms`;
        } else {
          m._passArmed = false;
          m._minPassD = d;
          m._lastCenterGlassAt = nowPass;
          m._centerWhispered = true;
          m._inCenter = true;
          fired = true;
          const displayName =
            m.claimed_label || m.label || "drift glow";
          const alreadyYours = !!m.claimed;
          const centerLine = alreadyYours
            ? `✧ “${displayName}” — ${
                m.story_hook || "the spark that ignites mine."
              }`
            : `${m.story_hook || "A soft glow…"} · Press P to name it (or keep gliding).`;

          if (!m.noticed) {
            m.noticed = true;
            session.navLog.push(
              `Noticed drift glow… (“${displayName}” · ${d.toFixed(1)}°)`
            );
            refreshOverlays();
          }
          m._passCount = (m._passCount || 0) + 1;
          session.navLog.push(
            alreadyYours
              ? `Center: “${displayName}” · house drift · pass#${m._passCount} · d=${d.toFixed(2)}°`
              : `Center: drift glow · Press P (+${session.scoreTable?.DRIFT_MYSTERY ?? 25}) · pass#${m._passCount}`
          );
          if (!alreadyYours) {
            holdMystery = true;
            session.activeDriftId = m.id;
            session.mysteryNear = true;
            if (state !== State.MYSTERY && state !== State.REST) {
              setState(State.MYSTERY);
            }
          }
          setWhisper(centerLine, {
            kind: "drift",
            forceGlass: true,
            holdMs: 12000,
          });
          try {
            windshield.setGlassWhisper?.(centerLine, {
              kind: "drift",
              holdMs: 12000,
              fadeIn: 0.4,
              fadeOut: 2.5,
              force: true,
            });
          } catch {
            /* optional */
          }
          try {
            audio.mysteryHum?.();
          } catch {
            /* optional */
          }
        }
      }

      try {
        if (
          m.id === "drift-rain-1" ||
          (m.claimed_label || "").includes("James")
        ) {
          window.__ncDriftPass = {
            id: m.id,
            d: Number(d.toFixed(3)),
            armed: !!m._passArmed,
            pass: m._passCount || 0,
            fired,
            skipped,
            fireDeg: PASS_FIRE_DEG,
            cooldownMs: PASS_COOLDOWN_MS,
            t: nowPass,
          };
        }
      } catch {
        /* ignore */
      }
    }

    // Hot target / claim field from nearest drift (UI only)
    const near = nearestDriftMystery(session, camView, { includeClaimed: true });
    if (near && near.distDeg < noticeDeg) {
      const m = near.mystery;
      const displayName = m.claimed_label || m.label || "drift glow";
      const shortName = shortHouseLabel(displayName, 20);
      const alreadyYours = !!m.claimed;
      const d = near.distDeg;
      hot = {
        ra: m.seed.ra,
        dec: m.seed.dec,
        level: d < PASS_FIRE_DEG ? "near" : "notice",
        kind: "drift",
        hint: alreadyYours
          ? d < PASS_FIRE_DEG
            ? "yours"
            : shortName
          : d < PASS_FIRE_DEG
            ? "Press P to name"
            : "drift glow",
      };
      if (!alreadyYours && d < nearDeg) {
        holdMystery = true;
        session.activeDriftId = m.id;
        session.mysteryNear = true;
        if (state === State.FLIGHT) setState(State.MYSTERY);
      }
    } else {
      if (session.activeDriftId) {
        const ad = session.driftMysteries.find(
          (x) => x.id === session.activeDriftId
        );
        if (!ad || ad.claimed) session.activeDriftId = null;
      }
      if (!session.activeDriftId) session.mysteryNear = false;
    }

    // —— Chapter mystery (Rain glow / porch light) — whisper even if house-named ——
    if (night.mystery?.seed) {
      const seed = night.mystery.seed;
      const dChap = skyDistanceDeg(camView, seed);
      const chName =
        night.mystery.claimed_label ||
        night.mystery.label ||
        "chapter glow";
      const chYours = !!session.mysteryClaimed;
      if (dChap < noticeDeg) {
        const level = dChap < nearDeg ? "near" : "notice";
        const preferChapter =
          !hot ||
          dChap <= (near?.distDeg ?? Infinity) ||
          (level === "near" && hot.level !== "near");
        if (preferChapter) {
          hot = {
            ra: seed.ra,
            dec: seed.dec,
            level,
            kind: "chapter",
            hint: chYours
              ? level === "near"
                ? "yours"
                : "porch light"
              : ribbonDone
                ? dChap < nearDeg
                  ? "Press P · chapter"
                  : "chapter glow"
                : "finish ribbon · return",
          };
        }
        if (dChap < nearDeg) {
          if (chYours) {
            // House-named chapter: still greet, no claim prompt
            if (!session._chapterNearWhispered) {
              session._chapterNearWhispered = true;
              session.navLog.push(`Center: “${chName}” · house chapter`);
              setWhisper(`✦ “${chName}” — ${night.mystery.story_hook || ""}`);
            }
          } else if (ribbonDone) {
            holdMystery = true;
            session.mysteryNear = true;
            if (preferChapter) session.activeDriftId = null;
            if (state !== State.MYSTERY && state !== State.REST) {
              setState(State.MYSTERY);
            }
            if (!session._chapterNearWhispered) {
              session._chapterNearWhispered = true;
              session.navLog.push("Center: chapter glow · Press P");
              setWhisper(
                `${night.mystery.story_hook} · Press P to claim · or keep gliding.`
              );
            }
          } else if (!session._chapterTease) {
            session._chapterTease = true;
            setWhisper(
              `✦ ${chName} — chapter mystery. Finish the story ribbon (Next / Skip pins), then return here and press P.`
            );
            session.navLog.push("Teased chapter glow (ribbon still open)");
          }
        }
      } else {
        session._chapterNearWhispered = false;
      }
    }

    // —— House pins (e.g. Seven Cisterns @ Pleiades) — only when cam is there ——
    session.housePinState = session.housePinState || {};
    let bestHouse = null;
    for (const hp of night.house_pins || []) {
      if (!hp?.view) continue;
      const d = skyDistanceDeg(camView, hp.view);
      if (!Number.isFinite(d) || d >= noticeDeg) {
        const id = hp.id || hp.label;
        if (id && session.housePinState[id]) {
          session.housePinState[id].centerWhispered = false;
        }
        continue;
      }
      if (!bestHouse || d < bestHouse.distDeg) {
        bestHouse = { hp, distDeg: d };
      }
    }
    if (bestHouse) {
      const { hp, distDeg: dH } = bestHouse;
      const hpId = hp.id || hp.label;
      const label = (hp.label || hp.claimed_label || "house light").trim();
      const st = (session.housePinState[hpId] = session.housePinState[hpId] || {
        noticed: false,
        centerWhispered: false,
      });
      // Prefer house pin hot only if closer than current drift/chapter hot
      const preferHouse =
        !hot || dH <= (near?.distDeg ?? Infinity) * 0.99;
      if (preferHouse) {
        const isNearH = dH < nearDeg;
        hot = {
          ra: hp.view.ra,
          dec: hp.view.dec,
          level: isNearH ? "near" : "notice",
          kind: "house",
          hint: isNearH ? shortHouseLabel(label, 18) : shortHouseLabel(label, 18),
        };
        // Personal house label (seven sisters, Mars, etc.)
        const placeName = label;
        const HOUSE_GLASS_MS = 12000; // match James heart / drift center hold
        const fireNotice = !st.noticed;
        const fireCenter = isNearH && !st.centerWhispered;
        // If both fire same frame (fast fly-in), only glass the *center* line once
        // so notice doesn't start a short animation then get force-replaced.
        if (fireNotice) {
          st.noticed = true;
          session.navLog.push(
            `Noticed house light… (“${placeName}” · ${dH.toFixed(1)}°)`
          );
          const noticeMsg =
            (hp.whisper_notice && String(hp.whisper_notice).trim()) ||
            `📌 “${placeName}” · glide closer.`;
          setWhisper(noticeMsg, {
            kind: "drift",
            forceGlass: !fireCenter, // panel always; glass only if not centering same tick
            holdMs: HOUSE_GLASS_MS,
            glass: !fireCenter,
          });
          if (!fireCenter) {
            try {
              windshield.setGlassWhisper?.(noticeMsg, {
                kind: "drift",
                holdMs: HOUSE_GLASS_MS,
                fadeOut: 2.8,
                force: true,
              });
            } catch {
              /* optional */
            }
          }
        }
        if (fireCenter) {
          st.centerWhispered = true;
          session.navLog.push(
            `Center: “${placeName}” · house pin · kept in the house sky`
          );
          const centerMsg =
            (hp.whisper_center && String(hp.whisper_center).trim()) ||
            `📌 “${placeName}” — kept in the house sky.`;
          setWhisper(centerMsg, {
            kind: "drift",
            forceGlass: true,
            holdMs: HOUSE_GLASS_MS,
          });
          try {
            windshield.setGlassWhisper?.(centerMsg, {
              kind: "drift",
              holdMs: HOUSE_GLASS_MS,
              fadeIn: 0.5,
              fadeOut: 2.8,
              force: true,
            });
          } catch {
            /* optional */
          }
        }
      }
    }

    // —— Story ribbon pins (incl. visited start: Home glass / Orion) ——
    // Match ribbon ramps 14°/8°. Visited start pin still glows on re-pass.
    {
      const STORY_NOTICE = Math.max(noticeDeg, 14);
      const STORY_NEAR = Math.max(nearDeg, 8);
      let bestPin = null;
      for (const p of night.pins || []) {
        if (!p?.view || p.view.ra == null) continue;
        const d = skyDistanceDeg(camView, p.view);
        if (!Number.isFinite(d) || d >= STORY_NOTICE) continue;
        if (!bestPin || d < bestPin.distDeg) bestPin = { pin: p, distDeg: d };
      }
      if (bestPin) {
        const dP = bestPin.distDeg;
        const hotD = hot
          ? skyDistanceDeg(camView, { ra: hot.ra, dec: hot.dec })
          : Infinity;
        const preferPin =
          !hot ||
          dP <= hotD * 0.98 ||
          (dP < STORY_NEAR && hot.level !== "near");
        if (preferPin) {
          hot = {
            ra: bestPin.pin.view.ra,
            dec: bestPin.pin.view.dec,
            level: dP < STORY_NEAR ? "near" : "notice",
            kind: "story",
            hint: bestPin.pin.label || "story pin",
          };
        }
      }
    }

    // —— Scenery landmarks (Altair porch, Deneb, Cass, …) ——
    // Not in night.pins / house_pins — were visual-only until v1.7.30.
    // Same 14°/8° approach; don't steal "near" claim fields (drift/chapter/house).
    {
      const LM_NOTICE = 14;
      const LM_NEAR = 8;
      if (typeof windshield.nearestLandmark === "function") {
        const hit = windshield.nearestLandmark(camView.ra, camView.dec);
        if (hit?.landmark && hit.distDeg < LM_NOTICE) {
          const dL = hit.distDeg;
          const L = hit.landmark;
          const hotD = hot
            ? skyDistanceDeg(camView, { ra: hot.ra, dec: hot.dec })
            : Infinity;
          const claimNear =
            hot &&
            hot.level === "near" &&
            (hot.kind === "drift" ||
              hot.kind === "chapter" ||
              hot.kind === "house");
          const preferLm =
            !claimNear &&
            (!hot ||
              dL <= hotD * 0.98 ||
              (dL < LM_NEAR && hot.level !== "near"));
          if (preferLm) {
            const role = L.role || "beacon";
            const kind =
              role === "story" || role === "chapter" || role === "drift" || role === "house"
                ? role
                : "beacon";
            hot = {
              ra: L.ra,
              dec: L.dec,
              level: dL < LM_NEAR ? "near" : "notice",
              kind,
              hint: L.label || "beacon",
            };
          }
        }
      }
    }

    // Leave MYSTERY when clear of every claimable field (not while REST)
    if (state === State.MYSTERY && !holdMystery) {
      session.mysteryNear = false;
      session.activeDriftId = null;
      session._chapterNearWhispered = false;
      setState(State.FLIGHT);
    }

    if (typeof windshield.setHotTarget === "function") {
      windshield.setHotTarget(hot);
    }

    // Ribbon + landmark approach intensity: pins, drifts, house, chapter,
    // AND scenery landmarks (Altair porch was missing — only in windshield list).
    let ribbonGlow = 0;
    let nearestApproach = Infinity;
    if (night) {
      const consider = (view) => {
        if (!view || view.ra == null) return;
        const d = skyDistanceDeg(camView, view);
        if (Number.isFinite(d) && d < nearestApproach) nearestApproach = d;
      };
      for (const p of night.pins || []) consider(p.view);
      for (const d of session.driftMysteries || []) {
        if (d?.seed) consider(d.seed); // claimed heart still counts
      }
      if (night.mystery?.seed) consider(night.mystery.seed);
      for (const hp of night.house_pins || []) consider(hp.view);
      // Scenery stations (Altair porch, Deneb tail, Pole hold, …)
      if (typeof windshield.nearestLandmark === "function") {
        const hit = windshield.nearestLandmark(camView.ra, camView.dec);
        if (hit?.landmark) {
          consider({ ra: hit.landmark.ra, dec: hit.landmark.dec });
        }
      }
      // 0 at 14°+, 1 at 0° — strong under ~8°
      if (nearestApproach < 14) {
        ribbonGlow = Math.pow(1 - nearestApproach / 14, 0.85);
        if (nearestApproach < 8) {
          ribbonGlow = Math.max(ribbonGlow, Math.pow(1 - nearestApproach / 8, 0.7));
        }
      }
      if (hot) ribbonGlow = Math.max(ribbonGlow, hot.level === "near" ? 0.85 : 0.55);
      if (typeof windshield.setRibbonApproach === "function") {
        windshield.setRibbonApproach(ribbonGlow);
      }
    }

    // Forward sensor: next ribbon pin / nearest glow (visual + soft ping)
    updateNavSensor(camView);

    try {
      window.__ncProximity = {
        ra: camView.ra,
        dec: camView.dec,
        fov: camView.fov,
        noticeDeg,
        nearDeg,
        driftDist: near?.distDeg ?? null,
        driftId: near?.mystery?.id ?? null,
        noticed: near?.mystery?.noticed ?? null,
        hot,
        nearestApproach:
          nearestApproach < Infinity ? +nearestApproach.toFixed(2) : null,
        ribbonGlow: +ribbonGlow.toFixed(3),
        t: performance.now(),
      };
    } catch {
      /* ignore */
    }
  }

  function onArrivePin(wp) {
    setState(State.ARRIVE);
    setWhisper(`${wp.pin.label} — ${wp.pin.note}`);
    markArrived(session, wp, night);
    // Clear sticky so radar re-aims at next unvisited (not re-lock arrived pin)
    sensorLock = null;
    const next = firstUnvisitedStoryPin(night, session);
    if (next) {
      setTimeout(() => {
        if (state === State.ARRIVE || state === State.FLIGHT) {
          setWhisper(
            `Next ribbon light: ${next.label} · RA ${Number(next.view.ra).toFixed(1)}° · Dec ${Number(next.view.dec) >= 0 ? "+" : ""}${Number(next.view.dec).toFixed(1)}° · A/D · W`
          );
        }
      }, 4500);
    }
    audio.pinChime();
    audio.setWind(0);
    windshield.setMotionBlur?.(0);
    windshield.fx?.setThrottle(0);
    refreshOverlays();
    if (wp.pin.beat === "sit") {
      clearTimeout(sitTimer);
      sitTimer = setTimeout(() => {
        if (state === State.ARRIVE) {
          setWhisper("Whenever you’re ready — Next heading, or rest.");
        }
      }, 4000);
    } else if (wp.pin.beat === "emotion_word") {
      setWhisper(
        `${wp.pin.note} (Feel one word — then Next. Optional forever.)`
      );
    }
    renderMeters();
  }

  async function boot() {
    setState(State.BOOT);
    setWhisper("Warming the glass…");
    night = await loadNight(selectedNightId);
    windshield.boot();
    windshield.whenReady(() => {
      // Keep original capture listener (first); only refresh handler + focus
      setKeyHandler(onKeyDown);
      setKeyUpHandler(onKeyUp);
      rebindKeys(); // focus shell only — does not remove capture listener
      windshield.applyChapterSky?.(night);
      setState(State.MENU);
      setWhisper(
        `Choose a night, then Begin. Best wonder: ${loadBestScore()}. Esc = menu · W/S throttle.`
      );
      refreshOverlays();
      renderHousePins();
      renderChapterMenu();
      renderProgress();
      syncMuteButton();
      if (el.btnBegin()) el.btnBegin().disabled = false;
      renderMeters();
      focusShell();
    });
    cancelAnimationFrame(raf);
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }

  function armKeyboard(reason = "") {
    bindKeys();
    setKeyHandler(onKeyDown);
    setKeyUpHandler(onKeyUp);
    ensureKeySink();
    focusShell();
    if (reason) {
      try {
        window.__ncKeys = window.__ncKeys || {};
        window.__ncKeys.lastArm = reason;
        window.__ncKeys.state = state;
        window.__ncKeys.hasSession = !!session;
      } catch {
        /* ignore */
      }
    }
  }

  function beginFlight() {
    loadNight(selectedNightId).then(async (n) => {
      night = n;
      // Clear sticky sensor from previous chapter (e.g. Soft Rainy → Gumdrop)
      sensorLock = null;
      lastSensorPingAt = 0;
      windshield.applyChapterSky?.(night);
      try {
        await audio.unlock();
      } catch {
        /* audio optional */
      }
      try {
        audio.setChapterMood(chapterMood());
        audio.startAmbient(chapterMood());
      } catch {
        /* ignore */
      }
      session = createFlightSession(night);
      session.startedAt = Date.now();
      const T = session.scoreTable || scoreTable(night);
      session.navLog.push(`Night open: ${night.title} · ${CORE_LOOP_VERSION}`);
      session.navLog.push(
        `Chapter scores: story +${T.STORY_PIN} · drift +${T.DRIFT_MYSTERY} · chapter +${T.CHAPTER_MYSTERY} · perfect +${T.PERFECT_BONUS}`
      );
      const driftN = session.driftMysteries?.length || 0;
      const namedHouse = (session.driftMysteries || []).filter(
        (m) => m.house_named && m.claimed_label
      );
      session.navLog.push(
        driftN
          ? `Drift glows armed: ${driftN}${
              namedHouse.length
                ? ` · ${namedHouse.length} house-named`
                : " · fly through ✧ · Press P"
            }`
          : "No drift glows in this night data — markers may be scenery only."
      );
      // Persist house names into nav log, journal, and house pins
      for (const m of namedHouse) {
        const line = `Named: “${m.claimed_label}” (${m.id}${
          m.named_at ? ` · ${m.named_at}` : ""
        })`;
        session.navLog.push(line);
        try {
          recordNamingEvent({
            nightId: night.id,
            nightTitle: night.title,
            glowId: m.id,
            label: m.claimed_label,
            kind: "drift",
            storyHook: m.story_hook,
            note: "Saved in Soft Rainy Hold · house name.",
          });
        } catch {
          /* journal optional */
        }
        try {
          claimPin({
            label: m.claimed_label,
            note: m.story_hook || "House-named drift glow",
            view: m.seed,
            emotion: "love",
            nightId: night.id,
            chapterTitle: night.title,
            kind: "drift",
            stableId: `house-drift:${night.id}:${m.id}`,
          });
        } catch {
          /* pin optional */
        }
      }

      // Chapter Rain glow / porch light — house-named in night JSON
      const ch = night.mystery;
      const chName = (ch?.claimed_label || ch?.label || "").trim();
      if (ch && chName && (ch.house_named || ch.claimed || session.mysteryClaimed)) {
        const chId = ch.id || "mystery-rain";
        session.navLog.push(
          `Named: “${chName}” (${chId}${ch.named_at ? ` · ${ch.named_at}` : ""} · chapter / rain glow)`
        );
        try {
          recordNamingEvent({
            nightId: night.id,
            nightTitle: night.title,
            glowId: chId,
            label: chName,
            kind: "chapter",
            storyHook: ch.story_hook || "",
            note: "Saved in Soft Rainy Hold · rain glow · house porch light.",
          });
        } catch {
          /* journal optional */
        }
        try {
          claimPin({
            label: chName,
            note: ch.story_hook || "House-named chapter glow · rain glow",
            view: ch.seed,
            emotion: "home",
            nightId: night.id,
            chapterTitle: night.title,
            kind: "chapter",
            stableId: `house-chapter:${night.id}:${chId}`,
          });
        } catch {
          /* pin optional */
        }
      }

      // Free house pins from night.house_pins (e.g. seven cisterns)
      const freeHouse = night.house_pins || [];
      session.housePinState = session.housePinState || {};
      for (const hp of freeHouse) {
        const label = (hp.label || hp.claimed_label || "").trim();
        if (!label || !hp.view) continue;
        const hpId = hp.id || `house-${label.slice(0, 24)}`;
        session.housePinState[hpId] = session.housePinState[hpId] || {
          noticed: false,
          centerWhispered: false,
        };
        // Full, exact name in nav — never use astronomical alias (e.g. Seven Sisters)
        const place = (hp.landmark || label).trim();
        session.navLog.push(
          `Named: “${label}” (${hpId}${
            hp.named_at ? ` · ${hp.named_at}` : ""
          } · house pin · ${place} · RA ${Number(hp.view.ra).toFixed(2)}° Dec ${Number(
            hp.view.dec
          ).toFixed(2)}°)`
        );
        try {
          recordNamingEvent({
            nightId: night.id,
            nightTitle: night.title,
            glowId: hpId,
            label,
            kind: hp.kind || "personal",
            storyHook: hp.note || "",
            note: `Saved in Soft Rainy Hold · house_pins · ${place}.`,
          });
        } catch {
          /* journal optional */
        }
        try {
          // Overwrite any stale localStorage pin that still said “Seven Sisters”
          claimPin({
            label,
            note: hp.note || label,
            view: { ...hp.view, name: label },
            emotion: hp.emotion || "home",
            nightId: night.id,
            chapterTitle: night.title,
            kind: hp.kind || "personal",
            stableId: `house-pin:${night.id}:${hpId}`,
          });
        } catch {
          /* pin optional */
        }
      }
      // Do NOT delayed-whisper a single house name at Begin — it painted
      // “Seven Cisterns · kept in the house sky” while flying James’s heart.
      // Names live in nav log; on-glass whisper is position-based only.
      lowSpoonsWhispered = false;
      resumeState = State.FLIGHT;
      // Start fully parked — any residual thr felt like random crawl after soft-face kill
      const t0 = 0;
      if (el.throttle()) el.throttle().value = "0";
      setThrottle(session, t0);
      windshield.fx?.setThrottle(0);
      windshield.setMotionBlur?.(0);
      // Depart from first pin already "visited" so we don't park in ARRIVE
      if (night.pins?.length) {
        const first = night.pins[0];
        if (first?.view) {
          const startView = {
            ...first.view,
            // Chapter cruise FoV (Gumdrop ~34°) — not pin micro-FoV
            fov: Math.max(
              22,
              Number(first.view.fov) >= 12 ? Number(first.view.fov) : 34,
              night.id === "gumdrop-summer" ? 34 : 22
            ),
            // Keep whatever heading player has; do not face next pin on spawn
          };
          windshield.goto(startView, { hard: true });
        }
        session.pinIndex = 0;
        if (!session.fixesVisited.includes(first.id)) {
          session.fixesVisited.push(first.id);
          session.discovered.storyPins.push(first.id);
          const pts = session.scoreTable?.STORY_PIN ?? 10;
          session.score += pts;
          session.navLog.push(`Departed: ${first.label} (+${pts})`);
        }
        syncPinIndexToUnvisited(night, session);
      }
      sensorLock = null;
      // Force scrub old clustered personal pins (pre-spread Gumdrop)
      try {
        scrubStaleChapterPins(night, { force: true });
      } catch {
        /* ignore */
      }
      // Radar locks first UNVISITED pin (Lantern after Porch depart)
      windshield.clearSoftFace?.();
      faceCurrentWaypoint(); // radar-only (hard:false)
      applyThrottleToSky("begin");
      armKeyboard("pre-flight");
      setState(State.FLIGHT);
      // Chapter hunt map (spread layout) for console / progress
      try {
        const visited = session.fixesVisited || [];
        window.__ncGumdropMap = {
          build: CORE_LOOP_VERSION,
          story: (night.pins || []).map((p) => ({
            label: p.label,
            id: p.id,
            ra: p.view?.ra,
            dec: p.view?.dec,
            found: visited.includes(p.id),
          })),
          drifts: (session.driftMysteries || []).map((m) => ({
            label: m.claimed_label || m.label,
            ra: m.seed?.ra,
            dec: m.seed?.dec,
            found: !!(m.noticed || m.claimed || m.house_named),
            claimed: !!(m.claimed || m.house_named),
          })),
          mystery: night.mystery
            ? {
                label: night.mystery.claimed_label || night.mystery.label,
                ra: night.mystery.seed?.ra,
                dec: night.mystery.seed?.dec,
                found: !!session.mysteryClaimed,
              }
            : null,
          house: (night.house_pins || []).map((hp) => ({
            label: hp.label,
            ra: hp.view?.ra,
            dec: hp.view?.dec,
          })),
          ribbonComplete: ribbonCompleteFromVisited(night, session),
          t: performance.now(),
        };
      } catch {
        /* ignore */
      }
      setWhisper(
        night.whisper_start ||
          "Radar shows the next light. A/D turn · W fly · you have the stick."
      );
      armKeyboard("post-flight");
      // Aladin may steal focus on first paint — reclaim repeatedly
      [0, 50, 150, 400, 1000].forEach((ms) => {
        setTimeout(() => armKeyboard(`t+${ms}`), ms);
      });
      refreshOverlays();
      renderHousePins();
      renderMeters();
      updateFlightBar();
    });
  }

  function updateFlightBar() {
    const bar = document.getElementById("flight-bar");
    if (!bar) return;
    const show =
      !!session &&
      (state === State.FLIGHT ||
        state === State.ARRIVE ||
        state === State.MYSTERY ||
        state === State.REST);
    bar.hidden = !show;
    bar.setAttribute("aria-hidden", show ? "false" : "true");
    const thr = document.getElementById("flight-throttle-readout");
    if (thr && session) {
      const hdg =
        typeof windshield.getHeading === "function"
          ? Math.round(windshield.getHeading())
          : null;
      const thrPct = Math.round((session.throttle || 0) * 100);
      thr.textContent =
        hdg != null ? `${thrPct}% · ${hdg}°` : `${thrPct}%`;
    }
  }

  function nextHeading() {
    if (!session || !night) return;
    if (state === State.REST) {
      if (session.spoons <= 0.02) {
        setWhisper("Still recovering spoons — wait a moment.");
        return;
      }
      if (session.throttle < 0.1) {
        setThrottle(session, 0.3);
        if (el.throttle()) el.throttle().value = "0.3";
      }
    }
    if (
      state === State.ARRIVE ||
      state === State.MYSTERY ||
      state === State.REST
    ) {
      session.activeDriftId = null;
      session.mysteryNear = false;
      setState(State.FLIGHT);
    }
    const wp = currentWaypoint(night, session);
    if (!wp) {
      beginCloseout();
      return;
    }
    if (session.throttle < 0.1 && session.spoons > 0.05) {
      setThrottle(session, 0.3);
      if (el.throttle()) el.throttle().value = String(session.throttle);
    }
    setState(State.FLIGHT);
    faceCurrentWaypoint();
    setWhisper(
      wp.kind === "mystery"
        ? night.mystery.story_hook
        : `Heading: ${wp.pin.label} · A/D to turn · W to fly`
    );
  }

  function skipFix() {
    if (!session || !night) return;
    const wp = currentWaypoint(night, session);
    if (wp?.kind === "pin") {
      const id = wp.pin.id;
      // Mark skipped as "done" for ribbon so pinIndex can't leap past an unlit pin
      if (id && !(session.fixesVisited || []).includes(id)) {
        session.fixesVisited.push(id);
      }
      session.navLog.push(`Skipped: ${wp.pin.label} (allowed · no score)`);
      syncPinIndexToUnvisited(night, session);
      sensorLock = null;
      setState(State.FLIGHT);
      faceCurrentWaypoint();
      const next = firstUnvisitedStoryPin(night, session);
      setWhisper(
        next
          ? `Skipped. Radar → ${next.label} · RA ${Number(next.view.ra).toFixed(1)}° Dec ${Number(next.view.dec) >= 0 ? "+" : ""}${Number(next.view.dec).toFixed(1)}°`
          : "Skipped. Story ribbon complete — free cruise."
      );
      refreshOverlays();
      renderMeters();
    }
  }

  function rest() {
    if (!session) return;
    if (state === State.REST) {
      // toggle: leave rest if spoons allow
      if (session.spoons > 0.05) {
        setThrottle(session, 0.25);
        if (el.throttle()) el.throttle().value = "0.25";
        leaveRestIfNeeded();
      }
      return;
    }
    if (ACTIVE.has(state) || state === State.FLIGHT) {
      enterRest({ reason: "manual" });
    }
  }

  function tryClaimMystery() {
    if (!session || !night) return;
    const view = windshield.getView();

    // Centered on chapter glow before ribbon is done — don't free-pin by accident
    if (
      night.mystery?.seed &&
      !session.mysteryClaimed &&
      session.pinIndex < (night.pins?.length || 0)
    ) {
      const dChap = skyDistanceDeg(view, night.mystery.seed);
      if (dChap < MYSTERY_NEAR_DEG) {
        setWhisper(
          "✦ Rain glow is the chapter mystery — finish or Skip the story pins, then return and press P."
        );
        resumeFlightInput("chapter-tease");
        return;
      }
    }

    // Active drift mystery
    if (session.activeDriftId) {
      const m = session.driftMysteries.find(
        (x) => x.id === session.activeDriftId
      );
      if (m && !m.claimed) {
        const label =
          window.prompt("Name this drift glow (yours):", "soft spark") || "";
        // prompt() steals focus — restore flight keys immediately
        resumeFlightInput("after-prompt-drift");
        if (!label.trim()) {
          setWhisper("No name yet — keep gliding if you want. A/D · W ready.");
          return;
        }
        claimDriftMystery(session, m, label.trim());
        claimPin({
          label: label.trim(),
          note: m.story_hook,
          view: m.seed,
          emotion: "wonder",
          nightId: night.id,
          chapterTitle: night.title,
          kind: "drift",
        });
        setWhisper(
          `✧ ${label.trim()} — saved · +${session.scoreTable.DRIFT_MYSTERY} wonder · house pins updated.`
        );
        session.mysteryNear = false;
        session.activeDriftId = null;
        setState(State.FLIGHT);
        refreshOverlays();
        renderHousePins();
        renderMeters();
        return;
      }
    }

    // Chapter mystery — waypoint ready OR cam-centered after ribbon
    const wp = currentWaypoint(night, session);
    const chapDist =
      night.mystery?.seed && !session.mysteryClaimed
        ? skyDistanceDeg(view, night.mystery.seed)
        : Infinity;
    if (
      wp?.kind === "mystery" ||
      (isStoryRibbonComplete() &&
        !session.mysteryClaimed &&
        (session.mysteryNear || chapDist < MYSTERY_NEAR_DEG))
    ) {
      const label =
        window.prompt(
          "Name this chapter mystery (yours alone):",
          night.mystery?.claimed_label ||
            night.mystery?.label ||
            "the porch light for now"
        ) || "";
      resumeFlightInput("after-prompt-chapter");
      if (!label.trim()) {
        setWhisper("No name yet — that’s okay. A/D · W still fly.");
        return;
      }
      claimChapterMystery(session, label.trim());
      night.mystery.claimed_label = label.trim();
      claimPin({
        label: label.trim(),
        note: night.mystery.story_hook,
        view: night.mystery.seed || view,
        emotion: "wonder",
        nightId: night.id,
        chapterTitle: night.title,
        kind: "chapter",
      });
      setWhisper(
        `✦ ${label.trim()} — chapter mystery · +${session.scoreTable.CHAPTER_MYSTERY} wonder.`
      );
      setState(State.FLIGHT);
      refreshOverlays();
      renderHousePins();
      renderMeters();
      setTimeout(() => beginCloseout(), 1400);
      return;
    }

    // House-named drift already claimed — don't free-pin as generic "house light"
    const nearDrift = nearestDriftMystery(session, view, {
      includeClaimed: true,
    });
    if (
      nearDrift &&
      nearDrift.distDeg < mysteryRadiiForFov(view.fov || 22).nearDeg &&
      nearDrift.mystery.claimed
    ) {
      const nm =
        nearDrift.mystery.claimed_label ||
        nearDrift.mystery.label ||
        "this glow";
      setWhisper(`✧ “${nm}” is already kept in the house sky.`);
      resumeFlightInput("already-named-drift");
      return;
    }

    freePin();
  }

  /**
   * Default free-pin name from whatever the camera is on:
   * house_pins → story pin (Personal star) → landmark label → soft default.
   * Story pin beats catalog-only names so M51 suggests "Personal star"
   * not a second "Whirlpool" identity.
   */
  function resolveFreePinDefault(view) {
    if (!view || !night) return "sky light";
    const { nearDeg, noticeDeg } = mysteryRadiiForFov(view.fov || 22);
    const lim = Math.max(nearDeg, 2.5);

    // 1) Night house_pins (seven sisters, Mars DC, …)
    let bestHp = null;
    for (const hp of night.house_pins || []) {
      if (!hp?.view || !(hp.label || hp.claimed_label)) continue;
      const d = skyDistanceDeg(view, hp.view);
      if (d < lim && (!bestHp || d < bestHp.d)) {
        bestHp = { d, label: (hp.label || hp.claimed_label).trim() };
      }
    }
    if (bestHp) return bestHp.label;

    // 2) Story ribbon pin at this sky (Personal star @ M51, Home glass, …)
    let bestStory = null;
    for (const p of night.pins || []) {
      if (!p?.view || !p.label) continue;
      const d = skyDistanceDeg(view, p.view);
      if (d < lim && (!bestStory || d < bestStory.d)) {
        bestStory = { d, label: p.label };
      }
    }
    if (bestStory) return bestStory.label;

    // 3) Scenery landmark house label (already aligned to pin names where shared)
    if (typeof windshield.nearestLandmark === "function") {
      const hit = windshield.nearestLandmark(view.ra, view.dec);
      if (hit && hit.distDeg < Math.max(lim, 3) && hit.landmark?.label) {
        return hit.landmark.label;
      }
    }

    // 4) Claimed chapter / drift names if close
    if (night.mystery?.seed) {
      const d = skyDistanceDeg(view, night.mystery.seed);
      const nm = night.mystery.claimed_label || night.mystery.label;
      if (d < lim && nm) return nm;
    }
    if (session) {
      const nd = nearestDriftMystery(session, view, { includeClaimed: true });
      if (nd && nd.distDeg < lim) {
        const nm = nd.mystery.claimed_label || nd.mystery.label;
        if (nm) return nm;
      }
    }

    return "sky light";
  }

  function freePin() {
    const view = windshield.getView();
    const suggested = resolveFreePinDefault(view);
    const label =
      window.prompt("Personal pin label:", suggested) || "";
    resumeFlightInput("after-prompt-pin");
    if (!label.trim()) return;
    const pin = claimPin({
      label: label.trim(),
      note:
        suggested && label.trim() === suggested
          ? `Pinned at ${suggested}`
          : "",
      view,
      nightId: night?.id,
      chapterTitle: night?.title,
      kind: "personal",
    });
    if (session) recordFreePin(session);
    session?.navLog.push(`Pinned: ${pin.label}`);
    setWhisper(
      `📌 ${pin.label} saved · +${session?.scoreTable?.FREE_PIN ?? SCORE.FREE_PIN} wonder.`
    );
    refreshOverlays();
    renderHousePins();
    renderMeters();
  }

  function beginCloseout() {
    if (!session || !night) return;
    session.endedAt = Date.now();
    maybeApplyPerfectBonus(session, night);

    const disc =
      (session.discovered.storyPins?.length || 0) +
      (session.discovered.driftMysteries?.length || 0) +
      (session.discovered.chapterMystery ? 1 : 0) +
      (session.discovered.freePins || 0);

    const best = saveBestScore(session.score);
    const chBest = saveChapterBest(night.id, session.score);
    recordChapterComplete({
      nightId: night.id,
      title: night.title,
      score: session.score,
      discoveries: disc,
      perfect: !!session.perfectBonusApplied,
    });

    const reflection = buildReflection(session, night);
    saveReflection(reflection);

    const lines = closeoutLines(session, night);
    lines.push(`Chapter best: ${chBest} · house best: ${best}`);
    session.navLog.push("--- closeout ---", ...lines);

    setState(State.CLOSEOUT);
    windshield.setHotTarget?.(null);
    windshield.setMotionBlur?.(0);
    windshield.fx?.setThrottle(0);
    audio.setWind(0);
    audio.stopAmbient({ fade: 2 });
    setWhisper("Wonder reflection — the night settles.");
    if (el.navLog()) el.navLog().textContent = lines.join("\n");
    refreshOverlays();
    renderHousePins();
    renderChapterMenu();
    renderProgress();
    renderMeters();
    showReflection(reflection);
  }

  // —— UI bindings ——
  el.btnMute()?.addEventListener("click", async () => {
    await audio.unlock();
    audio.toggleMute();
    syncMuteButton();
    setWhisper(audio.muted ? "Sound off — silence is fine." : "Sound on — soft ambient.");
  });
  el.btnHelp()?.addEventListener("click", () => showHelp(true));
  el.btnHelpClose()?.addEventListener("click", () => showHelp(false));
  el.btnExport()?.addEventListener("click", () => showExport(true));
  el.btnExportClose()?.addEventListener("click", () => showExport(false));

  // Backdrop click on help/export closes and frees the map
  for (const id of ["help-screen", "export-screen"]) {
    const screen = document.getElementById(id);
    if (!screen) continue;
    screen.addEventListener("click", (e) => {
      if (e.target === screen) {
        if (id === "help-screen") showHelp(false);
        else showExport(false);
      }
    });
    // Start closed + inert so a half-open state never traps the sky
    if (screen.hidden) {
      screen.setAttribute("inert", "");
      screen.style.pointerEvents = "none";
      screen.style.display = "none";
    }
  }

  // Click the map / canvas → reclaim focus + flight keys
  const skyStage = document.getElementById("sky-stage");
  if (skyStage) {
    skyStage.tabIndex = 0;
    skyStage.addEventListener("pointerdown", onSkyPointer, true);
    skyStage.addEventListener("click", onSkyPointer);
    skyStage.addEventListener("focus", () => resumeFlightInput("sky-focus"));
  }
  document.getElementById("sky-canvas")?.addEventListener(
    "pointerdown",
    onSkyPointer,
    true
  );
  el.btnExportPins()?.addEventListener("click", () => {
    exportPinsFile();
    setWhisper("House pins downloaded as JSON.");
    showExport(false);
  });
  el.btnExportReflections()?.addEventListener("click", () => {
    exportReflectionsFile();
    setWhisper("Reflections downloaded as JSON.");
    showExport(false);
  });
  el.btnExportFull()?.addEventListener("click", () => {
    exportFullHouseFile();
    setWhisper("Full house backup downloaded.");
    showExport(false);
  });
  el.btnExportCopy()?.addEventListener("click", async () => {
    const ok = await copyToClipboard(toJson(buildExportPayload()));
    setWhisper(ok ? "House JSON copied to clipboard." : "Copy failed — try download.");
  });
  el.btnExportShare()?.addEventListener("click", async () => {
    const r = await shareSoftSummary();
    setWhisper(
      r === "shared"
        ? "Shared a soft summary."
        : r === "copied"
          ? "Summary copied (share not available)."
          : "Share failed."
    );
  });
  el.btnBegin()?.addEventListener("click", () => {
    if (state === State.CLOSEOUT || state === State.MENU) {
      hideReflection();
      showHelp(false);
      showExport(false);
      beginFlight();
    }
  });
  el.btnNext()?.addEventListener("click", nextHeading);
  el.btnSkip()?.addEventListener("click", skipFix);
  el.btnRest()?.addEventListener("click", rest);
  el.btnEnd()?.addEventListener("click", beginCloseout);
  el.btnReflectionDone()?.addEventListener("click", () => {
    hideReflection();
    setWhisper("Ready when you are — pick a night or Begin again.");
    renderChapterMenu();
    renderProgress();
  });
  el.btnReflectionAgain()?.addEventListener("click", () => {
    hideReflection();
    beginFlight();
  });
  el.btnPin()?.addEventListener("click", () => {
    if (
      state === State.MYSTERY ||
      session?.mysteryNear ||
      session?.activeDriftId
    ) {
      tryClaimMystery();
    } else freePin();
  });
  function onThrottleInput(e) {
    if (!session) return;
    // Allow while a flight session is open (not only FLIGHT state)
    if (
      state === State.MENU ||
      state === State.BOOT ||
      state === State.CLOSEOUT
    ) {
      return;
    }
    const v = Number(e?.target?.value ?? el.throttle()?.value ?? 0);
    setThrottle(session, v);
    if (session.throttle > 0.04) {
      session.resting = false;
      if (state === State.REST) leaveRestIfNeeded();
      if (state === State.ARRIVE) setState(State.FLIGHT);
    }
    try {
      audio.setWind(session.resting ? 0 : session.throttle);
    } catch {
      /* ignore */
    }
    windshield.fx?.setThrottle(session.resting ? 0 : session.throttle);
    applyThrottleToSky("slider");
    if (session.resting || state === State.REST) {
      setWhisper("Resting — spoons recovering…");
    } else if (session.spoons < 0.2) {
      setWhisper("Easy on the throttle — spoons are thin.");
    } else {
      setWhisper(`Throttle ${Math.round(session.throttle * 100)}% — sky gliding.`);
    }
    updateFlightBar();
    renderMeters();
  }
  el.throttle()?.addEventListener("input", onThrottleInput);
  el.throttle()?.addEventListener("change", onThrottleInput);

  document.getElementById("btn-panel-toggle")?.addEventListener("click", () => {
    togglePanel();
  });

  /** Soft abort flight → MENU (no forced closeout reflection) */
  function abortToMenu() {
    hideReflection();
    showHelp(false);
    showExport(false);
    if (session) {
      session.endedAt = Date.now();
      session.navLog.push("Aborted to menu (Esc)");
    }
    try {
      audio.setWind(0);
      audio.stopAmbient({ fade: 0.8 });
    } catch {
      /* ignore */
    }
    windshield.setMotionBlur?.(0);
    session = null;
    setState(State.MENU);
    setPanelCollapsed(false);
    clearSteer();
    setWhisper("Back to nights. Pick a chapter or Begin. (Esc anytime in flight)");
    refreshOverlays();
    renderHousePins();
    renderChapterMenu();
    renderProgress();
    renderMeters();
    updateFlightBar();
    armKeyboard("abort-menu");
  }

  function onKeyUp(e) {
    const code = e.code || "";
    const k = e.key || "";
    if (isSteerLeft(k, code)) {
      heldSteer.left = false;
      syncSteerInput();
    }
    if (isSteerRight(k, code)) {
      heldSteer.right = false;
      syncSteerInput();
    }
  }

  /**
   * Flight / menu keys via keys.js capture.
   * Throttle: W / ↑ · S / ↓
   * Steer: A / ← left · D / → right (held = continuous yaw)
   * Skip: X · Esc: overlays first, else back to menu
   */
  function isSteerLeft(k, code) {
    return (
      k === "a" ||
      k === "A" ||
      code === "KeyA" ||
      k === "ArrowLeft" ||
      code === "ArrowLeft"
    );
  }
  function isSteerRight(k, code) {
    return (
      k === "d" ||
      k === "D" ||
      code === "KeyD" ||
      k === "ArrowRight" ||
      code === "ArrowRight"
    );
  }

  function instrumentsScrollEl() {
    return (
      document.getElementById("instruments-body") ||
      document.querySelector(".instruments-body")
    );
  }

  function isInInstruments(el) {
    if (!el || !el.closest) return false;
    return !!el.closest("#instruments, .instruments, #instruments-body");
  }

  /**
   * Arrow keys scroll the bottom instruments panel when:
   * - focus is inside the panel, or
   * - Shift is held, or
   * - we're on the menu (not flying)
   */
  function tryScrollInstruments(e, k, code) {
    const body = instrumentsScrollEl();
    if (!body) return false;
    const collapsed = document.body.classList.contains("panel-collapsed");
    if (collapsed) return false;
    const canScroll = body.scrollHeight > body.clientHeight + 4;
    if (!canScroll) return false;

    const focusInPanel =
      isInInstruments(e.target) || isInInstruments(document.activeElement);
    const menuLike =
      state === State.MENU ||
      state === State.BOOT ||
      state === State.CLOSEOUT ||
      !session;
    const shiftScroll = !!e.shiftKey;
    if (!focusInPanel && !menuLike && !shiftScroll) return false;

    // Only vertical scroll with up/down/page (left/right left for steer when flying)
    const step = e.shiftKey ? 96 : 52;
    let dy = 0;
    if (k === "ArrowDown" || code === "ArrowDown" || k === "PageDown") dy = step;
    else if (k === "ArrowUp" || code === "ArrowUp" || k === "PageUp") dy = -step;
    else if (k === "Home") {
      body.scrollTop = 0;
      e.preventDefault();
      return true;
    } else if (k === "End") {
      body.scrollTop = body.scrollHeight;
      e.preventDefault();
      return true;
    } else return false;

    body.scrollTop += dy;
    e.preventDefault();
    return true;
  }

  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || "";
    const type = (e.target && e.target.type) || "";
    const isTyping =
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (tag === "INPUT" &&
        type !== "range" &&
        type !== "button" &&
        type !== "checkbox" &&
        type !== "radio" &&
        type !== "submit");

    const code = e.code || "";
    const k = e.key || "";
    const flying = !!(session && ACTIVE.has(state));
    const inPanel = isInInstruments(e.target);

    if (flying || state === State.MENU || state === State.CLOSEOUT) {
      if (tag === "CANVAS") {
        try {
          e.target.blur();
        } catch {
          /* ignore */
        }
        if (!inPanel) focusShell();
      }
    }

    // Bottom panel scroll (arrows / page keys) when panel has focus or on menu
    if (
      !isTyping &&
      (k === "ArrowUp" ||
        k === "ArrowDown" ||
        k === "PageUp" ||
        k === "PageDown" ||
        k === "Home" ||
        k === "End" ||
        code === "ArrowUp" ||
        code === "ArrowDown")
    ) {
      if (tryScrollInstruments(e, k, code)) {
        e.preventDefault();
        return;
      }
    }

    // Steer — held state; rAF applies continuous yaw (A/D always)
    // Never block A/D because the instruments panel was focused
    if (flying && (isSteerLeft(k, code) || isSteerRight(k, code))) {
      const isArrow =
        k === "ArrowLeft" ||
        k === "ArrowRight" ||
        code === "ArrowLeft" ||
        code === "ArrowRight";
      // Left/right arrows: prefer panel scroll only when panel is open + focused
      if (
        isArrow &&
        inPanel &&
        !document.body.classList.contains("panel-collapsed")
      ) {
        /* fall through — panel may use arrows; A/D still handled above as non-arrow */
      } else {
        e.preventDefault();
        // Leave intentional REST on steer so glass isn't "locked" after Space
        if (state === State.REST && session.spoons > 0.02) {
          session.resting = false;
          setThrottle(session, Math.max(session.throttle, 0.15));
          if (el.throttle()) el.throttle().value = String(session.throttle);
          leaveRestIfNeeded();
        }
        if (isSteerLeft(k, code)) heldSteer.left = true;
        if (isSteerRight(k, code)) heldSteer.right = true;
        syncSteerInput();
        return;
      }
    }

    const throttleUp =
      k === "w" ||
      k === "W" ||
      code === "KeyW" ||
      ((k === "ArrowUp" || code === "ArrowUp") && !inPanel);
    const throttleDown =
      k === "s" ||
      k === "S" ||
      code === "KeyS" ||
      ((k === "ArrowDown" || code === "ArrowDown") && !inPanel);

    if (flying && (throttleUp || throttleDown)) {
      e.preventDefault();
      // W/S always leave soft lock after panel/menu
      if (session?.resting && state !== State.REST && throttleUp) {
        session.resting = false;
      }
      nudgeThrottle(throttleUp ? 1 : -1, { repeat: !!e.repeat });
      return;
    }

    // Real text fields only — panel body focus must not eat flight keys
    if (isTyping) return;

    if (k === "?" || k === "h" || k === "H") {
      e.preventDefault();
      const open = el.helpScreen() && !el.helpScreen().hidden;
      showHelp(!open);
      showExport(false);
      return;
    }
    if (k === "e" || k === "E") {
      e.preventDefault();
      const open = el.exportScreen() && !el.exportScreen().hidden;
      showExport(!open);
      showHelp(false);
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      // Close overlays first; then leave flight to menu
      const helpOpen = el.helpScreen() && !el.helpScreen().hidden;
      const exportOpen = el.exportScreen() && !el.exportScreen().hidden;
      const reflectionOpen = document.body.classList.contains("reflection-open");
      if (helpOpen || exportOpen) {
        showHelp(false);
        showExport(false);
        return;
      }
      if (reflectionOpen) {
        hideReflection();
        setWhisper("Ready when you are — pick a night or Begin again.");
        return;
      }
      if (ACTIVE.has(state) || state === State.CLOSEOUT) {
        abortToMenu();
      }
      return;
    }

    if (k === "m" || k === "M") {
      e.preventDefault();
      audio.unlock().then(() => {
        audio.toggleMute();
        syncMuteButton();
        setWhisper(audio.muted ? "Sound off." : "Sound on.");
      });
      return;
    }

    if (k === "[" || k === "]") {
      e.preventDefault();
      togglePanel();
      return;
    }

    if (k >= "1" && k <= "4") {
      e.preventDefault();
      selectChapterByIndex(Number(k) - 1);
      return;
    }

    if (k === "b" || k === "B" || k === "Enter") {
      if (state === State.MENU || state === State.CLOSEOUT) {
        e.preventDefault();
        hideReflection();
        beginFlight();
      }
      return;
    }

    if (k === "n" || k === "N") {
      e.preventDefault();
      nextHeading();
      return;
    }
    if (k === "x" || k === "X" || code === "KeyX") {
      e.preventDefault();
      skipFix();
      return;
    }
    if (k === "c" || k === "C") {
      e.preventDefault();
      if (session && state !== State.MENU && state !== State.BOOT) {
        beginCloseout();
      }
      return;
    }
    if (k === "p" || k === "P") {
      e.preventDefault();
      if (
        state === State.MYSTERY ||
        session?.mysteryNear ||
        session?.activeDriftId
      ) {
        tryClaimMystery();
      } else freePin();
      return;
    }
    if (k === " " || code === "Space") {
      e.preventDefault();
      rest();
    }
  }

  // Attach once before Aladin.aladin() — do not tear down later
  armKeyboard("init");

  // Reclaim keyboard after click, but never while dragging the throttle slider
  // or typing in a real field. Closing the panel also resumes (setPanelCollapsed).
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (
        t &&
        ((t.tagName === "INPUT" && t.type === "range") ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          (t.tagName === "INPUT" && t.type === "text"))
      ) {
        return;
      }
      // Modal open: only allow interactions inside the modal card (or its close)
      const openModal = document.querySelector(
        ".modal-screen:not([hidden]), .reflection-screen:not([hidden])"
      );
      if (openModal && t && t.closest) {
        if (t.closest(".modal-card, .reflection-card")) return;
        // Click on dimmed backdrop → close (also handled on screen click)
        if (t === openModal || t.classList?.contains("modal-screen")) {
          if (openModal.id === "help-screen") showHelp(false);
          else if (openModal.id === "export-screen") showExport(false);
          else if (openModal.id === "reflection-screen") hideReflection();
          return;
        }
      }
      // Click on sky / canvas / flight bar → full resume
      if (
        t &&
        t.closest &&
        t.closest("#sky-stage, #sky-canvas, #flight-bar")
      ) {
        onSkyPointer(e);
        return;
      }
      // Click inside open instruments panel → soft arm only (keep scroll focus)
      const inPanel =
        t && t.closest && t.closest("#instruments, #instruments-body");
      if (inPanel && !document.body.classList.contains("panel-collapsed")) {
        clearSteer();
        bindKeys();
        setKeyHandler(onKeyDown);
        setKeyUpHandler(onKeyUp);
        return;
      }
      resumeFlightInput("pointer");
    },
    true
  );

  // Tab / DevTools / prompt: clear stuck A/D holds
  window.addEventListener("blur", () => clearSteer());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearSteer();
  });

  // Always-visible flight bar buttons (panel may be collapsed)
  document.getElementById("fb-next")?.addEventListener("click", () => {
    armKeyboard("fb-next");
    nextHeading();
  });
  document.getElementById("fb-rest")?.addEventListener("click", () => {
    armKeyboard("fb-rest");
    rest();
  });
  document.getElementById("fb-throttle-up")?.addEventListener("click", () => {
    armKeyboard("fb-up");
    nudgeThrottle(1);
  });
  document.getElementById("fb-throttle-down")?.addEventListener("click", () => {
    armKeyboard("fb-down");
    nudgeThrottle(-1);
  });
  // Flight-bar steer hold (same as A/D)
  function bindSteerButton(id, side) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const down = (e) => {
      e.preventDefault();
      armKeyboard(`fb-steer-${side}`);
      if (side === "left") heldSteer.left = true;
      else heldSteer.right = true;
      syncSteerInput();
    };
    const up = () => {
      if (side === "left") heldSteer.left = false;
      else heldSteer.right = false;
      syncSteerInput();
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointerleave", up);
    btn.addEventListener("pointercancel", up);
  }
  bindSteerButton("fb-steer-left", "left");
  bindSteerButton("fb-steer-right", "right");
  document.getElementById("fb-menu")?.addEventListener("click", () => {
    armKeyboard("fb-menu");
    abortToMenu();
  });
  document.getElementById("fb-panel")?.addEventListener("click", () => {
    armKeyboard("fb-panel");
    togglePanel();
  });

  // Instruments panel: click to focus so arrows scroll the body
  const instBody = document.getElementById("instruments-body");
  if (instBody) {
    instBody.tabIndex = 0;
    instBody.setAttribute(
      "aria-label",
      "Instruments panel. Arrow keys scroll. Click to focus."
    );
    instBody.addEventListener(
      "wheel",
      (e) => {
        // Ensure wheel scrolls this panel even if nested targets capture
        if (instBody.scrollHeight <= instBody.clientHeight) return;
        instBody.scrollTop += e.deltaY;
        e.preventDefault();
      },
      { passive: false }
    );
  }
  document.getElementById("instruments")?.addEventListener("click", (e) => {
    if (e.target.closest("button, input, a, select, textarea, label")) return;
    instBody?.focus({ preventScroll: true });
  });

  boot();

  return {
    get state() {
      return state;
    },
    get personalPins() {
      return loadPersonalPins();
    },
    get score() {
      return session?.score ?? 0;
    },
    get version() {
      return CORE_LOOP_VERSION;
    },
  };
}

function waitFor(fn, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 50);
    })();
  });
}
