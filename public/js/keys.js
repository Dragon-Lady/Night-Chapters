/**
 * Global keyboard capture for Night Chapters.
 *
 * CRITICAL: bind once, as early as possible, and NEVER remove the first
 * window capture listener. Aladin may register later with
 * stopImmediatePropagation — if we rebind after Aladin we become *second*
 * and never receive keys during flight.
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
      console.error("Night Chapters key handler error:", err);
    }
  }
}

let bound = false;

/**
 * Attach capture listener once on window (first in line if called before Aladin.aladin).
 */
export function bindKeys() {
  if (bound) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  bound = true;
  window.addEventListener("keydown", dispatch, {
    capture: true,
    passive: false,
  });
  // Extra safety nets (deduped via WeakSet)
  document.addEventListener("keydown", dispatch, {
    capture: true,
    passive: false,
  });
  window.addEventListener("keydown", dispatch, {
    capture: false,
    passive: false,
  });
}

/**
 * Register / replace the game key handler. Does not tear down listeners.
 */
export function setKeyHandler(fn) {
  userHandler = fn;
  bindKeys();
}

/**
 * Keep handler hot after Begin / Aladin interactions.
 * Does NOT remove the original capture listener (that would put us behind Aladin).
 */
export function rebindKeys() {
  bindKeys();
  // Soft focus reclaim so canvas focus doesn't strand input on some browsers
  try {
    if (document.body && document.activeElement) {
      const ae = document.activeElement;
      if (
        ae === document.body ||
        ae === document.documentElement ||
        (ae.tagName === "CANVAS") ||
        (ae.classList && ae.classList.contains("aladin-location"))
      ) {
        /* keep or reclaim below */
      }
      if (ae && ae.tagName === "CANVAS") {
        ae.blur();
      }
    }
    if (document.body) {
      document.body.tabIndex = -1;
      document.body.focus({ preventScroll: true });
    }
  } catch {
    /* ignore */
  }
}

export function focusShell() {
  try {
    if (typeof document === "undefined") return;
    const ae = document.activeElement;
    if (ae && ae.tagName === "CANVAS") {
      try {
        ae.blur();
      } catch {
        /* ignore */
      }
    }
    document.body.tabIndex = -1;
    document.body.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

// Attach as soon as this module evaluates in the browser (before Aladin.aladin())
if (typeof window !== "undefined") {
  bindKeys();
}
