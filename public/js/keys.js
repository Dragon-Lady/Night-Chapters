/**
 * Global keyboard for Night Chapters — attach once, stay first, never tear down.
 *
 * Strategy:
 * 1. window capture listener registered at module load (before A.aladin())
 * 2. Never removeEventListener — rebind only refreshes the handler + focus
 * 3. Optional #nc-key-sink focus target so keys have a home after Begin
 * 4. Event dedupe across capture/bubble
 */

let userHandler = null;
let userKeyUpHandler = null;
const seen = new WeakSet();

function dispatch(e) {
  if (seen.has(e)) return;
  seen.add(e);
  if (typeof userHandler === "function") {
    try {
      userHandler(e);
    } catch (err) {
      console.error("[NC keys]", err);
    }
  }
}

function dispatchUp(e) {
  if (typeof userKeyUpHandler === "function") {
    try {
      userKeyUpHandler(e);
    } catch (err) {
      console.error("[NC keys up]", err);
    }
  }
}

let bound = false;

export function bindKeys() {
  if (bound) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  bound = true;
  const opts = { capture: true, passive: false };
  window.addEventListener("keydown", dispatch, opts);
  document.addEventListener("keydown", dispatch, opts);
  // bubble backup (deduped)
  window.addEventListener("keydown", dispatch, false);
  // keyup for held steer (A/D · arrows)
  window.addEventListener("keyup", dispatchUp, opts);
  document.addEventListener("keyup", dispatchUp, opts);
}

export function setKeyHandler(fn) {
  userHandler = fn;
  bindKeys();
  try {
    window.__ncKeys = {
      hasHandler: !!userHandler,
      hasKeyUp: !!userKeyUpHandler,
      bound,
      focusShell,
      ping: () => "nc-keys-alive",
    };
  } catch {
    /* ignore */
  }
}

export function setKeyUpHandler(fn) {
  userKeyUpHandler = fn;
  bindKeys();
}

/**
 * Ensure a focusable sink exists and holds focus during flight.
 * pointer-events:none so it never blocks clicks on the sky.
 */
export function ensureKeySink() {
  if (typeof document === "undefined") return null;
  let sink = document.getElementById("nc-key-sink");
  if (!sink) {
    sink = document.createElement("div");
    sink.id = "nc-key-sink";
    sink.tabIndex = 0;
    sink.setAttribute("role", "application");
    sink.setAttribute(
      "aria-label",
      "Night Chapters keyboard. W S throttle, A D steer, Space rest, Esc menu."
    );
    sink.className = "nc-key-sink";
    document.body.appendChild(sink);
    // Direct listeners on the sink (keydown + keyup for held steer)
    sink.addEventListener(
      "keydown",
      (e) => {
        dispatch(e);
      },
      true
    );
    sink.addEventListener(
      "keyup",
      (e) => {
        dispatchUp(e);
      },
      true
    );
  }
  return sink;
}

export function focusShell() {
  if (typeof document === "undefined") return;
  try {
    const ae = document.activeElement;
    // Prefer the sky stage when flying — it's the visible click target
    const stage = document.getElementById("sky-stage");
    const phase = document.body?.dataset?.phase || "";
    const flying =
      phase === "FLIGHT" ||
      phase === "MYSTERY" ||
      phase === "ARRIVE" ||
      phase === "REST";

    // Blur instrument traps (not the stage itself)
    if (
      ae &&
      ae !== document.body &&
      ae.id !== "nc-key-sink" &&
      ae.id !== "sky-stage" &&
      ae.closest &&
      ae.closest("#instruments, #instruments-body, .modal-screen, .reflection-screen")
    ) {
      try {
        ae.blur();
      } catch {
        /* ignore */
      }
    }

    document.body.tabIndex = -1;
    if (flying && stage && typeof stage.focus === "function") {
      try {
        stage.focus({ preventScroll: true });
        return;
      } catch {
        /* fall through to sink */
      }
    }
    const sink = ensureKeySink();
    if (sink) {
      sink.focus({ preventScroll: true });
    } else if (stage) {
      stage.focus({ preventScroll: true });
    } else {
      document.body.focus({ preventScroll: true });
    }
  } catch {
    /* ignore */
  }
}

/** After Begin: keep handler + focus without removing capture listeners */
export function rebindKeys() {
  bindKeys();
  focusShell();
}

// Bind at parse time in browser (before game / sky boot)
if (typeof window !== "undefined") {
  bindKeys();
}
