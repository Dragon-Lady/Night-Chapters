/**
 * Soft flight mechanics — glide, rest, spoons fuel, discovery score.
 * Aviation metaphor only. No weapons. No failure cascade.
 */

export const ARRIVE_DEG = 0.35;
export const MYSTERY_NEAR_DEG = 1.35;
export const MYSTERY_NOTICE_DEG = 4.0;

/** Default wonder score — overridden per chapter via night.score */
export const SCORE = {
  STORY_PIN: 10,
  DRIFT_MYSTERY: 25,
  CHAPTER_MYSTERY: 40,
  FREE_PIN: 5,
};

/** Resolve per-chapter score table */
export function scoreTable(night) {
  const s = night?.score || {};
  return {
    STORY_PIN: s.story ?? SCORE.STORY_PIN,
    DRIFT_MYSTERY: s.drift ?? SCORE.DRIFT_MYSTERY,
    CHAPTER_MYSTERY: s.chapter ?? SCORE.CHAPTER_MYSTERY,
    FREE_PIN: s.free ?? SCORE.FREE_PIN,
    PERFECT_BONUS: s.perfect_bonus ?? 15,
  };
}

export function createFlightSession(night) {
  const drift = (night.drift_mysteries || night.mysteries || []).map((m, i) => ({
    id: m.id || `drift-${i}`,
    label: m.label || null,
    story_hook: m.story_hook || m.hook || "A soft glow off the path…",
    seed: m.seed || m.view,
    claimed: false,
    noticed: false,
    claimed_label: null,
  }));

  const table = scoreTable(night);

  return {
    nightId: night.id,
    title: night.title,
    pinIndex: 0,
    fixesVisited: [],
    throttle: 0.25,
    resting: false,
    /** Spoon fuel 0–1 — depletes while gliding, recovers at rest */
    spoons: 1,
    lastFuelTick: null,
    mysteryClaimed: false,
    mysteryNear: false,
    activeDriftId: null,
    driftMysteries: drift,
    scoreTable: table,
    discovered: {
      storyPins: [],
      driftMysteries: [],
      chapterMystery: false,
      freePins: 0,
    },
    score: 0,
    perfectBonusApplied: false,
    navLog: [],
    startedAt: null,
    endedAt: null,
  };
}

export function currentWaypoint(night, session) {
  if (!night) return null;
  if (session.pinIndex < night.pins.length) {
    return {
      kind: "pin",
      pin: night.pins[session.pinIndex],
      view: night.pins[session.pinIndex].view,
    };
  }
  if (night.mystery && !session.mysteryClaimed) {
    return {
      kind: "mystery",
      mystery: night.mystery,
      view: {
        ra: night.mystery.seed.ra,
        dec: night.mystery.seed.dec,
        fov: night.mystery.seed.fov ?? 1.2,
      },
    };
  }
  return null;
}

export function markArrived(session, waypoint) {
  if (!waypoint) return session;
  const T = session.scoreTable || SCORE;
  if (waypoint.kind === "pin") {
    const id = waypoint.pin.id;
    if (!session.fixesVisited.includes(id)) {
      session.fixesVisited.push(id);
      if (!session.discovered.storyPins.includes(id)) {
        session.discovered.storyPins.push(id);
        session.score += T.STORY_PIN;
        session.navLog.push(
          `Arrived: ${waypoint.pin.label} (+${T.STORY_PIN})`
        );
      } else {
        session.navLog.push(`Arrived: ${waypoint.pin.label}`);
      }
    }
    session.pinIndex += 1;
  }
  return session;
}

export function setThrottle(session, value) {
  let t = Math.max(0, Math.min(1, Number(value) || 0));
  // Empty spoons: can only rest / crawl
  if (session.spoons <= 0.02) t = Math.min(t, 0.05);
  session.throttle = t;
  session.resting = session.throttle < 0.04;
  return session;
}

/**
 * Tick spoon fuel. dtSec from rAF.
 * Glide drains; rest recovers. Never punishes with game-over.
 */
export function tickSpoons(session, dtSec = 1 / 60) {
  if (!session || session.endedAt) return session.spoons;
  const dt = Math.min(0.1, Math.max(0, dtSec));
  if (session.resting || session.throttle < 0.04) {
    // rest recovery ~ full in ~45s of continuous rest
    session.spoons = Math.min(1, session.spoons + dt * (1 / 45));
  } else {
    // drain scales with throttle — full throttle ~ empties in ~90s of pure glide
    const drain = dt * (session.throttle * (1 / 90) + 0.002);
    session.spoons = Math.max(0, session.spoons - drain);
    if (session.spoons <= 0.02) {
      session.spoons = 0;
      session.throttle = 0;
      session.resting = true;
    }
  }
  return session.spoons;
}

/** @deprecated use session.spoons + tickSpoons */
export function fuelOfNight(session) {
  if (!session) return 1;
  return typeof session.spoons === "number" ? session.spoons : 1;
}

