/**
 * Personal pin house — localStorage mythology.
 * View, fly-to, delete. Easy create; easy forget.
 */

const STORAGE_KEY = "night-chapters.personalPins.v1";
const SCORE_KEY = "night-chapters.bestWonderScore.v1";
const CHAPTER_SCORE_KEY = "night-chapters.chapterBest.v1";
/** One-shot scrub rev — bumps when chapter sky layouts move */
const PIN_SCRUB_KEY = "night-chapters.pinScrub.v1";
const PIN_SCRUB_REV = "gumdrop-spread-1.7.64";

/**
 * Pre-spread Gumdrop cluster (≤ v1.7.58). These coords pancake at Porch and
 * must not linger after the full-sky layout.
 */
export const GUMDROP_STALE_COORDS = [
  { ra: 298.2, dec: 7.5 }, // old summer porch rail
  { ra: 288.0, dec: 24.0 }, // old gumdrop spark
  { ra: 305.0, dec: 40.0 }, // old candy dust
  { ra: 290.5, dec: 28.5 }, // old the gumdrop
  { ra: 300.0, dec: 20.0 }, // old sticky ribbon
  { ra: 285.0, dec: 15.0 }, // old warm bank
];

/** Labels that moved with the Gumdrop spread (orphan free pins). */
const GUMDROP_MOVED_LABELS =
  /porch rail|gumdrop spark|candy dust|the gumdrop|sticky ribbon|warm bank/i;

function skyDistDeg(ra0, dec0, ra1, dec1) {
  const cos = Math.cos((((Number(dec0) + Number(dec1)) / 2) * Math.PI) / 180) || 1;
  let dRa = Number(ra1) - Number(ra0);
  while (dRa > 180) dRa -= 360;
  while (dRa < -180) dRa += 360;
  return Math.hypot(dRa * cos, Number(dec1) - Number(dec0));
}

function nearAny(ra, dec, list, tolDeg = 2.5) {
  if (ra == null || dec == null || !list?.length) return false;
  for (const s of list) {
    const sra = s.ra ?? s[0];
    const sdec = s.dec ?? s[1];
    if (skyDistDeg(ra, dec, sra, sdec) <= tolDeg) return true;
  }
  return false;
}

/** Live sky points from current night JSON (pins, drifts, mystery, house). */
export function liveNightSkyPoints(night) {
  const out = [];
  if (!night) return out;
  for (const p of night.pins || []) {
    if (p?.view) out.push({ ra: p.view.ra, dec: p.view.dec, label: p.label });
  }
  for (const m of night.drift_mysteries || night.mysteries || []) {
    if (m?.seed)
      out.push({
        ra: m.seed.ra,
        dec: m.seed.dec,
        label: m.claimed_label || m.label,
      });
  }
  if (night.mystery?.seed) {
    out.push({
      ra: night.mystery.seed.ra,
      dec: night.mystery.seed.dec,
      label: night.mystery.claimed_label || night.mystery.label,
    });
  }
  for (const hp of night.house_pins || []) {
    if (hp?.view)
      out.push({ ra: hp.view.ra, dec: hp.view.dec, label: hp.label });
  }
  return out;
}

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
 * Drop pre-spread Gumdrop free pins and other orphans that still paint
 * old clustered coords. Stable house pins (stableId house-pin:…) are kept
 * so Begin can refresh them from night JSON.
 *
 * @returns {{ removed: number, pins: object[], scrubbed: boolean }}
 */
export function scrubStaleChapterPins(night, { force = false } = {}) {
  const pins = loadPersonalPins();
  if (!night?.id) return { removed: 0, pins, scrubbed: false };

  let lastRev = null;
  try {
    lastRev = localStorage.getItem(PIN_SCRUB_KEY);
  } catch {
    /* ignore */
  }
  // Always run when force, or when rev changed, or when night is gumdrop
  // (every Begin on gumdrop re-checks stale coords).
  const should =
    force ||
    lastRev !== PIN_SCRUB_REV ||
    night.id === "gumdrop-summer";
  if (!should) return { removed: 0, pins, scrubbed: false };

  const live = liveNightSkyPoints(night);
  const next = [];
  let removed = 0;

  for (const p of pins) {
    const ra = p.view?.ra ?? p.ra;
    const dec = p.view?.dec ?? p.dec;
    const pinNight = p.nightId || p.chapterId || null;
    const stable = String(p.stableId || "");

    // Keep / refresh stable house pins for this night (coords updated by claimPin)
    if (stable.startsWith(`house-pin:${night.id}:`)) {
      next.push(p);
      continue;
    }
    if (stable.startsWith(`house-drift:${night.id}:`)) {
      // Drift house names: drop if seed moved and pin is no longer near live
      if (
        Number.isFinite(ra) &&
        Number.isFinite(dec) &&
        !nearAny(ra, dec, live, 3.5)
      ) {
        removed += 1;
        continue;
      }
      next.push(p);
      continue;
    }

    // Pre-spread Gumdrop pancake coords → remove (tol tight so Altair porch free pin survives)
    // Old rail (298.2, 7.5) is ~1.5° from Porch star — keep tol ≤ 1.2°
    if (
      night.id === "gumdrop-summer" &&
      Number.isFinite(Number(ra)) &&
      Number.isFinite(Number(dec)) &&
      nearAny(ra, dec, GUMDROP_STALE_COORDS, 1.2)
    ) {
      removed += 1;
      continue;
    }

    // Gumdrop free pins whose labels moved with the spread
    if (
      night.id === "gumdrop-summer" &&
      (pinNight === "gumdrop-summer" ||
        GUMDROP_MOVED_LABELS.test(String(p.label || ""))) &&
      Number.isFinite(Number(ra)) &&
      Number.isFinite(Number(dec)) &&
      !nearAny(ra, dec, live, 3.5) &&
      GUMDROP_MOVED_LABELS.test(String(p.label || ""))
    ) {
      removed += 1;
      continue;
    }

    next.push(p);
  }

  if (removed > 0) savePersonalPins(next.slice(0, 60));
  try {
    localStorage.setItem(PIN_SCRUB_KEY, PIN_SCRUB_REV);
  } catch {
    /* ignore */
  }

  return { removed, pins: next, scrubbed: true };
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
  stableId = null,
}) {
  const pins = loadPersonalPins();
  const clean = (label || "untitled glow").trim().slice(0, 80);
  // Stable house names (e.g. chapter JSON) — update in place, no duplicate
  if (stableId) {
    const idx = pins.findIndex((p) => p.stableId === stableId);
    if (idx >= 0) {
      pins[idx] = {
        ...pins[idx],
        label: clean,
        note: note || pins[idx].note,
        emotion,
        kind,
        nightId: nightId || pins[idx].nightId,
        chapterTitle: chapterTitle || pins[idx].chapterTitle,
        view: view
          ? {
              ra: view.ra,
              dec: view.dec,
              fov: view.fov ?? pins[idx].view?.fov ?? 1.5,
            }
          : pins[idx].view,
        updated_at: new Date().toISOString(),
      };
      savePersonalPins(pins.slice(0, 60));
      return pins[idx];
    }
  }
  const pin = {
    id: `pin-${Date.now().toString(36)}`,
    stableId: stableId || null,
    label: clean,
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
