import {
  relationshipEndpoint,
  relationshipEndpointsMatch,
  resolveRelationshipPickerPath,
  relationshipFields,
} from "./relationshipHelpers.js";

export const REPORT_CONFIG_VERSION = 1;

export const endpointKey = (endpoint = {}) =>
  `${endpoint.kind || ""}:${endpoint.customObjectId || endpoint.custom_object_id || ""}`;

export const endpointLabel = (endpoint = {}, objects = [], startObject) => {
  if (endpoint.kind === "custom_object") {
    const id = endpoint.customObjectId || endpoint.custom_object_id;
    const object = String(id) === String(startObject?.id)
      ? startObject
      : objects.find((item) => String(item.id) === String(id));
    return object?.plural_label || object?.singular_label || "Custom object";
  }
  return {
    member: "Member",
    organization: "Organisation",
    organization_group: "Organisation group",
  }[endpoint.kind] || "Unknown entity";
};

export const reportPathLabel = (path = [], definitions = [], objects = [], startObject) => {
  let endpoint = { kind: "custom_object", customObjectId: startObject?.id };
  const labels = [endpointLabel(endpoint, objects, startObject)];
  for (const hop of path) {
    const definition = definitions.find((item) =>
      String(item.id) === String(hop.relationship_definition_id));
    if (!definition || !["source", "target"].includes(hop.from_side)
      || !relationshipEndpointsMatch(endpoint, relationshipEndpoint(definition, hop.from_side))) {
      return "Unavailable path";
    }
    endpoint = relationshipEndpoint(definition, hop.from_side === "source" ? "target" : "source");
    const relationshipLabel = hop.from_side === "source"
      ? definition.source_label
      : definition.target_label;
    labels.push(
      `${relationshipLabel || definition.relationship_key || "Relationship"}`
      + `${definition.relationship_key ? ` [${definition.relationship_key}]` : ""}`
      + ` → ${endpointLabel(endpoint, objects, startObject)}`,
    );
  }
  return labels.join(" → ");
};

export const makeReportConfig = (objectId, overrides = {}) => ({
  version: REPORT_CONFIG_VERSION,
  start_object_id: String(objectId),
  grain_path: [],
  columns: [],
  multi_value: "join",
  ...overrides,
});

// Reconciliation deliberately only identifies invalid selections. It never
// substitutes a similarly named field or relationship, which could change a
// shared report's meaning after a schema edit.
export const reconcileReportConfig = ({
  config,
  objectId,
  definitions = [],
  fieldsByEndpoint = {},
}) => {
  const normalized = makeReportConfig(objectId, config || {});
  const start = { kind: "custom_object", customObjectId: objectId };
  const pathCheck = resolveRelationshipPickerPath({
    definitions,
    start,
    path: normalized.grain_path || [],
    maxHops: 6,
  });
  const stale = [];
  if (normalized.version !== REPORT_CONFIG_VERSION) {
    stale.push(`Report version ${normalized.version ?? "unknown"} is not supported and must be repaired.`);
  }
  if (String(normalized.start_object_id) !== String(objectId)) stale.push("This report belongs to another object.");
  if (pathCheck.error) stale.push(pathCheck.error);
  for (const column of normalized.columns || []) {
    const path = column.path || [];
    const result = resolveRelationshipPickerPath({ definitions, start, path, maxHops: 6 });
    if (result.error) {
      stale.push(`Column "${column.label || column.field_id || "unknown"}" has an unavailable path.`);
      continue;
    }
    if (column.kind === "relationship_field") {
      const definition = definitions.find((item) =>
        String(item.id) === String(column.relationship_definition_id));
      if (!definition || !relationshipFields(definition).some((field) =>
        String(field.id) === String(column.relationship_field_id) || field.key === column.field_key)) {
        stale.push(`Relationship column "${column.label || column.relationship_field_id || "unknown"}" is unavailable.`);
      }
      continue;
    }
    const available = fieldsByEndpoint[endpointKey(result.endpoint)];
    // An endpoint whose metadata has not loaded is not declared stale.
    const fieldReference = column.field_id || column.field;
    if (available && !available.some((field) => String(field.id) === String(fieldReference))) {
      stale.push(`Field column "${column.label || fieldReference}" is unavailable.`);
    }
  }
  return { config: normalized, stale, rowEndpoint: pathCheck.endpoint, rowPathError: pathCheck.error };
};

export const moveReportColumn = (columns, index, amount) => {
  const next = [...(columns || [])];
  const target = index + amount;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [column] = next.splice(index, 1);
  next.splice(target, 0, column);
  return next;
};