/**
 * Night Chapters — entry
 * Tagline: I want to see. I play.
 */

import { startGame } from "./game-loop.js";

function main() {
  const root = document.getElementById("app");
  if (!root) {
    console.error("No #app");
    return;
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
