/**
 * Soft flight mechanics — glide, rest, spoons fuel, discovery score.
 * Aviation metaphor only. No weapons. No failure cascade.
 */

export const ARRIVE_DEG = 0.35;
/** Base near radius (tight FoV); scale up with cruise FoV via mysteryRadiiForFov */
export const MYSTERY_NEAR_DEG = 1.35;
export const MYSTERY_NOTICE_DEG = 4.0;

/**
 * At wide cruise FoV (14–22°) the visual glow is several degrees across.
 * Fixed 1.35° near-radius often missed a “center of the pulse” pass.
 * Scale radii with FoV so marker-center passage always counts.
 */
export function mysteryRadiiForFov(fovDeg = 16) {
  const fov = Math.max(4, Math.min(40, Number(fovDeg) || 16));
  return {
    noticeDeg: Math.max(MYSTERY_NOTICE_DEG, fov * 0.4),
    nearDeg: Math.max(MYSTERY_NEAR_DEG, fov * 0.14),
  };
}

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
  const table = scoreTable(night);
  const discoveredDrift = [];

  const drift = (night.drift_mysteries || night.mysteries || []).map((m, i) => {
    const houseNamed = !!(m.house_named || m.claimed);
    const houseName =
      (m.claimed_label || (houseNamed ? m.label : "") || "").trim() || null;
    const id = m.id || `drift-${i}`;
    // Pre-named house glows count as discovered (no re-claim grind)
    if (houseNamed && houseName) {
      discoveredDrift.push(id);
    }
    return {
      id,
      label: m.label || houseName || null,
      story_hook: m.story_hook || m.hook || "A soft glow off the path…",
      seed: m.seed || m.view,
      claimed: houseNamed && !!houseName,
      // Keep noticed false so first approach still fires whisper/glass
      noticed: false,
      claimed_label: houseName,
      house_named: houseNamed,
      named_at: m.named_at || null,
    };
  });

  // Chapter mystery may be house-named in night JSON (e.g. Rain glow → porch light)
  const myst = night.mystery || null;
  const chapterHouseNamed = !!(
    myst &&
    (myst.house_named || myst.claimed) &&
    (myst.claimed_label || myst.label)
  );
  const chapterLabel = myst
    ? (myst.claimed_label || myst.label || "").trim() || null
    : null;
  if (myst && chapterLabel) {
    myst.claimed_label = chapterLabel;
    if (myst.label == null) myst.label = chapterLabel;
  }

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
    mysteryClaimed: chapterHouseNamed && !!chapterLabel,
    mysteryNear: false,
    activeDriftId: null,
    driftMysteries: drift,
    scoreTable: table,
    discovered: {
      storyPins: [],
      driftMysteries: discoveredDrift.slice(),
      chapterMystery: chapterHouseNamed && !!chapterLabel,
      freePins: 0,
    },
    score: 0,
    perfectBonusApplied: false,
    navLog: [],
    startedAt: null,
    endedAt: null,
  };
}

/**
 * First story pin not yet in fixesVisited (visited / skipped / departed).
 * Source of truth for ribbon radar — NOT raw pinIndex (which can skip ahead
 * and leave an unlit pin while free-cruise re-locks found drifts).
 */
export function firstUnvisitedStoryPin(night, session) {
  if (!night?.pins?.length || !session) return null;
  const visited = session.fixesVisited || [];
  for (const p of night.pins) {
    if (p?.id && !visited.includes(p.id)) return p;
  }
  return null;
}

/** All remaining story pins (for HUD / hunt list). */
export function unvisitedStoryPins(night, session) {
  if (!night?.pins?.length || !session) return [];
  const visited = session.fixesVisited || [];
  return night.pins.filter((p) => p?.id && !visited.includes(p.id));
}

/** True when every story pin is in fixesVisited. */
export function isStoryRibbonComplete(night, session) {
  if (!night?.pins?.length) return true;
  if (!session) return true;
  return firstUnvisitedStoryPin(night, session) == null;
}

/**
 * Keep pinIndex aligned with first unvisited pin (or pins.length when done).
 * Call after arrive / skip / begin so guided mode and UI stay in sync.
 */
export function syncPinIndexToUnvisited(night, session) {
  if (!session || !night?.pins) return session;
  const next = firstUnvisitedStoryPin(night, session);
  if (!next) {
    session.pinIndex = night.pins.length;
    return session;
  }
  const idx = night.pins.findIndex((p) => p.id === next.id);
  session.pinIndex = idx >= 0 ? idx : night.pins.length;
  return session;
}

