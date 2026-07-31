/**
 * Personal pins as waypoints — house mythology on the glass.
 * Easy create; easy forget. Never a threat list.
 */

const STORAGE_KEY = "night-chapters.personalPins.v1";

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
export function claimPin({ label, note = "", view, emotion = "wonder", nightId }) {
  const pins = loadPersonalPins();
  const pin = {
    id: `pin-${Date.now().toString(36)}`,
    label: (label || "untitled glow").trim().slice(0, 80),
    note,
    emotion,
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
  // keep house list light
  savePersonalPins(pins.slice(0, 40));
  return pin;
}

export function deletePin(id) {
  const next = loadPersonalPins().filter((p) => p.id !== id);
  savePersonalPins(next);
  return next;
}
