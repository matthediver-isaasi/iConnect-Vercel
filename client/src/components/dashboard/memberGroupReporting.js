export const MEMBER_GROUP_MEASURES = [
  { field: "groups", label: "Distinct groups" },
  { field: "current_members", label: "Current distinct members" },
  { field: "current_organizations", label: "Current distinct organisations" },
  { field: "joins", label: "Membership joins" },
  { field: "period_end_members", label: "Period-end members" },
];

export function isGroupTemporal(measure) {
  return ["joins", "period_end_members"].includes(measure);
}

// Keep picker compatibility and measure changes deterministic; never silently
// retain member-only filters when switching to a group or historical metric.
export function groupFieldCompatible(field, measure, usage) {
  if (MEMBER_GROUP_MEASURES.some(m => m.field === field.field)) return usage === "measure";
  if (field.field === "membership_at") return usage === "date" && isGroupTemporal(measure);
  if (usage === "measure" || usage === "date") return false;
  if (Array.isArray(field.supportedMeasures)) return field.supportedMeasures.includes(measure);
  if (["group_id", "name", "group_name", "is_active", "active"].includes(field.field)) return true;
  if (field.fieldKind === "custom") return measure !== "groups";
  return measure !== "groups" && ["group_role", "role_id", "organization_id", "login_enabled"].includes(field.field);
}

export function changeGroupMeasure(config, field) {
  const temporal = isGroupTemporal(field);
  return {
    ...config,
    measure: { aggregator: "count", fieldKind: "system", field, fieldId: null },
    groupBy: null,
    seriesBy: null,
    filters: [],
    timeBucket: temporal
      ? { field: "membership_at", fieldKind: "system", granularity: "month", ...(config.timeBucket?.field === "membership_at" ? config.timeBucket : {}) }
      : null,
    cumulative: false,
    clickThrough: false,
  };
}

export function groupHistoryNotice(payload) {
  const rows = payload?.rows || [];
  const unavailable = rows.filter(row => row.unavailable || row.available === false || row.value === null || payload.categories?.some(c => row[c] === null));
  const provisional = rows.filter(row => row.provisional || row.current);
  return [
    unavailable.length ? `Unavailable history: ${unavailable.map(row => row.key).join(", ")}. Missing history is not zero.` : "",
    provisional.length ? `Current / provisional: ${provisional.map(row => row.key).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}