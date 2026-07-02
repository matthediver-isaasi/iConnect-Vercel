// Shared helpers for tenant-configurable support levels (the ticket "Severity"
// dropdown) and the custom Create Support Ticket instructions message.
// Both are persisted as SystemSettings key/value rows, following the same
// pattern as `event_types`.

export const SUPPORT_LEVELS_KEY = "support_levels";
export const SUPPORT_INSTRUCTIONS_KEY = "support_ticket_instructions";

// Built-in fallback levels — matches the original hardcoded Severity options so
// tenants that have not configured anything behave exactly as before.
export const DEFAULT_SUPPORT_LEVELS = [
  { value: "minor", label: "Minor" },
  { value: "moderate", label: "Moderate", isDefault: true },
  { value: "major", label: "Major" },
  { value: "critical", label: "Critical" },
];

// Badge styling for the original four values. Custom values fall back to a
// neutral style so they still render legibly.
const BUILT_IN_SEVERITY_COLORS = {
  minor: "bg-green-100 text-green-700",
  moderate: "bg-warning/10 text-warning",
  major: "bg-warning/10 text-warning",
  critical: "bg-red-100 text-red-700",
};

const NEUTRAL_SEVERITY_COLOR = "bg-slate-100 text-slate-700";

/**
 * Parse a raw `support_levels` setting value (JSON string) into a clean array of
 * { value, label, isDefault } objects. Returns null when the value is missing or
 * invalid so callers can fall back to DEFAULT_SUPPORT_LEVELS.
 */
export function parseSupportLevels(settingValue) {
  if (!settingValue) return null;
  try {
    const parsed = JSON.parse(settingValue);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .filter((lvl) => lvl && typeof lvl.value === "string" && lvl.value.trim() !== "")
      .map((lvl) => ({
        value: lvl.value.trim(),
        label: typeof lvl.label === "string" && lvl.label.trim() !== "" ? lvl.label.trim() : lvl.value.trim(),
        isDefault: !!lvl.isDefault,
      }));
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective support levels from a list of SystemSettings records.
 * Always returns a non-empty array (falls back to the built-in four).
 */
export function resolveSupportLevels(settings) {
  const record = Array.isArray(settings)
    ? settings.find((s) => s.setting_key === SUPPORT_LEVELS_KEY)
    : null;
  return parseSupportLevels(record?.setting_value) || DEFAULT_SUPPORT_LEVELS;
}

/**
 * Resolve the custom ticket instructions message from SystemSettings records.
 * Returns an empty string when unset.
 */
export function resolveSupportInstructions(settings) {
  const record = Array.isArray(settings)
    ? settings.find((s) => s.setting_key === SUPPORT_INSTRUCTIONS_KEY)
    : null;
  const value = record?.setting_value;
  return typeof value === "string" ? value : "";
}

/** Get the default-selected level value for a given levels array. */
export function getDefaultSeverity(levels) {
  const list = levels && levels.length > 0 ? levels : DEFAULT_SUPPORT_LEVELS;
  const flagged = list.find((lvl) => lvl.isDefault);
  return (flagged || list[0]).value;
}

/** Human label for a severity value, given the configured levels. */
export function getSeverityLabel(levels, value) {
  if (!value) return "";
  const list = levels && levels.length > 0 ? levels : DEFAULT_SUPPORT_LEVELS;
  const match = list.find((lvl) => lvl.value === value);
  return match ? match.label : value;
}

/** Badge class for a severity value, with a neutral fallback for custom values. */
export function getSeverityBadgeClass(value) {
  return BUILT_IN_SEVERITY_COLORS[value] || NEUTRAL_SEVERITY_COLOR;
}
