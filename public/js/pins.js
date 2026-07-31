/**
 * Personal pin house — localStorage mythology.
 * View, fly-to, delete. Easy create; easy forget.
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
  chapterTitle = "",
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
    chapterTitle: chapterTitle || null,
    view: {
      ra: view.ra,
      dec: view.dec,
      fov: view.fov ?? 1.5,
    },
    created_at: new Date().toISOString(),
  };
  pins.unshift(pin);
  savePersonalPins(pins.slice(0, 60));
  return pin;
}

export function deletePin(id) {
  const next = loadPersonalPins().filter((p) => p.id !== id);
  savePersonalPins(next);
  return next;
}

export function clearAllPins() {
  savePersonalPins([]);
  return [];
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

/**
 * Full house list UI — filterable, fly-to, delete.
 */
export function renderPersonalPinList(
  container,
  { onFly, onDelete, onClear, filterNightId = null } = {}
) {
  if (!container) return;
  let pins = loadPersonalPins();
  if (filterNightId) {
    pins = pins.filter((p) => p.nightId === filterNightId);
  }

  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "house-header";
  header.innerHTML = `
    <span class="house-count">${pins.length} pin${pins.length === 1 ? "" : "s"}</span>
    <button type="button" class="house-clear" ${pins.length ? "" : "disabled"} title="Clear all house pins">Clear all</button>
  `;
  header.querySelector(".house-clear")?.addEventListener("click", () => {
    if (!pins.length) return;
    if (
      !window.confirm(
        "Clear all house pins? This only removes saved pins, not chapter progress."
      )
    ) {
      return;
    }
    clearAllPins();
    renderPersonalPinList(container, { onFly, onDelete, onClear, filterNightId });
    onClear?.();
  });
  container.appendChild(header);

  if (!pins.length) {
    const empty = document.createElement("p");
    empty.className = "pin-empty";
    empty.innerHTML =
      "No house pins yet — press <kbd>P</kbd> when something feels yours.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "house-pin-list";

  for (const p of pins) {
    const row = document.createElement("div");
    row.className = `house-pin kind-${p.kind || "personal"}`;
    const when = p.created_at
      ? new Date(p.created_at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "";
    row.innerHTML = `
      <div class="house-pin-main">
        <button type="button" class="house-pin-fly" title="Fly to this pin">
          📌 ${escapeHtml(p.label)}
        </button>
        <span class="house-pin-meta">
          ${escapeHtml(p.emotion || "wonder")}
          · ${escapeHtml(p.kind || "personal")}
          ${p.chapterTitle ? ` · ${escapeHtml(p.chapterTitle)}` : ""}
          ${when ? ` · ${when}` : ""}
        </span>
        ${p.note ? `<span class="house-pin-note">${escapeHtml(p.note.slice(0, 120))}</span>` : ""}
      </div>
      <div class="house-pin-actions">
        <button type="button" class="house-pin-fly-btn" title="Fly here">Fly</button>
        <button type="button" class="house-pin-del" title="Remove" aria-label="Delete pin">×</button>
      </div>
    `;
    const fly = () => onFly?.(p);
    row.querySelector(".house-pin-fly")?.addEventListener("click", fly);
    row.querySelector(".house-pin-fly-btn")?.addEventListener("click", fly);
    row.querySelector(".house-pin-del")?.addEventListener("click", () => {
      deletePin(p.id);
      renderPersonalPinList(container, {
        onFly,
        onDelete,
        onClear,
        filterNightId,
      });
      onDelete?.(p);
    });
    list.appendChild(row);
  }
  container.appendChild(list);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
