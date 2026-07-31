/**
 * Night Chapters game loop
 * BOOT → MENU → FLIGHT → ARRIVE | MYSTERY | REST → CLOSEOUT
 *
 * FLIGHT: soft glide, spoon fuel, drift mysteries appear along the path.
 * MYSTERY: chapter or drift glow near reticle — claim with P.
 */

import { loadNight } from "./nights.js";
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
  ARRIVE_DEG,
  MYSTERY_NEAR_DEG,
  MYSTERY_NOTICE_DEG,
} from "./flight.js";
import {
  claimPin,
  loadPersonalPins,
  renderPersonalPinList,
  saveBestScore,
  loadBestScore,
} from "./pins.js";

const State = {
  BOOT: "BOOT",
  MENU: "MENU",
  FLIGHT: "FLIGHT",
  ARRIVE: "ARRIVE",
  MYSTERY: "MYSTERY",
  CLOSEOUT: "CLOSEOUT",
};

export function startGame(ui) {
  const windshield = createWindshield("#aladin-lite-div");
  let night = null;
  let session = null;
  let state = State.BOOT;
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
    pins: () => document.getElementById("pin-list"),
    housePins: () => document.getElementById("house-pins"),
    navLog: () => document.getElementById("nav-log"),
    btnBegin: () => document.getElementById("btn-begin"),
    btnNext: () => document.getElementById("btn-next"),
    btnSkip: () => document.getElementById("btn-skip"),
    btnRest: () => document.getElementById("btn-rest"),
    btnEnd: () => document.getElementById("btn-end"),
    btnPin: () => document.getElementById("btn-pin"),
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
    syncButtons();
  }

  function syncButtons() {
    const flying =
      state === State.FLIGHT ||
      state === State.ARRIVE ||
      state === State.MYSTERY;
    if (el.btnBegin()) {
      el.btnBegin().disabled = !(
        state === State.MENU || state === State.CLOSEOUT
      );
    }
    if (el.btnNext()) el.btnNext().disabled = !flying;
    if (el.btnSkip())
      el.btnSkip().disabled =
        state !== State.ARRIVE && state !== State.FLIGHT;
    if (el.btnRest()) el.btnRest().disabled = !flying;
    if (el.btnEnd()) el.btnEnd().disabled = state === State.BOOT;
    if (el.btnPin()) el.btnPin().disabled = state === State.BOOT;
  }

  function refreshOverlays() {
    if (!night || !windshield.ready) return;
    const sources = catalogSourcesForNight(night, session);
    windshield.setOverlays(sources, loadPersonalPins());
  }

  function renderHousePins() {
    renderPersonalPinList(el.housePins(), {
      onFly: (p) => {
        if (p.view) windshield.goto(p.view, { hard: true });
        setWhisper(`Flying to house pin: ${p.label}`);
      },
      onDelete: () => {
        refreshOverlays();
        setWhisper("House pin removed.");
      },
    });
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
        state !== State.CLOSEOUT
      ) {
        li.classList.add("current");
      }
      ul.appendChild(li);
    });
    for (const m of session?.driftMysteries || []) {
      const li = document.createElement("li");
      li.classList.add("drift");
      li.textContent = m.claimed
        ? `✧ ${m.claimed_label || "found"}`
        : "✧ drift ?";
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
          session.resting ? " · resting" : ""
        }`;
      }
      if (el.fuelBar()) {
        el.fuelBar().style.width = `${Math.round(f * 100)}%`;
        el.fuelBar().dataset.level =
          f < 0.2 ? "low" : f < 0.5 ? "mid" : "ok";
      }
      if (el.score()) {
        el.score().textContent = String(session.score);
      }
      if (el.discovered()) {
        el.discovered().textContent = String(discoveryCount(session));
      }
      if (el.navLog()) {
        el.navLog().textContent =
          session.navLog.slice(-6).join("\n") ||
          "Nav log empty — soft start.";
      }
    }
    renderPins();
  }

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 1 / 60;
    lastTs = ts;

    if (!session || !night || !windshield.ready) return;

    // Spoon fuel always ticks during an open night
    if (state !== State.MENU && state !== State.BOOT && state !== State.CLOSEOUT) {
      const before = session.spoons;
      tickSpoons(session, dt);
      if (session.spoons <= 0.02 && before > 0.02) {
        if (el.throttle()) el.throttle().value = "0";
        setWhisper("Spoons empty — rest in the glass. No failure. Recovery is the play.");
        lowSpoonsWhispered = true;
      } else if (session.spoons < 0.25 && !session.resting && !lowSpoonsWhispered) {
        setWhisper("Spoons running low — Rest or Space to recover.");
        lowSpoonsWhispered = true;
      } else if (session.spoons > 0.4) {
        lowSpoonsWhispered = false;
      }
      if (session.resting && el.throttle() && Number(el.throttle().value) > 0.04) {
        el.throttle().value = String(session.throttle);
      }
    }

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
      if (typeof ui?.onGlide === "function") ui.onGlide(step, wp);

      // Drift mysteries appear during glide (not only at chapter end)
      const view = { ra: step.ra, dec: step.dec };
      const near = nearestDriftMystery(session, view);
      if (near && near.distDeg < MYSTERY_NOTICE_DEG) {
        if (!near.mystery.noticed) {
          near.mystery.noticed = true;
          session.navLog.push(`Noticed drift glow…`);
          refreshOverlays();
        }
        if (near.distDeg < MYSTERY_NEAR_DEG) {
          session.activeDriftId = near.mystery.id;
          if (state !== State.MYSTERY || session.mysteryNear !== true) {
            setState(State.MYSTERY);
            setWhisper(
              `${near.mystery.story_hook} · Press P to name it (or keep gliding).`
            );
          }
          session.mysteryNear = true;
        }
      } else if (session.activeDriftId && state === State.MYSTERY) {
        // left drift field but might still be on chapter mystery
        session.activeDriftId = null;
      }

      // Chapter mystery approach
      if (wp.kind === "mystery" && step.distDeg < MYSTERY_NEAR_DEG) {
        session.mysteryNear = true;
        if (state !== State.MYSTERY) {
          setState(State.MYSTERY);
          setWhisper(night.mystery.story_hook);
        }
      }

      if (step.distDeg < ARRIVE_DEG && wp.kind === "pin") {
        onArrivePin(wp);
      }
    }

    // While resting in MYSTERY, still allow claim; no forced exit
    renderMeters();
  }

  function onArrivePin(wp) {
    setState(State.ARRIVE);
    setWhisper(`${wp.pin.label} — ${wp.pin.note}`);
    markArrived(session, wp);
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
    night = await loadNight("soft-rainy-hold");
    await waitFor(() => typeof A !== "undefined", 8000);
    windshield.boot();
    windshield.whenReady(() => {
      setState(State.MENU);
      setWhisper(
        `${night.title}. ${night.whisper_start || "I want to see. I play."} Best wonder: ${loadBestScore()}.`
      );
      refreshOverlays();
      renderHousePins();
      if (el.btnBegin()) el.btnBegin().disabled = false;
      renderMeters();
    });
    cancelAnimationFrame(raf);
    lastTs = 0;
    raf = requestAnimationFrame(tick);
  }

  function beginFlight() {
    if (!night) return;
    // reload night data so claimed flags reset for a fresh flight
    loadNight("soft-rainy-hold").then((n) => {
      night = n;
      session = createFlightSession(night);
      session.startedAt = Date.now();
      session.navLog.push(`Night open: ${night.title}`);
      lowSpoonsWhispered = false;
      setThrottle(session, Number(el.throttle()?.value || 0.25));
      const first = night.pins[0]?.view;
      if (first) windshield.goto(first, { hard: true });
      setState(State.FLIGHT);
      setWhisper(night.whisper_start || "Glide when ready. Watch for ✧ glows.");
      refreshOverlays();
      renderHousePins();
      renderMeters();
    });
  }

  function nextHeading() {
    if (!session || !night) return;
    if (state === State.ARRIVE || state === State.MYSTERY) {
      setState(State.FLIGHT);
      session.activeDriftId = null;
      session.mysteryNear = false;
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
    setThrottle(session, 0);
    if (el.throttle()) el.throttle().value = "0";
    setWhisper("Rest. Spoons recover. No failure.");
  }

  function tryClaimMystery() {
    if (!session || !night) return;
    const view = windshield.getView();

    // Prefer active drift mystery if near
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
          kind: "drift",
        });
        setWhisper(`✧ ${label.trim()} — saved to house pins (+score).`);
        setState(State.FLIGHT);
        session.mysteryNear = false;
        session.activeDriftId = null;
        refreshOverlays();
        renderHousePins();
        renderMeters();
        return;
      }
    }

    // Chapter mystery
    const wp = currentWaypoint(night, session);
    if (wp?.kind === "mystery" || session.mysteryNear) {
      const label =
        window.prompt("Name this chapter mystery (yours alone):", "soft rainy glow") ||
        "";
      if (!label.trim()) {
        setWhisper("No name yet — that’s okay.");
        return;
      }
      claimChapterMystery(session, label.trim());
      night.mystery.claimed_label = label.trim();
      claimPin({
        label: label.trim(),
        note: night.mystery.story_hook,
        view,
        emotion: "wonder",
        nightId: night.id,
        kind: "chapter",
      });
      setWhisper(`✦ ${label.trim()} — chapter mystery claimed.`);
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
      kind: "personal",
    });
    if (session) recordFreePin(session);
    session?.navLog.push(`Pinned: ${pin.label}`);
    setWhisper(`📌 ${pin.label} saved (personal).`);
    refreshOverlays();
    renderHousePins();
    renderMeters();
  }

  function beginCloseout() {
    if (!session || !night) return;
    session.endedAt = Date.now();
    const best = saveBestScore(session.score);
    const lines = closeoutLines(session, night);
    lines.push(`Best wonder (house): ${best}`);
    session.navLog.push("--- closeout ---", ...lines);
    setState(State.CLOSEOUT);
    setWhisper(lines.join(" · "));
    if (el.navLog()) el.navLog().textContent = lines.join("\n");
    refreshOverlays();
    renderMeters();
  }

  el.btnBegin()?.addEventListener("click", () => {
    if (
      state === State.CLOSEOUT ||
      state === State.MENU ||
      state === State.BOOT
    ) {
      beginFlight();
    }
  });
  el.btnNext()?.addEventListener("click", nextHeading);
  el.btnSkip()?.addEventListener("click", skipFix);
  el.btnRest()?.addEventListener("click", rest);
  el.btnEnd()?.addEventListener("click", beginCloseout);
  el.btnPin()?.addEventListener("click", () => {
    if (state === State.MYSTERY || session?.mysteryNear || session?.activeDriftId) {
      tryClaimMystery();
    } else freePin();
  });
  el.throttle()?.addEventListener("input", (e) => {
    if (!session) return;
    setThrottle(session, e.target.value);
    if (session.resting) setWhisper("Resting — spoons recovering…");
    else if (session.spoons < 0.2)
      setWhisper("Easy on the throttle — spoons are thin.");
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
    if (e.key === " ") {
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
