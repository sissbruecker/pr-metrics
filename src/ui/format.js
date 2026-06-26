/**
 * Human-readable duration formatting.
 *
 * Durations are stored as a number of seconds. This module turns those seconds
 * into a short, legible label using the units d/h/m/s (days, hours, minutes,
 * seconds, where 1d = 24h, 1h = 60m, 1m = 60s).
 *
 * Format rule:
 * - Show the TWO most-significant non-zero units, joined by a space, e.g.
 *   "2d 4h", "6h 30m", "45m 10s", "30s".
 * - If only one unit is non-zero, show just that one (e.g. "30s", "5h").
 * - If, after the most-significant non-zero unit, the next unit is zero, the
 *   label collapses to a single unit (e.g. exactly 2 days -> "2d", not
 *   "2d 0h"). Only non-zero units are emitted, capped at two.
 * - 0 / falsy seconds -> "0s".
 * - null -> "—" (an em dash), used as the "blank"/no-data marker.
 *
 * Values are truncated (floored) to whole units; no rounding up.
 */

/** Em dash used to render "no value" cells/labels. */
export const BLANK = "—";

/**
 * Format a duration in seconds as a short human-readable string.
 * @param {number | null} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return BLANK;
  // Treat 0 / falsy / negative as "0s".
  if (!seconds || seconds <= 0) return "0s";

  const total = Math.floor(seconds);
  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];

  // Break the total into each unit's whole-number value.
  const parts = [];
  let remaining = total;
  for (const [label, size] of units) {
    const value = Math.floor(remaining / size);
    remaining -= value * size;
    parts.push({ label, value });
  }

  // Keep the two most-significant non-zero units.
  const nonZero = parts.filter((p) => p.value > 0).slice(0, 2);
  if (nonZero.length === 0) return "0s";
  return nonZero.map((p) => `${p.value}${p.label}`).join(" ");
}
