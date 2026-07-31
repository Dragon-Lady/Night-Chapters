/**
 * Night Chapters game loop
 * BOOT → MENU → FLIGHT → ARRIVE | MYSTERY | REST → CLOSEOUT
 */

import { loadNight } from "./nights.js";
import { createWindshield } from "./windshield.js";
import {
  createFlightSession,
  currentWaypoint,
  markArrived,
  setThrottle,
  fuelOfNight,
  closeoutLines,
  ARRIVE_DEG,
} from "./flight.js";
import { claimPin, loadPersonalPins } from "./pins.js";

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

  const el = {
    whisper: () => document.getElementById("whisper"),
    state: () => document.getElementById("state-chip"),
    heading: () => document.getElementById("heading-bug"),
    throttle: () => document.getElementById("throttle"),
    fuel: () => document.getElementById("fuel"),
    pins: () => document.getElementById("pin-list"),
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
    syncButtons();
  }

  function syncButtons() {
    const flying = state === State.FLIGHT || state === State.ARRIVE || state === State.MYSTERY;
    if (el.btnBegin()) {
      el.btnBegin().disabled = !(
        state === State.MENU ||
        state === State.CLOSEOUT
      );
    }
    if (el.btnNext()) el.btnNext().disabled = !flying;
    if (el.btnSkip()) el.btnSkip().disabled = state !== State.ARRIVE && state !== State.FLIGHT;
    if (el.btnRest()) el.btnRest().disabled = !flying;
    if (el.btnEnd()) el.btnEnd().disabled = state === State.BOOT;
    if (el.btnPin()) el.btnPin().disabled = state === State.BOOT;
  }

  function renderPins() {
    const ul = el.pins();
    if (!ul || !night) return;
    ul.innerHTML = "";
    night.pins.forEach((p, i) => {
      const li = document.createElement("li");
      li.textContent = p.label;
      if (session?.fixesVisited.includes(p.id)) li.classList.add("done");
      if (session && i === session.pinIndex && state !== State.CLOSEOUT) {
        li.classList.add("current");
      }
      ul.appendChild(li);
    });
    if (night.mystery) {
      const li = document.createElement("li");
      li.textContent = session?.mysteryClaimed
        ? `✦ ${night.mystery.claimed_label || "mystery"}`
        : "✦ mystery";
      if (session?.mysteryClaimed) li.classList.add("done");
      if (session && session.pinIndex >= night.pins.length && !session.mysteryClaimed) {
        li.classList.add("current");
      }
      ul.appendChild(li);
    }
  }

  function renderMeters() {
    const wp = night && session ? currentWaypoint(night, session) : null;
    if (el.heading()) {
      el.heading().textContent = wp
        ? wp.kind === "mystery"
          ? "mystery glow"
          : wp.pin.label
        : "—";
    }
    if (el.fuel() && session) {
      const f = fuelOfNight(session);
      el.fuel().textContent = `${Math.round(f * 100)}% spoons`;
    }
    if (el.navLog() && session) {
      el.navLog().textContent = session.navLog.slice(-5).join("\n") || "Nav log empty — soft start.";
    }
    renderPins();
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!session || !night || !windshield.ready) return;

    if (state === State.FLIGHT && !session.resting && session.throttle > 0.04) {
      const wp = currentWaypoint(night, session);
      if (!wp) {
        beginCloseout();
        return;
      }
      const step = windshield.glideStep(wp.view, session.throttle);
      if (typeof ui?.onGlide === "function") ui.onGlide(step, wp);

      if (wp.kind === "mystery" && step.distDeg < 1.2) {
        session.mysteryNear = true;
        if (state !== State.MYSTERY) {
          setState(State.MYSTERY);
          setWhisper(night.mystery.story_hook);
        }
      }

      if (step.distDeg < ARRIVE_DEG) {
        if (wp.kind === "pin") {
          onArrivePin(wp);
        }
      }
    }

    renderMeters();
  }

  function onArrivePin(wp) {
    setState(State.ARRIVE);
    setWhisper(`${wp.pin.label} — ${wp.pin.note}`);
    markArrived(session, wp);
    if (wp.pin.beat === "sit") {
      clearTimeout(sitTimer);
      sitTimer = setTimeout(() => {
        if (state === State.ARRIVE) {
          setWhisper("Whenever you’re ready — Next heading, or rest.");
        }
      }, 4000);
    } else if (wp.pin.beat === "emotion_word") {
      setWhisper(
        `${wp.pin.note} (Type is optional later — for now, feel one word and press Next.)`
      );
    }
    renderMeters();
  }

  async function boot() {
    setState(State.BOOT);
    setWhisper("Warming the glass…");
    night = await loadNight("soft-rainy-hold");
    // Wait for Aladin global
    await waitFor(() => typeof A !== "undefined", 8000);
    windshield.boot();
    windshield.whenReady(() => {
      setState(State.MENU);
      setWhisper(
        `${night.title}. ${night.whisper_start || "I want to see. I play."}`
      );
      if (el.btnBegin()) el.btnBegin().disabled = false;
      renderMeters();
    });
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function beginFlight() {
    if (!night) return;
    session = createFlightSession(night);
    session.startedAt = Date.now();
    session.navLog.push(`Night open: ${night.title}`);
    setThrottle(session, Number(el.throttle()?.value || 0.25));
    const first = night.pins[0]?.view;
    if (first) windshield.goto(first, { hard: true });
    setState(State.FLIGHT);
    setWhisper(night.whisper_start || "Glide when ready.");
    renderMeters();
  }

  function nextHeading() {
    if (!session || !night) return;
    if (state === State.ARRIVE) {
      setState(State.FLIGHT);
    }
    const wp = currentWaypoint(night, session);
    if (!wp) {
      beginCloseout();
      return;
    }
    // Soft nudge: slight throttle bump if parked
    if (session.throttle < 0.1) setThrottle(session, 0.3);
    if (el.throttle()) el.throttle().value = String(session.throttle);
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
      session.navLog.push(`Skipped: ${wp.pin.label} (allowed)`);
      session.pinIndex += 1;
      setState(State.FLIGHT);
      setWhisper("Skipped. The night still counts.");
      renderMeters();
    }
  }

  function rest() {
    if (!session) return;
    setThrottle(session, 0);
    if (el.throttle()) el.throttle().value = "0";
    setWhisper("Rest. Fuel of the night softens. No failure.");
    if (state === State.FLIGHT || state === State.ARRIVE || state === State.MYSTERY) {
      /* stay in state; resting flag handles glide pause */
    }
  }

  function tryClaimMystery() {
    if (!session || !night) return;
    const view = windshield.getView();
    const label =
      window.prompt("Name this mystery (yours alone):", "soft rainy glow") ||
      "";
    if (!label.trim()) {
      setWhisper("No name yet — that’s okay. Come back when you want.");
      return;
    }
    const pin = claimPin({
      label: label.trim(),
      note: night.mystery.story_hook,
      view,
      emotion: "wonder",
      nightId: night.id,
    });
    session.mysteryClaimed = true;
    night.mystery.claimed_label = pin.label;
    session.navLog.push(`Mystery claimed: ${pin.label}`);
    setWhisper(`✦ ${pin.label} — pinned to your house list.`);
    setState(State.FLIGHT);
    renderMeters();
    // After mystery, closeout is natural
    setTimeout(() => beginCloseout(), 1200);
  }

  function freePin() {
    const view = windshield.getView();
    const label =
      window.prompt("Personal pin label:", "house light") || "";
    if (!label.trim()) return;
    const pin = claimPin({
      label: label.trim(),
      view,
      nightId: night?.id,
    });
    session?.navLog.push(`Pinned: ${pin.label}`);
    setWhisper(`📌 ${pin.label} saved (personal).`);
    renderMeters();
  }

  function beginCloseout() {
    if (!session || !night) return;
    session.endedAt = Date.now();
    const lines = closeoutLines(session, night);
    session.navLog.push("--- closeout ---", ...lines);
    setState(State.CLOSEOUT);
    setWhisper(lines.join(" · "));
    if (el.navLog()) el.navLog().textContent = lines.join("\n");
    renderMeters();
  }

  // UI bindings
  el.btnBegin()?.addEventListener("click", () => {
    if (state === State.CLOSEOUT || state === State.MENU || state === State.BOOT) {
      beginFlight();
    }
  });
  el.btnNext()?.addEventListener("click", nextHeading);
  el.btnSkip()?.addEventListener("click", skipFix);
  el.btnRest()?.addEventListener("click", rest);
  el.btnEnd()?.addEventListener("click", beginCloseout);
  el.btnPin()?.addEventListener("click", () => {
    if (state === State.MYSTERY || session?.mysteryNear) tryClaimMystery();
    else freePin();
  });
  el.throttle()?.addEventListener("input", (e) => {
    if (!session) return;
    setThrottle(session, e.target.value);
    if (session.resting) setWhisper("Resting in the glass…");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "p" || e.key === "P") {
      if (e.target.matches("input, textarea")) return;
      e.preventDefault();
      if (state === State.MYSTERY || session?.mysteryNear) tryClaimMystery();
      else freePin();
    }
    if (e.key === " ") {
      if (e.target.matches("input, textarea")) return;
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
