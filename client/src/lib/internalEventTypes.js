export const INTERNAL_EVENT_TYPES_SETTING_KEY = "internal_event_types";

export function parseInternalEventTypes(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item && !seen.has(item.toLowerCase()) && seen.add(item.toLowerCase()));
  } catch {
    return [];
  }
}