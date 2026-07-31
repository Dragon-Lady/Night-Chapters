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

export const CORE_LOOP_VERSION = "1.3.0";

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
  };

  function setWhisper(text) {
    const w = el.whisper();
    if (w) w.textContent = text;
  }

  function setState(next) {
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
    syncButtons();
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
      const next =
        resumeState === State.REST || resumeState === State.CLOSEOUT
          ? State.FLIGHT
          : resumeState;
      setState(next);
      setWhisper(
        next === State.MYSTERY
          ? "Back to the glow…"
          : "Glide resumes. Soft sky ahead."
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

    // REST: no glide, spoons recover (already in tickSpoons)
    if (state === State.REST) {
      windshield.fx?.setThrottle(0);
      leaveRestIfNeeded();
      renderMeters();
      return;
    }

    // ARRIVE: parked on pin beat — no auto glide until Next
    if (state === State.ARRIVE) {
      windshield.fx?.setThrottle(0);
      windshield.setMotionBlur?.(0);
      renderMeters();
      return;
    }

    // FLIGHT + MYSTERY: throttle glide when not resting
    if (
      (state === State.FLIGHT || state === State.MYSTERY) &&
      !session.resting &&
      session.throttle > 0.04 &&
      session.spoons > 0.02
    ) {
      const wp = currentWaypoint(night, session);
      if (!wp) {
        beginCloseout();
        return;
      }

      const step = windshield.glideStep(wp.view, session.throttle);
      windshield.fx?.setThrottle(session.throttle);
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
      if (session.resting) windshield.setMotionBlur?.(0);
    }

    renderMeters();
  }

  function onArrivePin(wp) {
    setState(State.ARRIVE);
    setWhisper(`${wp.pin.label} — ${wp.pin.note}`);
    markArrived(session, wp);
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
      windshield.applyChapterSky?.(night);
      setState(State.MENU);
      setWhisper(
        `Choose a night, then Begin. Best wonder: ${loadBestScore()}. Loop ${CORE_LOOP_VERSION}.`
      );
      refreshOverlays();
      renderHousePins();
      renderChapterMenu();
      renderProgress();
      if (el.btnBegin()) el.btnBegin().disabled = false;
      renderMeters();
    });
    cancelAnimationFrame(raf);
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }

  function beginFlight() {
    loadNight(selectedNightId).then((n) => {
      night = n;
      windshield.applyChapterSky?.(night);
      session = createFlightSession(night);
      session.startedAt = Date.now();
      const T = session.scoreTable || scoreTable(night);
      session.navLog.push(`Night open: ${night.title} · ${CORE_LOOP_VERSION}`);
      session.navLog.push(
        `Chapter scores: story +${T.STORY_PIN} · drift +${T.DRIFT_MYSTERY} · chapter +${T.CHAPTER_MYSTERY} · perfect +${T.PERFECT_BONUS}`
      );
      lowSpoonsWhispered = false;
      resumeState = State.FLIGHT;
      const t0 = Number(el.throttle()?.value || 0.25);
      setThrottle(session, t0);
      const first = night.pins[0]?.view;
      if (first) windshield.goto(first, { hard: true });
      setState(State.FLIGHT);
      setWhisper(
        night.whisper_start ||
          "Glide when ready. Throttle to fly · Space to rest · watch for ✧ glows."
      );
      refreshOverlays();
      renderHousePins();
      renderMeters();
    });
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
  el.btnBegin()?.addEventListener("click", () => {
    if (state === State.CLOSEOUT || state === State.MENU) {
      hideReflection();
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
    if (state === State.REST && session.throttle > 0.04) {
      leaveRestIfNeeded();
    } else if (session.resting || state === State.REST) {
      setWhisper("Resting — spoons recovering…");
    } else if (session.spoons < 0.2) {
      setWhisper("Easy on the throttle — spoons are thin.");
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "p" || e.key === "P") {
      if (e.target.matches?.("input, textarea")) return;
      e.preventDefault();
      if (
        state === State.MYSTERY ||
        session?.mysteryNear ||
        session?.activeDriftId
      ) {
        tryClaimMystery();
      } else freePin();
    }
    if (e.key === " " || e.code === "Space") {
      if (e.target.matches?.("input, textarea")) return;
      e.preventDefault();
      rest();
    }
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