export function currentWaypoint(night, session) {
  if (!night || !session) return null;
  // Prefer first unvisited story pin (fixes skip-ahead / free-cruise loop bug)
  const nextPin = firstUnvisitedStoryPin(night, session);
  if (nextPin?.view) {
    syncPinIndexToUnvisited(night, session);
    return {
      kind: "pin",
      pin: nextPin,
      view: nextPin.view,
    };
  }
  if (night.mystery && !session.mysteryClaimed) {
    session.pinIndex = night.pins?.length || 0;
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
  session.pinIndex = night.pins?.length || 0;
  return null;
}

export function markArrived(session, waypoint, night = null) {
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
    // Advance to next UNVISITED pin (not blind +1 — that skipped Lantern)
    if (night) syncPinIndexToUnvisited(night, session);
    else session.pinIndex += 1;
  }
  return session;
}

export function setThrottle(session, value) {
  let t = Math.max(0, Math.min(1, Number(value) || 0));
  // Empty spoons: can only rest / crawl
  if (session.spoons <= 0.02) t = Math.min(t, 0.05);
  session.throttle = t;
  // Low throttle alone is "parked," not REST mode.
  // Only enterRest() sets resting=true; any real throttle clears it.
  if (t >= 0.04) session.resting = false;
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
  // Floor cos near poles so distance stays finite/stable (sensor + proximity)
  const cosRaw = Math.cos((a.dec * Math.PI) / 180);
  const cos =
    Math.sign(cosRaw || 1) *
    Math.max(Math.abs(cosRaw) || 0.08, 0.08);
  return Math.hypot(dRa * cos, dDec);
}

