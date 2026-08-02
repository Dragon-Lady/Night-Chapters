/**
 * Night Chapters — entry
 * Tagline: I want to see. I play.
 * NC_BUILD 1.7.64 — Gumdrop wide FoV peripheral
 */

// Ribbon default = unvisited story pin; candy/house soft-steal when close

const NC_BUILD = "1.7.64";

import { bindKeys } from "./keys.js?v=1.7.64";
import { startGame, CORE_LOOP_VERSION } from "./game-loop.js?v=1.7.64";

// Bind keyboard shell before game / sky boot
bindKeys();

function main() {
  const root = document.getElementById("app");
  if (!root) {
    console.error("No #app");
    return;
  }

  try {
    document.body.tabIndex = -1;
  } catch {
    /* ignore */
  }

  try {
    window.__ncBuild = CORE_LOOP_VERSION || NC_BUILD;
    console.info(`[Night Chapters] build ${window.__ncBuild} · scanner live`);
  } catch {
    /* ignore */
  }

  startGame({
    onGlide(step) {
      // FX already driven from windshield; hook kept for companions later
      if (step?.speed > 0.5) {
        document.getElementById("sky-stage")?.classList.add("is-gliding");
      }
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
