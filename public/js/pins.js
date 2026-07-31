/**
 * Personal pins as waypoints — house mythology on the glass.
 * Visuals + localStorage save. Easy create; easy forget.
 */

const STORAGE_KEY = "night-chapters.personalPins.v1";
const SCORE_KEY = "night-chapters.bestWonderScore.v1";
const CHAPTER_SCORE_KEY = "night-chapters.chapterBest.v1";

export function loadPersonalPins() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function savePersonalPins(pins) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
}

/**
 * Claim a mystery (or free pin) at current view.
 */
export function claimPin({
  label,
  note = "",
  view,
  emotion = "wonder",
  nightId,
  kind = "personal",
}) {
  const pins = loadPersonalPins();
  const pin = {
    id: `pin-${Date.now().toString(36)}`,
    label: (label || "untitled glow").trim().slice(0, 80),
    note,
    emotion,
    kind, // personal | drift | chapter | story
    personal: true,
    nightId: nightId || null,
    view: {
      ra: view.ra,
      dec: view.dec,
      fov: view.fov ?? 1.5,
    },
    created_at: new Date().toISOString(),
  };
  pins.unshift(pin);
  savePersonalPins(pins.slice(0, 40));
  return pin;
}

export function deletePin(id) {
  const next = loadPersonalPins().filter((p) => p.id !== id);
  savePersonalPins(next);
  return next;
}

export function loadBestScore() {
  try {
    return Number(localStorage.getItem(SCORE_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

export function saveBestScore(score) {
  const prev = loadBestScore();
  if (score > prev) {
    localStorage.setItem(SCORE_KEY, String(score));
    return score;
  }
  return prev;
}

export function loadChapterBests() {
  try {
    const raw = localStorage.getItem(CHAPTER_SCORE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Save best wonder score for a single chapter id */
export function saveChapterBest(nightId, score) {
  if (!nightId) return score;
  const all = loadChapterBests();
  const prev = Number(all[nightId] || 0) || 0;
  if (score > prev) {
    all[nightId] = score;
    localStorage.setItem(CHAPTER_SCORE_KEY, JSON.stringify(all));
    return score;
  }
  return prev;
}

export function getChapterBest(nightId) {
  const all = loadChapterBests();
  return Number(all[nightId] || 0) || 0;
}

/** Render house pin chips into a container */
export function renderPersonalPinList(container, { onFly, onDelete } = {}) {
  if (!container) return;
  const pins = loadPersonalPins();
  container.innerHTML = "";
  if (!pins.length) {
    container.innerHTML =
      '<p class="pin-empty">No house pins yet — press <kbd>P</kbd> when something feels yours.</p>';
    return;
  }
  for (const p of pins) {
    const row = document.createElement("div");
    row.className = `house-pin kind-${p.kind || "personal"}`;
    row.innerHTML = `
      <button type="button" class="house-pin-fly" title="Fly here">📌 ${escapeHtml(
        p.label
      )}</button>
      <span class="house-pin-meta">${escapeHtml(p.emotion || "")} · ${
      p.kind || "personal"
    }</span>
      <button type="button" class="house-pin-del" title="Remove" aria-label="Delete pin">×</button>
    `;
    row.querySelector(".house-pin-fly")?.addEventListener("click", () => {
      onFly?.(p);
    });
    row.querySelector(".house-pin-del")?.addEventListener("click", () => {
      deletePin(p.id);
      renderPersonalPinList(container, { onFly, onDelete });
      onDelete?.(p);
    });
    container.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