function wrapDeltaRa(d) {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

// —— Nav sensor contact selection (v1.7.38) ——
// Distance-first, deterministic ties, sticky hysteresis for clusters.

/** Kind rank when distances are nearly equal (lower = more relevant). */
export const SENSOR_KIND_RANK = {
  pin: 0,
  story: 1,
  chapter: 2,
  drift: 3,
  house: 4,
  beacon: 5,
  nav: 6,
};

/** Merge contacts within this sky ° as the same marker (dedupe). */
export const SENSOR_DEDUPE_DEG = 1.25;
/**
 * Within this ° of each other, treat as a cluster: pure distance wins,
 * kind only breaks near-ties under CLUSTER_TIE_DEG.
 */
export const SENSOR_CLUSTER_DEG = 12;
/** Clear distance winner threshold (°). Above this, closer always wins. */
export const SENSOR_CLEAR_DIST_DEG = 1.15;
/** Sticky lock: don't switch unless new is this many ° closer. */
export const SENSOR_HYSTERESIS_DEG = 1.6;
/** Drop sticky lock if previous contact is now farther than this. */
export const SENSOR_STICKY_MAX_DEG = 40;

/**
 * Stable sky key for near-duplicate merge (≈0.5° bins).
 */
export function sensorSkyKey(ra, dec) {
  const r = ((Number(ra) % 360) + 360) % 360;
  const d = Number(dec);
  return `${(Math.round(r * 2) / 2).toFixed(1)}_${(Math.round(d * 2) / 2).toFixed(1)}`;
}

/**
 * Merge near-duplicate contacts (same pin listed as landmark + house + story).
 * Keeps the more relevant kind; preserves min distDeg.
 */
export function dedupeSensorPool(pool, mergeDeg = SENSOR_DEDUPE_DEG) {
  if (!pool?.length) return [];
  const out = [];
  for (const c of pool) {
    if (!c || !Number.isFinite(c.distDeg)) continue;
    let merged = false;
    for (const prev of out) {
      const d = skyDistanceDeg(prev, c);
      if (d <= mergeDeg) {
        // Same marker: keep better kind / unclaimed, freshest min distance
        const krC = SENSOR_KIND_RANK[c.kind] ?? 9;
        const krP = SENSOR_KIND_RANK[prev.kind] ?? 9;
        if (krC < krP) {
          prev.kind = c.kind;
          prev.label = c.label || prev.label;
          prev.ribbon = prev.ribbon || c.ribbon;
        } else if (krC === krP && c.label && prev.label && c.label !== prev.label) {
          // Same rank dual-name (e.g. catalog "Whirlpool" vs house "Personal star"):
          // prefer pin / ribbon / preferred house label over pure catalog.
          if (c.ribbon && !prev.ribbon) prev.label = c.label;
          else if (c.preferred && !prev.preferred) prev.label = c.label;
          else if (!c.catalogOnly && prev.catalogOnly) prev.label = c.label;
        }
        if (c.unclaimed && !prev.unclaimed) {
          prev.unclaimed = true;
          prev.claimed = false;
          if (c.label) prev.label = c.label;
        }
        if (c.ribbon) prev.ribbon = true;
        if (c.preferred) prev.preferred = true;
        if (c.catalogOnly === false) prev.catalogOnly = false;
        // Prefer closer sample's distance + coords
        if (c.distDeg < prev.distDeg) {
          prev.distDeg = c.distDeg;
          prev.ra = c.ra;
          prev.dec = c.dec;
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      out.push({
        ra: c.ra,
        dec: c.dec,
        label: c.label,
        kind: c.kind,
        distDeg: c.distDeg,
        ribbon: !!c.ribbon,
        claimed: !!c.claimed,
        unclaimed: !!c.unclaimed,
        preferred: !!c.preferred,
        catalogOnly: !!c.catalogOnly,
      });
    }
  }
  return out;
}

/**
 * Compare two contacts: closer to ship wins.
 * Near-ties use kind → unclaimed → ribbon → label (stable, never random).
 * @returns negative if a is better than b
 */
export function compareSensorContacts(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const dDiff = a.distDeg - b.distDeg;

  // Clear distance winner — always
  if (Math.abs(dDiff) >= SENSOR_CLEAR_DIST_DEG) return dDiff;

  // Cluster near-tie: unclaimed hunt targets slightly preferred
  if (!!a.unclaimed !== !!b.unclaimed) return a.unclaimed ? -1 : 1;

  const ka = SENSOR_KIND_RANK[a.kind] ?? 9;
  const kb = SENSOR_KIND_RANK[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;

  // Ribbon waypoint edges out scenery at equal distance
  if (!!a.ribbon !== !!b.ribbon) return a.ribbon ? -1 : 1;

  // Tiny residual distance (still deterministic)
  if (dDiff !== 0) return dDiff;

  return String(a.label || "").localeCompare(String(b.label || ""));
}

/**
 * Pick the single best local contact from a (possibly noisy) pool.
 * Distance-first; deterministic among clusters.
 */
export function pickClosestSensorContact(pool) {
  const clean = dedupeSensorPool(pool);
  if (!clean.length) return null;
  let best = clean[0];
  for (let i = 1; i < clean.length; i++) {
    if (compareSensorContacts(clean[i], best) < 0) best = clean[i];
  }
  return best;
}

/**
 * Soft-steal: should local contact replace the ribbon waypoint?
 * Used so candy drifts / house / chapter glow light the radar on approach
 * even while ribbon-guided to the next story pin.
 * @param {object|null} ribbon
 * @param {object|null} local
 * @param {{ lastRibbonHunt?: boolean }} [opts]
 */
export function shouldSoftStealRibbon(ribbon, local, opts = {}) {
  if (!ribbon?.ribbon || !local) return false;
  if (local.ribbon) return false;
  // Same marker as ribbon (deduped coords)
  if (skyDistanceDeg(ribbon, local) <= SENSOR_DEDUPE_DEG) return false;

  // Always highlight when you're on top of a drift / house / chapter glow
  // (user hit gumdrop spark on path — radar must light even if ribbon is closer)
  const approachKind =
    local.kind === "drift" ||
    local.kind === "house" ||
    local.kind === "chapter" ||
    local.kind === "beacon";
  if (approachKind && local.distDeg <= 9) return true;
  if (approachKind && local.distDeg <= 14 && local.unclaimed) return true;

  const lastRibbonHunt = !!opts.lastRibbonHunt;
  const onTop =
    local.distDeg < (lastRibbonHunt ? 4.5 : 6) &&
    local.distDeg + (lastRibbonHunt ? 12 : 8) < ribbon.distDeg;

  if (lastRibbonHunt) {
    return onTop || local.distDeg < 3.5;
  }
  const closeContact = local.distDeg <= 14;
  const ribbonFar = ribbon.distDeg > 18;
  const muchCloser = local.distDeg < ribbon.distDeg * 0.35;
  return closeContact && ((ribbonFar && muchCloser) || onTop);
}

/**
 * Compass bearing from camera to a sky point (navigation convention).
 * 0° = north (+Dec), 90° = east (+RA), 180° = south, 270° = west.
 * Matches windshield HDG / N·E·S·W. Pole-safe cos floor.
 */
export function bearingToSky(cam, ra, dec) {
  if (!cam || ra == null || dec == null) return null;
  const cosRaw = Math.cos((Number(cam.dec) * Math.PI) / 180);
  const cos =
    Math.sign(cosRaw || 1) *
    Math.max(Math.abs(cosRaw) || 0.08, 0.08);
  const dRa = wrapDeltaRa(Number(ra) - Number(cam.ra)) * cos; // east
  const dDec = Number(dec) - Number(cam.dec); // north
  if (Math.hypot(dRa, dDec) < 1e-8) return null;
  // atan2(east, north): 0 = north, 90 = east
  return ((Math.atan2(dRa, dDec) * 180) / Math.PI + 360) % 360;
}

/**
 * True if flight heading points away from contact (behind / abeam aft).
 * Used to release sticky pole locks when the pilot turns to leave.
 */
export function isHeadingAwayFromContact(cam, contact, heading, awayDeg = 75) {
  if (!cam || !contact || heading == null) return false;
  const br = bearingToSky(cam, contact.ra, contact.dec);
  if (br == null) return false;
  let err = br - Number(heading);
  while (err > 180) err -= 360;
  while (err < -180) err += 360;
  return Math.abs(err) >= awayDeg;
}

/** High-Dec / pole-class contact (sensor should release easily on exit). */
export function isPolarContact(c) {
  if (!c) return false;
  if (Math.abs(Number(c.dec)) >= 78) return true;
  const lab = String(c.label || "");
  return /pole|still point|polaris/i.test(lab);
}

/**
 * Sticky hysteresis so the pointer doesn't thrash between cluster mates.
 * Keep prev unless next is clearly better — BUT release immediately when the
 * pilot has turned away (Pole hold must not drag/follow after exit turn).
 * @param {object|null} prev locked contact (with live distDeg if refreshed)
 * @param {object|null} next newly selected contact
 * @param {object[]} pool deduped pool with live distances
 * @param {object} [opts] cam, heading for departure release
 */
export function applySensorHysteresis(
  prev,
  next,
  pool = [],
  hysteresisDeg = SENSOR_HYSTERESIS_DEG,
  opts = {}
) {
  if (!next) return null;
  if (!prev) return next;

  // Refresh prev distance from pool if present
  let prevLive = null;
  for (const c of pool) {
    if (skyDistanceDeg(prev, c) <= SENSOR_DEDUPE_DEG) {
      prevLive = c;
      break;
    }
  }
  if (!prevLive) {
    // Previous contact left the pool / sky — take next
    return next;
  }
  if (prevLive.distDeg > SENSOR_STICKY_MAX_DEG) {
    return next;
  }

  // —— Departure release (v1.7.45) ——
  // Softer thresholds so Pole hold never re-sticks / "slingshots" after a turn.
  const cam = opts.cam;
  const heading = opts.heading;
  // Any clear turn away (≥45°) drops sticky immediately
  if (cam && heading != null && isHeadingAwayFromContact(cam, prevLive, heading, 45)) {
    return next;
  }
  // Polar contacts: release at only 30° off bearing, or if next is different at all
  if (cam && isPolarContact(prevLive)) {
    if (
      heading != null &&
      isHeadingAwayFromContact(cam, prevLive, heading, 30)
    ) {
      return next;
    }
    if (
      next &&
      skyDistanceDeg(prevLive, next) > SENSOR_DEDUPE_DEG &&
      (next.distDeg <= prevLive.distDeg + 2 || next.ribbon)
    ) {
      return next;
    }
  }

  // Same marker (dedupe) — update live fields
  if (skyDistanceDeg(prevLive, next) <= SENSOR_DEDUPE_DEG) {
    return next;
  }

  // Only switch if next is clearly closer
  if (next.distDeg + hysteresisDeg < prevLive.distDeg) {
    return next;
  }
  // Or next is much more relevant AND nearly as close (within clear threshold)
  if (
    compareSensorContacts(next, prevLive) < 0 &&
    next.distDeg <= prevLive.distDeg + 0.35
  ) {
    // Still require at least a small improvement or equal+kind win only when very close
    if (next.distDeg <= prevLive.distDeg) return next;
  }

  // Hold sticky lock with refreshed distance/label
  return {
    ...prevLive,
    // keep identity stable for debug
    sticky: true,
  };
}

/**
 * Full selection: ribbon soft-steal + closest local + hysteresis.
 * Pure — easy to unit-test with Altair-style clusters.
 * @param {object} [opts.cam] live cam for departure release
 * @param {number} [opts.heading] flight heading
 */
export function selectSensorTarget({
  ribbon = null,
  pool = [],
  prev = null,
  lastRibbonHunt = false,
  cam = null,
  heading = null,
} = {}) {
  // De-weight / drop polar contacts when pilot turns away (v1.7.45 stronger).
  let workPool = pool;
  if (cam && heading != null && pool?.length) {
    workPool = pool
      .map((c) => {
        if (!c || c.ribbon) return c;
        if (!isPolarContact(c)) return c;
        if (isHeadingAwayFromContact(cam, c, heading, 30)) {
          // Heavy penalty + flag — effectively leaves the local race
          return { ...c, distDeg: c.distDeg + 40, departing: true };
        }
        return c;
      })
      .filter((c) => !(c.departing && c.distDeg > 50));
  }

  const local = pickClosestSensorContact(workPool);
  let chosen = null;

  if (ribbon && local && !local.departing) {
    chosen = shouldSoftStealRibbon(ribbon, local, { lastRibbonHunt })
      ? local
      : ribbon;
  } else if (ribbon && local?.departing) {
    chosen = ribbon;
  } else {
    chosen = ribbon || local;
  }

  // When free-flying (no ribbon) or soft-stole: ensure we still use true closest
  // among anything as near as chosen — but skip departing-penalized contacts.
  if (chosen && local && !chosen.ribbon && !local.departing) {
    const cluster = dedupeSensorPool(workPool).filter(
      (c) => !c.departing && c.distDeg <= local.distDeg + SENSOR_CLUSTER_DEG
    );
    const clusterBest = pickClosestSensorContact(cluster);
    if (clusterBest) chosen = clusterBest;
  }

  // If chosen is polar and pilot is leaving, force off it (ribbon or next free)
  if (
    chosen &&
    !chosen.ribbon &&
    cam &&
    heading != null &&
    (chosen.departing ||
      (isPolarContact(chosen) &&
        isHeadingAwayFromContact(cam, chosen, heading, 30)))
  ) {
    if (ribbon) chosen = ribbon;
    else {
      const free = pickClosestSensorContact(
        workPool.filter((c) => !c.departing && !isPolarContact(c))
      );
      chosen = free || null;
    }
  }

  const deduped = dedupeSensorPool(ribbon ? [...workPool, ribbon] : workPool);
  // Refresh chosen dist from deduped if possible (use un-penalized dist)
  if (chosen) {
    for (const c of deduped) {
      if (skyDistanceDeg(chosen, c) <= SENSOR_DEDUPE_DEG) {
        // Prefer original pool distance without departure penalty
        const raw = (pool || []).find(
          (p) => p && skyDistanceDeg(p, c) <= SENSOR_DEDUPE_DEG
        );
        chosen = {
          ...chosen,
          distDeg: raw?.distDeg ?? c.distDeg,
          label: c.label || chosen.label,
        };
        break;
      }
    }
  }

  return applySensorHysteresis(prev, chosen, deduped, SENSOR_HYSTERESIS_DEG, {
    cam,
    heading,
  });
}

/**
 * Nearest drift mystery (any distance — caller applies notice/near).
 * Seeds must be finite RA/Dec; skips broken entries.
 * @param {{ includeClaimed?: boolean }} [opts]
 *   includeClaimed: also match house-named / already claimed glows
 *   (so center passage still whispers the name)
 */
export function nearestDriftMystery(session, view, opts = {}) {
  if (!session || !view) return null;
  const includeClaimed = !!opts.includeClaimed;
  let best = null;
  let bestD = Infinity;
  for (const m of session.driftMysteries || []) {
    if (!m.seed) continue;
    if (m.claimed && !includeClaimed) continue;
    const ra = Number(m.seed.ra);
    const dec = Number(m.seed.dec);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    const d = skyDistanceDeg(view, { ra, dec });
    if (!Number.isFinite(d)) continue;
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
    const named = m.claimed_label || m.label;
    sources.push({
      ra: m.seed.ra,
      dec: m.seed.dec,
      name: m.claimed
        ? named || "✦"
        : named
          ? `✧ ${named}`
          : "✦ ?",
      kind: m.claimed ? "claimed" : "drift",
      done: m.claimed,
    });
  }
  if (night?.mystery?.seed) {
    const chName =
      night.mystery.claimed_label || night.mystery.label || null;
    sources.push({
      ra: night.mystery.seed.ra,
      dec: night.mystery.seed.dec,
      name: session?.mysteryClaimed
        ? chName || "✦"
        : chName
          ? `✦ ${chName}`
          : "✦ chapter",
      kind: session?.mysteryClaimed ? "claimed" : "chapter",
      done: !!session?.mysteryClaimed,
    });
  }
  return sources;
}
