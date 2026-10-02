import { resolveRelationshipPickerPath } from "./relationshipHelpers.js";

export const MAX_REPORT_FILTERS = 10;
export const MAX_FILTER_CONDITIONS = 10;
export const CORE_FILTER_FIELDS = {
  member: [
    ["full_name", "Full name"], ["first_name", "First name"], ["last_name", "Last name"],
    ["email", "Email"], ["organization_id", "Organisation ID"],
  ],
  organization: [["name", "Name"], ["email", "Email"]],
  organization_group: [["name", "Name"]],
};
const textTypes = ["text", "textarea", "email", "url"];
const numericTypes = ["number", "decimal"];
const emptyOps = ["is_empty", "is_not_empty"];
const keyOf = (endpoint = {}) =>
  `${endpoint.kind || ""}:${endpoint.customObjectId || endpoint.custom_object_id || ""}`;
export const isFilterObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
export const isFilterPath = (path) => Array.isArray(path) && path.length > 0
  && path.length <= 6 && path.every((hop) => isFilterObject(hop)
    && (typeof hop.relationship_definition_id === "string" || typeof hop.relationship_definition_id === "number")
    && String(hop.relationship_definition_id).length > 0
    && ["source", "target"].includes(hop.from_side));
export const filterOperators = (type) => {
  if (textTypes.includes(type)) return ["equals", "contains", ...emptyOps];
  if (numericTypes.includes(type)) return ["equals", "gt", "gte", "lt", "lte", ...emptyOps];
  if (type === "boolean") return ["equals", ...emptyOps];
  return [];
};
export const filterFieldKey = (condition) => {
  if (!isFilterObject(condition)) return "";
  return JSON.stringify([
    condition.kind,
    String(condition.kind === "relationship_field" ? condition.relationship_field_id
      : condition.field_id != null ? condition.field_id : condition.field),
    condition.kind === "field" && condition.field_id != null ? "custom" : "",
  ]);
};
export const filterFieldReference = (field) => ({
  kind: field.kind,
  ...(field.kind === "relationship_field" ? { relationship_field_id: String(field.id) }
    : field.custom ? { field_id: String(field.id) } : { field: String(field.id) }),
});
export const makeFilterCondition = (field) => ({
  ...filterFieldReference(field),
  op: "equals",
  value: field.type === "boolean" ? true : numericTypes.includes(field.type) ? 0 : "",
});
export const changeFilterOperator = (condition, op, type) => {
  const { value, ...rest } = condition;
  if (emptyOps.includes(op)) return { ...rest, op };
  return { ...rest, op, value: value ?? (type === "boolean" ? true : numericTypes.includes(type) ? 0 : "") };
};

// Metadata is supplied by the authorised graph, never inferred from tenant labels.
// Missing custom field metadata means loading, not an empty schema.
export const reportFilterFields = ({ path, start, definitions = [], fieldsByEndpoint = {} }) => {
  const validPath = isFilterPath(path);
  const resolved = resolveRelationshipPickerPath({
    definitions, start, path: validPath ? path : [], maxHops: 6,
  });
  const available = fieldsByEndpoint[keyOf(resolved.endpoint)];
  const endpointFields = resolved.endpoint?.kind === "custom_object"
    ? (Array.isArray(available) ? available.filter((field) => field.is_active !== false).map((field) => ({
      ...field, type: field.field_type || field.type, kind: "field", custom: true,
    })) : [])
    : (CORE_FILTER_FIELDS[resolved.endpoint?.kind] || []).map(([id, label]) => ({
      id, label, type: "text", kind: "field",
    }));
  const finalDefinition = validPath && !resolved.error
    ? definitions.find((definition) => String(definition.id) === String(path.at(-1).relationship_definition_id))
    : null;
  const rawMetadata = finalDefinition?.configuration?.relationship_fields
    || finalDefinition?.configuration?.relationshipFields || finalDefinition?.relationship_fields || [];
  const edgeFields = (Array.isArray(rawMetadata) ? rawMetadata : [])
    .filter((field) => isFilterObject(field) && field.is_active !== false && (field.id != null || field.key))
    .map((field) => ({
      ...field, id: String(field.id ?? field.key),
      type: field.field_type || field.type || "boolean", kind: "relationship_field",
      label: `Relationship: ${field.label || field.key || field.id}`,
    }));
  const all = [...endpointFields, ...edgeFields];
  return {
    fields: all.filter((field) => filterOperators(field.type).length > 0),
    unsupported: all.filter((field) => !filterOperators(field.type).length),
    pending: validPath && !resolved.error && resolved.endpoint?.kind === "custom_object" && !Array.isArray(available),
    error: !validPath ? "Choose a nonempty related path of up to six hops." : resolved.error,
  };
};

