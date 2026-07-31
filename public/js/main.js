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
    onGlide() {
      /* reserved for future companion crumbs */
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
