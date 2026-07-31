/**
 * Soft flight mechanics — glide, rest, heading bug.
 * Aviation metaphor only. No weapons. No failure cascade.
 */

export const ARRIVE_DEG = 0.35;

export function createFlightSession(night) {
  return {
    nightId: night.id,
    title: night.title,
    pinIndex: 0,
    fixesVisited: [],
    throttle: 0.25,
    resting: false,
    mysteryClaimed: false,
    mysteryNear: false,
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
        fov: night.mystery.seed.fov,
      },
    };
  }
  return null;
}

export function markArrived(session, waypoint) {
  if (!waypoint) return session;
  if (waypoint.kind === "pin") {
    const id = waypoint.pin.id;
    if (!session.fixesVisited.includes(id)) {
      session.fixesVisited.push(id);
      session.navLog.push(`Arrived: ${waypoint.pin.label}`);
    }
    session.pinIndex += 1;
  }
  return session;
}

export function setThrottle(session, value) {
  session.throttle = Math.max(0, Math.min(1, Number(value) || 0));
  session.resting = session.throttle < 0.04;
  return session;
}

/** Playful “fuel of the night” — spoons metaphor, not combat fuel */
export function fuelOfNight(session, now = Date.now()) {
  if (!session.startedAt) return 1;
  const elapsedMin = (now - session.startedAt) / 60000;
  // slow drain; rest regenerates a little in UI only
  let fuel = 1 - elapsedMin * 0.04;
  if (session.resting) fuel += 0.02;
  return Math.max(0.15, Math.min(1, fuel));
}

export function closeoutLines(session, night) {
  const lines = [
    `Night: ${night?.title || session.nightId}`,
    `Fixes: ${session.fixesVisited.length}${session.mysteryClaimed ? " · mystery claimed" : ""}`,
    session.navLog.slice(-1)[0] || "Flew soft. Saw something.",
  ];
  return lines;
}
