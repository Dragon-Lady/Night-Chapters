/**
 * Night Chapters — core game loop (complete)
 *
 * BOOT → MENU → FLIGHT ⇄ ARRIVE ⇄ MYSTERY ⇄ REST → CLOSEOUT → MENU
 *
 * FLIGHT: throttle glide toward heading bug; spoon fuel drains while moving.
 * REST: Space / Rest button — throttle 0, spoons recover, no failure.
 * MYSTERY: drift glows mid-path + chapter mystery; P claims → personal pin + score.
 *
 * Wonder-first. Vanilla JS. Not a military sim.
 */

import { loadNight, listNights } from "./nights.js";
import { createWindshield } from "./windshield.js";
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
  ARRIVE_DEG,
  MYSTERY_NEAR_DEG,
  MYSTERY_NOTICE_DEG,
  SCORE,
} from "./flight.js";
import {
  claimPin,
  loadPersonalPins,
  renderPersonalPinList,
  saveBestScore,
  loadBestScore,
  saveChapterBest,
  getChapterBest,
  loadChapterBests,
} from "./pins.js";
import {
  recordChapterComplete,
  isChapterCompleted,
  buildReflection,
  saveReflection,
  renderProgressSummary,
} from "./progress.js";
import { createAudio } from "./audio.js";
import {
  exportPinsFile,
  exportReflectionsFile,
  exportFullHouseFile,
  shareSoftSummary,
  copyToClipboard,
  toJson,
  buildExportPayload,
} from "./export.js";
import {
  setKeyHandler,
  rebindKeys,
  bindKeys,
  focusShell,
  ensureKeySink,
} from "./keys.js";

