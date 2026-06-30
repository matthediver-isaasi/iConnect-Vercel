// Shared helpers for tenant-configurable support areas — a second dimension on
// support tickets alongside Severity.  The config is stored as a SystemSettings
// JSON row (key: support_areas) whose value is a JSON array of
//   { value, label, memberIds: string[] }
// following the same pattern as support_levels / supportLevels.js.

export const SUPPORT_AREAS_KEY = "support_areas";

/**
 * Parse a raw `support_areas` setting value (JSON string) into a clean array.
 * Returns null when the value is missing or invalid.
 */
export function parseSupportAreas(settingValue) {
  if (!settingValue) return null;
  try {
    const parsed = JSON.parse(settingValue);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .filter((a) => a && typeof a.value === "string" && a.value.trim() !== "")
      .map((a) => ({
        value: a.value.trim(),
        label: typeof a.label === "string" && a.label.trim() !== "" ? a.label.trim() : a.value.trim(),
        memberIds: Array.isArray(a.memberIds) ? a.memberIds.filter(Boolean) : [],
      }));
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective support areas from a list of SystemSettings records.
 * Returns an empty array when no areas are configured.
 */
export function resolveSupportAreas(settings) {
  const record = Array.isArray(settings)
    ? settings.find((s) => s.setting_key === SUPPORT_AREAS_KEY)
    : null;
  return parseSupportAreas(record?.setting_value) || [];
}

/** Human label for an area value, given the configured areas. */
export function getAreaLabel(areas, value) {
  if (!value) return "";
  const match = (areas || []).find((a) => a.value === value);
  return match ? match.label : value;
}

/** Badge class for an area value (neutral, consistent). */
export const AREA_BADGE_CLASS = "bg-purple-100 text-purple-700";