export const validateReportFilters = ({
  filters, start, definitions = [], fieldsByEndpoint = {}, metadataLoading = false,
}) => {
  const stale = [];
  let pending = metadataLoading;
  if (filters === undefined) return { stale, pending: false };
  if (!Array.isArray(filters)) return { stale: ["Relationship filters are malformed; explicitly reset them to repair."], pending };
  if (filters.length > MAX_REPORT_FILTERS) stale.push("A report supports at most ten relationship filters.");
  filters.forEach((filter, index) => {
    const prefix = `Filter ${index + 1}`;
    if (!isFilterObject(filter)) {
      stale.push(`${prefix} is malformed; remove or replace it.`);
      return;
    }
    if (!["any", "none"].includes(filter.mode)) stale.push(`${prefix} has an invalid match mode.`);
    const schema = reportFilterFields({ path: filter.path, start, definitions, fieldsByEndpoint });
    pending ||= schema.pending;
    if (!isFilterPath(filter.path) || (!metadataLoading && schema.error)) stale.push(`${prefix}: ${schema.error}`);
    if (!Array.isArray(filter.conditions)) {
      stale.push(`${prefix} conditions are malformed; explicitly reset them to repair.`);
      return;
    }
    if (filter.conditions.length > MAX_FILTER_CONDITIONS) stale.push(`${prefix} supports at most ten conditions.`);
    filter.conditions.forEach((condition, conditionIndex) => {
      const label = `${prefix}, condition ${conditionIndex + 1}`;
      if (!isFilterObject(condition) || !["field", "relationship_field"].includes(condition.kind)) {
        stale.push(`${label} is malformed.`);
        return;
      }
      const reference = condition.kind === "relationship_field" ? condition.relationship_field_id
        : condition.field_id ?? condition.field;
      if (reference == null || String(reference).length === 0
        || (condition.kind === "field" && condition.field_id != null && condition.field != null)) {
        stale.push(`${label} has an invalid field reference.`);
        return;
      }
      const field = schema.fields.find((item) => filterFieldKey(filterFieldReference(item)) === filterFieldKey(condition));
      if (!field) {
        // Edge metadata is already loaded with the graph; only endpoint fields can be pending.
        if (!metadataLoading && !(schema.pending && condition.kind === "field" && condition.field_id != null)) {
          stale.push(`${label} selects an unavailable or unsupported field; choose a replacement or remove it.`);
        }
        return;
      }
      if (!filterOperators(field.type).includes(condition.op)) stale.push(`${label} has an unsupported operator.`);
      else if (!emptyOps.includes(condition.op)) {
        if (field.type === "boolean" && typeof condition.value !== "boolean") stale.push(`${label} needs a Yes or No boolean value.`);
        else if (numericTypes.includes(field.type) && (typeof condition.value !== "number" || !Number.isFinite(condition.value))) stale.push(`${label} needs a finite number.`);
        else if (textTypes.includes(field.type) && typeof condition.value !== "string") stale.push(`${label} needs a text value.`);
      }
    });
  });
  return { stale, pending };
};