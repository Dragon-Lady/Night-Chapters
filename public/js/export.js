/**
 * Share / export — personal pins & reflections as JSON (download or clipboard).
 * Local data only. Wonder-first; no cloud.
 */

import { loadPersonalPins } from "./pins.js";
import { loadReflections, loadProgress } from "./progress.js";
import { loadBestScore, loadChapterBests } from "./pins.js";

export function buildExportPayload({ includePins = true, includeReflections = true, includeProgress = true } = {}) {
  const payload = {
    app: "Night Chapters",
    tagline: "I want to see. I play.",
    exported_at: new Date().toISOString(),
    version: 1,
  };
  if (includePins) payload.pins = loadPersonalPins();
  if (includeReflections) payload.reflections = loadReflections();
  if (includeProgress) {
    payload.progress = loadProgress();
    payload.bestWonder = loadBestScore();
    payload.chapterBests = loadChapterBests();
  }
  return payload;
}

export function toJson(payload) {
  return JSON.stringify(payload, null, 2);
}

export function downloadJson(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // fallback
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    return true;
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export function exportPinsFile() {
  const text = toJson({
    app: "Night Chapters",
    kind: "house-pins",
    exported_at: new Date().toISOString(),
    pins: loadPersonalPins(),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(`night-chapters-pins-${stamp}.json`, text);
  return text;
}

export function exportReflectionsFile() {
  const text = toJson({
    app: "Night Chapters",
    kind: "reflections",
    exported_at: new Date().toISOString(),
    reflections: loadReflections(),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(`night-chapters-reflections-${stamp}.json`, text);
  return text;
}

export function exportFullHouseFile() {
  const text = toJson(buildExportPayload());
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(`night-chapters-house-${stamp}.json`, text);
  return text;
}

/** Soft share text (no huge JSON) for clipboard / navigator.share */
export function buildShareText() {
  const pins = loadPersonalPins();
  const progress = loadProgress();
  const best = loadBestScore();
  const lines = [
    "Night Chapters — I want to see. I play.",
    `Best wonder: ${best}`,
    `Flights: ${progress.flights || 0} · Nights completed: ${Object.keys(progress.completed || {}).length}`,
    `House pins: ${pins.length}`,
  ];
  if (pins.length) {
    lines.push("Recent pins:");
    pins.slice(0, 5).forEach((p) => {
      lines.push(`· ${p.label}${p.chapterTitle ? ` (${p.chapterTitle})` : ""}`);
    });
  }
  lines.push("");
  lines.push("(Local house data — export JSON from the app for full backup.)");
  return lines.join("\n");
}

export async function shareSoftSummary() {
  const text = buildShareText();
  if (navigator.share) {
    try {
      await navigator.share({
        title: "Night Chapters",
        text,
      });
      return "shared";
    } catch {
      /* fall through */
    }
  }
  const ok = await copyToClipboard(text);
  return ok ? "copied" : "failed";
}