/**
 * Distance on sky in degrees (approx).
 */
export function skyDistanceDeg(a, b) {
  if (!a || !b) return Infinity;
  const dRa = wrapDeltaRa(b.ra - a.ra);
  const dDec = b.dec - a.dec;
  const cos = Math.cos((a.dec * Math.PI) / 180);
  return Math.hypot(dRa * cos, dDec);
}

function wrapDeltaRa(d) {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/**
 * Find nearest unclaimed drift mystery within notice radius.
 */
export function nearestDriftMystery(session, view) {
  let best = null;
  let bestD = Infinity;
  for (const m of session.driftMysteries || []) {
    if (m.claimed || !m.seed) continue;
    const d = skyDistanceDeg(view, m.seed);
    if (d < bestD) {
      bestD = d;
      best = { mystery: m, distDeg: d };
    }
  }
  return best;
}

export function claimDriftMystery(session, mystery, label) {
  if (!mystery || mystery.claimed) return null;
  const T = session.scoreTable || SCORE;
  mystery.claimed = true;
  mystery.claimed_label = label;
  if (!session.discovered.driftMysteries.includes(mystery.id)) {
    session.discovered.driftMysteries.push(mystery.id);
    session.score += T.DRIFT_MYSTERY;
  }
  session.navLog.push(`Drift mystery: ${label} (+${T.DRIFT_MYSTERY})`);
  session.activeDriftId = null;
  return mystery;
}

export function claimChapterMystery(session, label) {
  if (session.mysteryClaimed) return session;
  const T = session.scoreTable || SCORE;
  session.mysteryClaimed = true;
  if (!session.discovered.chapterMystery) {
    session.discovered.chapterMystery = true;
    session.score += T.CHAPTER_MYSTERY;
  }
  session.navLog.push(`Chapter mystery: ${label} (+${T.CHAPTER_MYSTERY})`);
  return session;
}

export function recordFreePin(session) {
  const T = session.scoreTable || SCORE;
  session.discovered.freePins = (session.discovered.freePins || 0) + 1;
  session.score += T.FREE_PIN;
  session.navLog.push(`House pin (+${T.FREE_PIN})`);
}

/** Perfect chapter: all story pins + all drift + chapter mystery */
export function maybeApplyPerfectBonus(session, night) {
  if (!session || session.perfectBonusApplied) return 0;
  const T = session.scoreTable || scoreTable(night);
  const storyOk =
    (session.discovered.storyPins?.length || 0) >= (night?.pins?.length || 0);
  const driftOk =
    (session.discovered.driftMysteries?.length || 0) >=
    (session.driftMysteries?.length || 0);
  const mystOk =
    !night?.mystery || session.discovered.chapterMystery === true;
  if (storyOk && driftOk && mystOk && (night?.pins?.length || 0) > 0) {
    session.perfectBonusApplied = true;
    session.score += T.PERFECT_BONUS || 0;
    session.navLog.push(`Perfect chapter bonus (+${T.PERFECT_BONUS})`);
    return T.PERFECT_BONUS || 0;
  }
  return 0;
}

export function discoveryCount(session) {
  if (!session) return 0;
  return (
    (session.discovered.storyPins?.length || 0) +
    (session.discovered.driftMysteries?.length || 0) +
    (session.discovered.chapterMystery ? 1 : 0) +
    (session.discovered.freePins || 0)
  );
}

export function closeoutLines(session, night) {
  const disc = discoveryCount(session);
  const lines = [
    `Night: ${night?.title || session.nightId}`,
    `Discovered: ${disc} · wonder score ${session.score}${
      session.perfectBonusApplied ? " · perfect" : ""
    }`,
    session.navLog.filter((l) => !l.startsWith("---")).slice(-1)[0] ||
      "Flew soft. Saw something.",
  ];
  return lines;
}

/** Catalog sources for windshield overlays */
export function catalogSourcesForNight(night, session) {
  const sources = [];
  for (const p of night?.pins || []) {
    sources.push({
      ra: p.view.ra,
      dec: p.view.dec,
      name: p.label,
      kind: "story",
      done: session?.fixesVisited?.includes(p.id),
    });
  }
  for (const m of session?.driftMysteries || []) {
    if (!m.seed) continue;
    sources.push({
      ra: m.seed.ra,
      dec: m.seed.dec,
      name: m.claimed ? m.claimed_label || "✦" : "✦ ?",
      kind: m.claimed ? "claimed" : "drift",
      done: m.claimed,
    });
  }
  if (night?.mystery?.seed) {
    sources.push({
      ra: night.mystery.seed.ra,
      dec: night.mystery.seed.dec,
      name: session?.mysteryClaimed
        ? night.mystery.claimed_label || "✦"
        : "✦ chapter",
      kind: session?.mysteryClaimed ? "claimed" : "chapter",
      done: !!session?.mysteryClaimed,
    });
  }
  return sources;
}
