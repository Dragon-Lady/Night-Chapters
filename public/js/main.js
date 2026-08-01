/**
 * Night Chapters — entry
 * Tagline: I want to see. I play.
 */

import { bindKeys } from "./keys.js";
import { startGame } from "./game-loop.js";

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
