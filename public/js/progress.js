/**
 * Persistent progress — completed chapters, scores, reflections.
 * localStorage only. Wonder-first; never punitive.
 */

const PROGRESS_KEY = "night-chapters.progress.v1";
const REFLECTIONS_KEY = "night-chapters.reflections.v1";

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) {
      return {
        completed: {},
        flights: 0,
        totalDiscoveries: 0,
        updated_at: null,
      };
    }
    const data = JSON.parse(raw);
    return {
      completed: data.completed && typeof data.completed === "object" ? data.completed : {},
      flights: Number(data.flights || 0) || 0,
      totalDiscoveries: Number(data.totalDiscoveries || 0) || 0,
      updated_at: data.updated_at || null,
    };
  } catch {
    return {
      completed: {},
      flights: 0,
      totalDiscoveries: 0,
      updated_at: null,
    };
  }
}

function saveProgress(p) {
  p.updated_at = new Date().toISOString();
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  return p;
}

/**
 * Record a finished night.
 * @param {{nightId, title, score, discoveries, perfect, summary}} run
 */
export function recordChapterComplete(run) {
  const p = loadProgress();
  const id = run.nightId;
  if (!id) return p;

  const prev = p.completed[id] || {
    nightId: id,
    title: run.title,
    times: 0,
    bestScore: 0,
    lastScore: 0,
    perfect: false,
    lastAt: null,
  };

  prev.times = (prev.times || 0) + 1;
  prev.lastScore = run.score || 0;
  prev.bestScore = Math.max(prev.bestScore || 0, run.score || 0);
  prev.perfect = prev.perfect || !!run.perfect;
  prev.lastAt = new Date().toISOString();
  prev.title = run.title || prev.title;
  prev.lastDiscoveries = run.discoveries || 0;

  p.completed[id] = prev;
  p.flights = (p.flights || 0) + 1;
  p.totalDiscoveries =
    (p.totalDiscoveries || 0) + (run.discoveries || 0);
  return saveProgress(p);
}

export function isChapterCompleted(nightId) {
  const p = loadProgress();
  return !!(p.completed[nightId] && p.completed[nightId].times > 0);
}

export function getChapterProgress(nightId) {
  return loadProgress().completed[nightId] || null;
}

export function completedCount() {
  return Object.keys(loadProgress().completed || {}).length;
}

/** Soft reflection lines from a session closeout */
export function buildReflection(session, night) {
  const disc = session
    ? (session.discovered?.storyPins?.length || 0) +
      (session.discovered?.driftMysteries?.length || 0) +
      (session.discovered?.chapterMystery ? 1 : 0) +
      (session.discovered?.freePins || 0)
    : 0;

  const lines = [];
  lines.push(
    `You flew **${night?.title || session?.nightId || "a night"}**.`
  );

  if (session?.discovered?.storyPins?.length) {
    lines.push(
      `Story lights you touched: ${session.discovered.storyPins.length} of ${(night?.pins || []).length}.`
    );
  } else {
    lines.push("You kept the glass soft — even without every pin.");
  }

  if (session?.discovered?.driftMysteries?.length) {
    lines.push(
      `Drift glows you named: ${session.discovered.driftMysteries.length}.`
    );
  }
  if (session?.discovered?.chapterMystery) {
    lines.push(
      `Chapter mystery: “${night?.mystery?.claimed_label || "yours"}”.`
    );
  }
  if (session?.discovered?.freePins) {
    lines.push(`House pins placed tonight: ${session.discovered.freePins}.`);
  }
  if (session?.perfectBonusApplied) {
    lines.push("Perfect chapter — every ribbon light found.");
  }

  lines.push(`Wonder score this flight: ${session?.score ?? 0}.`);
  lines.push(
    disc
      ? "The sky remembered you a little more."
      : "Rest counts. The fort door stays open."
  );

  return {
    nightId: night?.id || session?.nightId,
    title: night?.title || "",
    score: session?.score || 0,
    discoveries: disc,
    perfect: !!session?.perfectBonusApplied,
    lines,
    at: new Date().toISOString(),
  };
}

export function saveReflection(reflection) {
  try {
    const raw = localStorage.getItem(REFLECTIONS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(reflection);
    localStorage.setItem(
      REFLECTIONS_KEY,
      JSON.stringify(arr.slice(0, 20))
    );
  } catch {
    /* ignore */
  }
  return reflection;
}

/**
 * Journal a house naming (drift / chapter) so it persists in reflections.
 * Dedupes by nightId + glowId + label so Begin doesn't spam.
 */
export function recordNamingEvent({
  nightId,
  nightTitle,
  glowId,
  label,
  kind = "drift",
  storyHook = "",
  note = "",
}) {
  const name = (label || "").trim();
  if (!name || !nightId) return null;

  const existing = loadReflections();
  const already = existing.some(
    (r) =>
      r?.kind === "naming" &&
      r.nightId === nightId &&
      r.glowId === glowId &&
      r.label === name
  );
  if (already) return existing.find(
    (r) =>
      r?.kind === "naming" &&
      r.nightId === nightId &&
      r.glowId === glowId &&
      r.label === name
  );

  const reflection = {
    kind: "naming",
    nightId,
    title: nightTitle || nightId,
    glowId: glowId || null,
    label: name,
    glowKind: kind,
    score: 0,
    discoveries: 0,
    perfect: false,
    lines: [
      `Named a ${kind === "chapter" ? "chapter" : "drift"} glow on **${nightTitle || nightId}**.`,
      `“${name}”`,
      storyHook ? `Hook: ${storyHook}` : null,
      note || "The sky kept the name.",
    ].filter(Boolean),
    at: new Date().toISOString(),
  };
  return saveReflection(reflection);
}

export function loadReflections() {
  try {
    const raw = localStorage.getItem(REFLECTIONS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// re-export keys for docs / export tooling
export const STORAGE = {
  PROGRESS_KEY,
  REFLECTIONS_KEY,
};

/** Render progress summary strip */
export function renderProgressSummary(container) {
  if (!container) return;
  const p = loadProgress();
  const n = Object.keys(p.completed || {}).length;
  container.innerHTML = `
    <span>Nights completed: <strong>${n}</strong></span>
    <span>Flights: <strong>${p.flights || 0}</strong></span>
    <span>Discoveries (lifetime): <strong>${p.totalDiscoveries || 0}</strong></span>
  `;
}
