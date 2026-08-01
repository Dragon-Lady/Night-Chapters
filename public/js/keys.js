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
}

export function setKeyHandler(fn) {
  userHandler = fn;
  bindKeys();
  // expose for console diagnosis: window.__ncKeyHandlerAlive
  try {
    window.__ncKeys = {
      hasHandler: !!userHandler,
      bound,
      focusShell,
      ping: () => "nc-keys-alive",
    };
  } catch {
    /* ignore */
  }
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
      "Night Chapters keyboard focus. W S throttle, Space rest, Esc menu."
    );
    sink.className = "nc-key-sink";
    document.body.appendChild(sink);
    // Direct listener on the sink (in addition to window capture)
    sink.addEventListener(
      "keydown",
      (e) => {
        dispatch(e);
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
    if (ae && ae.tagName === "CANVAS") {
      try {
        ae.blur();
      } catch {
        /* ignore */
      }
    }
    // Blur any contenteditable / aladin internals
    if (ae && ae !== document.body && ae.id !== "nc-key-sink") {
      if (ae.closest && ae.closest("#aladin-lite-div, #sky-stage, .aladin-container")) {
        try {
          ae.blur();
        } catch {
          /* ignore */
        }
      }
    }
    document.body.tabIndex = -1;
    const sink = ensureKeySink();
    if (sink) {
      sink.focus({ preventScroll: true });
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

// Bind at parse time in browser (before Aladin.aladin in startGame)
if (typeof window !== "undefined") {
  bindKeys();
}