export const CORE_LOOP_VERSION = "1.4.5";

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
  const windshield = createWindshield("#aladin-lite-div");
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

  function setWhisper(text) {
    const w = el.whisper();
    if (w) w.textContent = text;
    const compact = document.getElementById("whisper-compact");
    if (compact) {
      compact.textContent = text;
      // show compact line only while panel is collapsed
      compact.hidden = !document.body.classList.contains("panel-collapsed");
    }
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
    windshield.setOverlays(
      catalogSourcesForNight(night, session),
      loadPersonalPins()
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
    document.body.classList.add("reflection-open");
  }

  function hideReflection() {
    const screen = el.reflection();
    if (!screen) return;
    screen.hidden = true;
    screen.setAttribute("aria-hidden", "true");
    document.body.classList.remove("reflection-open");
  }

  function showHelp(show = true) {
    const screen = el.helpScreen();
    if (!screen) return;
    screen.hidden = !show;
    screen.setAttribute("aria-hidden", show ? "false" : "true");
  }

  function showExport(show = true) {
    const screen = el.exportScreen();
    if (!screen) return;
    screen.hidden = !show;
    screen.setAttribute("aria-hidden", show ? "false" : "true");
  }

  const THROTTLE_STEP = 0.1;
  let lastThrottleKeyAt = 0;

  /**
   * @param {number} delta  + up / − down
   * @param {{ repeat?: boolean }} [opts]
   */
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
    // Avoid dispatchEvent('input') — can re-enter and fight Aladin focus
    setThrottle(session, next);
    if (state === State.REST && next > 0.04) leaveRestIfNeeded();
    if (session.resting && next > 0.04 && state !== State.REST) {
      session.resting = false;
    }
    try {
      audio.setWind(session.resting ? 0 : next);
    } catch {
      /* ignore */
    }
    windshield.fx?.setThrottle(session.resting ? 0 : next);
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
        ? `✦ ${night.mystery.claimed_label || "mystery"}`
        : "✦ chapter mystery";
      if (session?.mysteryClaimed) li.classList.add("done");
      if (
        session &&
        session.pinIndex >= night.pins.length &&
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
      if (session?.activeDriftId) {
        const d = session.driftMysteries.find(
          (m) => m.id === session.activeDriftId
        );
        h = d ? `✧ ${d.claimed_label || "drift glow"}` : h;
      } else if (wp) {
        h = wp.kind === "mystery" ? "✦ chapter mystery" : wp.pin.label;
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
    if (el.throttle()) el.throttle().value = "0";
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
      setWhisper(
        next === State.MYSTERY
          ? "Back to the glow…"
          : "Glide resumes — sky follows throttle."
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

    // REST: spoons recover; throttle-up leaves rest
    if (state === State.REST) {
      windshield.fx?.setThrottle(0);
      leaveRestIfNeeded();
      // If user raised throttle, leaveRestIfNeeded may have set FLIGHT — fall through
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
        renderMeters();
        updateFlightBar();
        return;
      }
    }

    // FLIGHT + MYSTERY: live glide — throttle drives sky motion
    const thr = Number(session.throttle || 0);
    const canGlide =
      (state === State.FLIGHT || state === State.MYSTERY) &&
      !session.resting &&
      thr > 0.04 &&
      session.spoons > 0.02;

    if (canGlide) {
      const wp = currentWaypoint(night, session);
      if (!wp) {
        beginCloseout();
        return;
      }

      const step = windshield.glideStep(wp.view, thr);
      windshield.fx?.setThrottle(thr);
      try {
        audio.setWind(thr);
      } catch {
        /* ignore */
      }
      if (typeof ui?.onGlide === "function") ui.onGlide(step, wp);

      // —— Drift mysteries appear during glide ——
      const view = { ra: step.ra, dec: step.dec };
      const near = nearestDriftMystery(session, view);
      if (near && near.distDeg < MYSTERY_NOTICE_DEG) {
        if (!near.mystery.noticed) {
          near.mystery.noticed = true;
          session.navLog.push("Noticed drift glow…");
          refreshOverlays();
        }
        if (near.distDeg < MYSTERY_NEAR_DEG) {
          session.activeDriftId = near.mystery.id;
          session.mysteryNear = true;
          if (state !== State.MYSTERY) {
            setState(State.MYSTERY);
            setWhisper(
              `${near.mystery.story_hook} · Press P to name it (or keep gliding).`
            );
          }
        }
      } else if (
        session.activeDriftId &&
        state === State.MYSTERY &&
        wp.kind !== "mystery"
      ) {
        // left drift field; return to flight unless chapter mystery
        session.activeDriftId = null;
        session.mysteryNear = false;
        setState(State.FLIGHT);
      }

      // —— Chapter mystery approach ——
      if (wp.kind === "mystery" && step.distDeg < MYSTERY_NEAR_DEG) {
        session.mysteryNear = true;
        if (state !== State.MYSTERY) {
          setState(State.MYSTERY);
          setWhisper(
            `${night.mystery.story_hook} · Press P to claim · or glide closer.`
          );
        }
      }

      // —— Story pin arrival ——
      if (step.distDeg < ARRIVE_DEG && wp.kind === "pin") {
        onArrivePin(wp);
      }
    } else if (state === State.FLIGHT || state === State.MYSTERY) {
      windshield.fx?.setThrottle(session?.throttle || 0);
      audio.setWind(session.resting ? 0 : session?.throttle || 0);
      if (session.resting) windshield.setMotionBlur?.(0);
    }

    renderMeters();
    updateFlightBar();
  }

  function onArrivePin(wp) {
    setState(State.ARRIVE);
    setWhisper(`${wp.pin.label} — ${wp.pin.note}`);
    markArrived(session, wp);
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
    await waitFor(() => typeof A !== "undefined", 8000);
    windshield.boot();
    windshield.whenReady(() => {
      // Keep original capture listener (first); only refresh handler + focus
      setKeyHandler(onKeyDown);
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
      lowSpoonsWhispered = false;
      resumeState = State.FLIGHT;
      // Start with readable throttle so sky moves immediately
      const t0 = Math.max(0.35, Number(el.throttle()?.value || 0.35));
      if (el.throttle()) el.throttle().value = String(t0);
      setThrottle(session, t0);
      // Depart from first pin already "visited" so we don't park in ARRIVE
      // and block glide until Next — throttle can fly toward pin 2 immediately.
      if (night.pins?.length) {
        const first = night.pins[0];
        if (first?.view) windshield.goto(first.view, { hard: true });
        session.pinIndex = 0;
        // Mark start pin lightly without ARRIVE lock
        if (!session.fixesVisited.includes(first.id)) {
          session.fixesVisited.push(first.id);
          session.discovered.storyPins.push(first.id);
          const pts = session.scoreTable?.STORY_PIN ?? 10;
          session.score += pts;
          session.navLog.push(`Departed: ${first.label} (+${pts})`);
          session.pinIndex = 1;
        }
      }
      // Arm keys BEFORE setState (which auto-collapses panel)
      armKeyboard("pre-flight");
      setState(State.FLIGHT);
      setWhisper(
        night.whisper_start ||
          "Throttle moves the sky — W/S or slider. Space rest · Esc menu."
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
      thr.textContent = `${Math.round((session.throttle || 0) * 100)}%`;
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
    setWhisper(
      wp.kind === "mystery"
        ? night.mystery.story_hook
        : `Heading: ${wp.pin.label}`
    );
  }

  function skipFix() {
    if (!session || !night) return;
    const wp = currentWaypoint(night, session);
    if (wp?.kind === "pin") {
      session.navLog.push(`Skipped: ${wp.pin.label} (allowed · no score)`);
      session.pinIndex += 1;
      setState(State.FLIGHT);
      setWhisper("Skipped. The night still counts.");
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

    // Active drift mystery
    if (session.activeDriftId) {
      const m = session.driftMysteries.find(
        (x) => x.id === session.activeDriftId
      );
      if (m && !m.claimed) {
        const label =
          window.prompt("Name this drift glow (yours):", "soft spark") || "";
        if (!label.trim()) {
          setWhisper("No name yet — keep gliding if you want.");
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

    // Chapter mystery
    const wp = currentWaypoint(night, session);
    if (
      wp?.kind === "mystery" ||
      (session.mysteryNear && session.pinIndex >= night.pins.length)
    ) {
      const label =
        window.prompt(
          "Name this chapter mystery (yours alone):",
          "soft rainy glow"
        ) || "";
      if (!label.trim()) {
        setWhisper("No name yet — that’s okay.");
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

    freePin();
  }

  function freePin() {
    const view = windshield.getView();
    const label = window.prompt("Personal pin label:", "house light") || "";
    if (!label.trim()) return;
    const pin = claimPin({
      label: label.trim(),
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
  el.throttle()?.addEventListener("input", (e) => {
    if (!session) return;
    setThrottle(session, e.target.value);
    audio.setWind(session.resting ? 0 : session.throttle);
    windshield.fx?.setThrottle(session.resting ? 0 : session.throttle);
    if (state === State.REST && session.throttle > 0.04) {
      leaveRestIfNeeded();
    } else if (session.resting || state === State.REST) {
      setWhisper("Resting — spoons recovering…");
    } else if (session.spoons < 0.2) {
      setWhisper("Easy on the throttle — spoons are thin.");
    }
  });

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
    setWhisper("Back to nights. Pick a chapter or Begin. (Esc anytime in flight)");
    refreshOverlays();
    renderHousePins();
    renderChapterMenu();
    renderProgress();
    renderMeters();
    updateFlightBar();
    armKeyboard("abort-menu");
  }

  /**
   * Flight / menu keys via keys.js capture (bound before Aladin).
   * Throttle: W / ↑ = up · S / ↓ = down (step 0.1)
   * Skip: X · Esc: overlays first, else back to menu
   */
  function onKeyDown(e) {
    // Do NOT bail on defaultPrevented — Aladin may mark events after us

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

    // Reclaim focus from Aladin canvas on any flight key
    if (flying || state === State.MENU || state === State.CLOSEOUT) {
      if (tag === "CANVAS") {
        try {
          e.target.blur();
        } catch {
          /* ignore */
        }
        focusShell();
      }
    }

    const throttleUp =
      k === "w" ||
      k === "W" ||
      code === "KeyW" ||
      k === "ArrowUp" ||
      code === "ArrowUp";
    const throttleDown =
      k === "s" ||
      k === "S" ||
      code === "KeyS" ||
      k === "ArrowDown" ||
      code === "ArrowDown";

    if (flying && (throttleUp || throttleDown)) {
      e.preventDefault();
      nudgeThrottle(throttleUp ? 1 : -1, { repeat: !!e.repeat });
      return;
    }

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

  // Any pointer on page reclaims keyboard focus from Aladin
  document.addEventListener(
    "pointerdown",
    () => {
      armKeyboard("pointer");
    },
    true
  );

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
  document.getElementById("fb-menu")?.addEventListener("click", () => {
    armKeyboard("fb-menu");
    abortToMenu();
  });
  document.getElementById("fb-panel")?.addEventListener("click", () => {
    armKeyboard("fb-panel");
    togglePanel();
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
