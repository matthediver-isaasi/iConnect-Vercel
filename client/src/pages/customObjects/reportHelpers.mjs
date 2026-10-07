import {
  relationshipEndpoint,
  relationshipEndpointsMatch,
  resolveRelationshipPickerPath,
  relationshipFields,
} from "./relationshipHelpers.js";
import { validateReportFilters } from "./reportFilterHelpers.mjs";

export const REPORT_CONFIG_VERSION = 2;
export const SUPPORTED_REPORT_CONFIG_VERSIONS = [1, 2];

export const endpointKey = (endpoint = {}) =>
  `${endpoint.kind || ""}:${endpoint.customObjectId || endpoint.custom_object_id || ""}`;

const isReportPath = (path) => Array.isArray(path) && path.every((hop) =>
  hop && typeof hop === "object" && !Array.isArray(hop)
  && hop.relationship_definition_id != null
  && ["source", "target"].includes(hop.from_side));

export const endpointLabel = (endpoint = {}, objects = [], startObject) => {
  if (endpoint.kind === "custom_object") {
    const id = endpoint.customObjectId || endpoint.custom_object_id;
    const object = String(id) === String(startObject?.id)
      ? startObject
      : objects.find((item) => String(item.id) === String(id));
    return object?.plural_label
      || object?.singular_label
      || (id ? `Custom object (${id})` : "Custom object");
  }
  return {
    member: "Member",
    organization: "Organisation",
    organization_group: "Organisation group",
  }[endpoint.kind] || "Unknown entity";
};

// Enumerate entity types, not every possible path through the graph. The
// progressive selector resolves only the path the administrator is exploring.
export const reportReachableEndpoints = (definitions, start) => {
  const seen = new Map([[endpointKey(start), start]]);
  const queue = [start];
  while (queue.length) {
    const endpoint = queue.shift();
    for (const definition of definitions) {
      if (definition.status !== "active") continue;
      for (const side of ["source", "target"]) {
        if (!relationshipEndpointsMatch(endpoint, relationshipEndpoint(definition, side))) continue;
        const next = relationshipEndpoint(definition, side === "source" ? "target" : "source");
        if (!seen.has(endpointKey(next))) {
          seen.set(endpointKey(next), next);
          queue.push(next);
        }
      }
    }
  }
  return [...seen.values()];
};

export const reportColumnSummary = (column, { start, row, definitions, objects, object }) => {
  const rowRelative = ["count_distinct", "exists_related"].includes(column.kind);
  const path = isReportPath(column.path) ? column.path : [];
  const resolved = resolveRelationshipPickerPath({ definitions, start: rowRelative ? row : start, path, maxHops: 6 });
  if (resolved.error) return "Saved relationship unavailable — selection retained";
  const destination = endpointLabel(resolved.endpoint, objects, object);
  const origin = endpointLabel(rowRelative ? row : start, objects, object);
  const via = path.slice(0, -1).map((_, index) => endpointLabel(resolveRelationshipPickerPath({
    definitions, start: rowRelative ? row : start, path: path.slice(0, index + 1), maxHops: 6,
  }).endpoint, objects, object)).join(" / ");
  const final = definitions.find((item) => String(item.id) === String(path.at(-1)?.relationship_definition_id));
  const relationship = path.at(-1)?.from_side === "source" ? final?.source_label : final?.target_label;
  const route = (path.length <= 1 ? `linked directly to ${origin}` : `linked to ${origin} via ${via}`)
    + (relationship ? ` · ${relationship}` : "");
  if (column.kind === "count_distinct") return `Count distinct ${destination} ${route}`;
  if (column.kind === "exists_related") {
    const count = Array.isArray(column.conditions) ? column.conditions.length : "Invalid";
    return `Has matching ${destination} ${route} · True / False · ${count} condition${count === 1 ? "" : "s"}`;
  }
  return `${column.kind === "relationship_field" ? "Relationship value" : destination + " field"}${path.length ? ` · ${route}` : " · starting records"}`;
};

