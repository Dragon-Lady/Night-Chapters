/**
 * Global keyboard capture for Night Chapters.
 * Attaches early and can re-bind after Aladin init so flight keys
 * always win over the sky canvas.
 */

let userHandler = null;
const seen = new WeakSet();

function dispatch(e) {
  // Same event can hit capture + bubble or window + document — run once
  if (seen.has(e)) return;
  seen.add(e);
  if (typeof userHandler === "function") {
    try {
      userHandler(e);
    } catch (err) {
      console.error("Night Chapters key handler error:", err);
    }
  }
}

let bound = false;

export function bindKeys() {
  if (bound) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  bound = true;
  // Capture first on window (top of path)
  window.addEventListener("keydown", dispatch, true);
  // Bubble fallback if something stops capture mid-path (rare)
  window.addEventListener("keydown", dispatch, false);
  document.addEventListener("keydown", dispatch, true);
}

/**
 * Register the game key handler. Safe to call multiple times (replaces).
 */
export function setKeyHandler(fn) {
  userHandler = fn;
  bindKeys();
}

/** Call after Aladin boot in case it registered competing listeners */
export function rebindKeys() {
  // Re-add so we are last among capture listeners if Aladin stole the phase
  window.removeEventListener("keydown", dispatch, true);
  window.removeEventListener("keydown", dispatch, false);
  document.removeEventListener("keydown", dispatch, true);
  bound = false;
  bindKeys();
}

// Attach as soon as this module evaluates (before Aladin.aladin() in startGame)
bindKeys();