export const reportPathLabel = (
  path = [], definitions = [], objects = [], startObject, rootEndpoint,
) => {
  let endpoint = rootEndpoint
    || { kind: "custom_object", customObjectId: startObject?.id };
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

export const makeReportConfig = (objectId, overrides = {}) => {
  const common = {
    version: REPORT_CONFIG_VERSION,
    start_object_id: String(objectId),
    grain_path: [],
    columns: [],
    multi_value: "join",
  };
  const hasVersion = Object.hasOwn(overrides || {}, "version");
  if (hasVersion && overrides.version !== REPORT_CONFIG_VERSION) {
    return { ...common, ...overrides, version: overrides.version };
  }
  return {
    ...common,
    start_endpoint: { kind: "custom_object", customObjectId: String(objectId) },
    include_empty: false,
    ...overrides,
  };
};

// Persisted report definitions are opaque snapshots. Loading must never fill
// missing properties, even when the snapshot says it is V1 or V2; doing so
// would silently rewrite a malformed or older shared definition.
export const loadReportConfig = (_objectId, persisted) => persisted;

// Reconciliation deliberately only identifies invalid selections. It never
// substitutes a similarly named field or relationship, which could change a
// shared report's meaning after a schema edit.
export const reconcileReportConfig = ({
  config,
  objectId,
  definitions = [],
  fieldsByEndpoint = {},
  metadataLoading = false,
}) => {
  // `makeReportConfig` is the builder for new V2 definitions and therefore
  // accepts partial V2 overrides. Persisted versionless input is different:
  // preserve it verbatim, flag it as unknown, and only use null-safe local
  // fallbacks while inspecting it.
  const normalized = loadReportConfig(objectId, config);
  const view = normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : {};
  const owner = { kind: "custom_object", customObjectId: objectId };
  const version = view.version;
  // V1 paths are owner-relative. Do not infer or add V2 meaning when loading
  // them: the spread in makeReportConfig retains the original version and all
  // saved values, while reconciliation uses the original path rules.
  const validStartShape = view.start_endpoint
    && typeof view.start_endpoint === "object"
    && !Array.isArray(view.start_endpoint)
    && typeof view.start_endpoint.kind === "string"
    && view.start_endpoint.kind.length > 0
    && (view.start_endpoint.kind !== "custom_object"
      || Boolean(view.start_endpoint.customObjectId || view.start_endpoint.custom_object_id));
  const start = version === 1 ? owner : (validStartShape ? view.start_endpoint : owner);
  const ownerReachable = new Set([endpointKey(owner)]);
  const queue = [owner];
  while (queue.length) {
    const endpoint = queue.shift();
    for (const definition of definitions) {
      if (definition.status !== "active") continue;
      for (const side of ["source", "target"]) {
        if (!relationshipEndpointsMatch(endpoint, relationshipEndpoint(definition, side))) continue;
        const next = relationshipEndpoint(definition, side === "source" ? "target" : "source");
        const key = endpointKey(next);
        if (!ownerReachable.has(key)) {
          ownerReachable.add(key);
          queue.push(next);
        }
      }
    }
  }
  const grainPathIsValid = isReportPath(view.grain_path);
  const pathCheck = resolveRelationshipPickerPath({
    definitions,
    start,
    path: grainPathIsValid ? view.grain_path : [],
    maxHops: 6,
  });
  const stale = [];
  let indicatorsPending = false;
  if (!SUPPORTED_REPORT_CONFIG_VERSIONS.includes(version)) {
    stale.push(`Report version ${view.version ?? "unknown"} is not supported and must be repaired.`);
  }
  if (String(view.start_object_id) !== String(objectId)) stale.push("This report belongs to another object.");
  if (!grainPathIsValid) stale.push("The related row path is malformed.");
  if (!Array.isArray(view.columns)) stale.push("The report columns are malformed.");
  if (version === 2 && (!validStartShape || !ownerReachable.has(endpointKey(start)))) {
    stale.push("The selected starting entity is unavailable or disconnected.");
  }
  if (version === 2 && typeof view.include_empty !== "boolean") {
    stale.push("The include-empty setting is invalid.");
  }
  if (pathCheck.error) stale.push(pathCheck.error);
  for (const column of Array.isArray(view.columns) ? view.columns : []) {
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      stale.push("A report column is malformed.");
      continue;
    }
    if (!["field", "relationship_field", "count_distinct", ...(version === 2 ? ["exists_related"] : [])].includes(column.kind)) {
      stale.push(`Column "${column.label || column.field_id || "unknown"}" has an unsupported kind.`);
    }
    const pathIsValid = isReportPath(column.path);
    const path = pathIsValid ? column.path : [];
    if (!pathIsValid) stale.push(`Column "${column.label || column.field_id || "unknown"}" has a malformed path.`);
    const columnStart = version === 2 && ["count_distinct", "exists_related"].includes(column.kind)
      ? pathCheck.endpoint
      : start;
    const result = resolveRelationshipPickerPath({
      definitions, start: columnStart, path, maxHops: 6,
    });
    if (version === 2 && column.kind === "exists_related") {
      // Indicators use exactly the related-filter condition semantics, always
      // existential. Do not add mode to, or otherwise rewrite, saved columns.
      const check = validateReportFilters({
        filters: [{ path: column.path, conditions: column.conditions, mode: "any" }],
        start: columnStart, definitions, fieldsByEndpoint, metadataLoading,
      });
      indicatorsPending ||= check.pending;
      stale.push(...check.stale.map((message) => `Indicator "${column.label || "unknown"}": ${message}`));
      if (Object.hasOwn(column, "mode")) stale.push(`Indicator "${column.label || "unknown"}" must not specify a match mode.`);
      continue;
    }
    if (result.error) {
      stale.push(`Column "${column.label || column.field_id || "unknown"}" has an unavailable path.`);
      continue;
    }
    if (version === 2 && column.kind === "count_distinct") {
      if (!path.length) {
        stale.push(`Distinct count column "${column.label || "unknown"}" must have a related path.`);
      }
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
    const fieldReference = column.field_id || column.field;
    if (result.endpoint?.kind === "custom_object" && fieldReference === "id") continue;
    const available = fieldsByEndpoint[endpointKey(result.endpoint)];
    // An endpoint whose metadata has not loaded is not declared stale.
    if (available && !available.some((field) => String(field.id) === String(fieldReference))) {
      stale.push(`Field column "${column.label || fieldReference}" is unavailable.`);
    }
  }
  const filterCheck = version === 2 ? validateReportFilters({
    filters: view.filters, start: pathCheck.endpoint, definitions, fieldsByEndpoint, metadataLoading,
  }) : { stale: [], pending: false };
  stale.push(...filterCheck.stale);
  return {
    config: normalized, stale, rowEndpoint: pathCheck.endpoint, rowPathError: pathCheck.error,
    filtersPending: filterCheck.pending,
    indicatorsPending,
  };
};

export const moveReportColumn = (columns, index, amount) => {
  const next = [...(columns || [])];
  const target = index + amount;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const [column] = next.splice(index, 1);
  next.splice(target, 0, column);
  return next;
};