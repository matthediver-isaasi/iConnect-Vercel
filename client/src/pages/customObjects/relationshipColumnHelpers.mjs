export const RELATIONSHIP_COLUMN_MIN_WIDTH = 120;
export const RELATIONSHIP_COLUMN_MAX_WIDTH = 480;

export const clampRelationshipColumnWidth = (value, fallback = 180) => {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.round(Math.max(
    RELATIONSHIP_COLUMN_MIN_WIDTH,
    Math.min(RELATIONSHIP_COLUMN_MAX_WIDTH, safe),
  ));
};

export const relationshipColumnDescriptors = ({
  recordLabel = "Record",
  relationshipFields = [],
  previewColumns = [],
} = {}) => {
  const descriptors = [{
    id: "record",
    kind: "record",
    label: recordLabel,
    defaultWidth: 240,
    sortField: "record",
  },
  ...relationshipFields.map((field) => ({
    id: `relationship-field:${field.id}`,
    kind: "relationship_boolean",
    label: field.label,
    fieldId: String(field.id),
    defaultWidth: 180,
    sortField: `relationship_field:${field.id}`,
  })),
  ...previewColumns.map((column) => column.type === "field" ? {
    id: `field:${column.field_id}`,
    kind: "compact_scalar",
    label: column.label,
    fieldId: String(column.field_id),
    defaultWidth: 180,
    sortField: `field:${column.field_id}`,
  } : {
    id: `relationship:${column.relationship_definition_id}:${column.side}`,
    kind: "relationship_preview",
    label: column.label,
    relationshipDefinitionId: String(column.relationship_definition_id),
    side: column.side,
    defaultWidth: 220,
    sortField: `relationship:${column.relationship_definition_id}:${column.side}`,
  })];
  return descriptors.filter((descriptor, index) =>
    descriptors.findIndex((item) => item.id === descriptor.id) === index);
};

export const defaultRelationshipColumnState = (descriptors = []) => ({
  order: descriptors.map(({ id }) => id),
  widths: Object.fromEntries(
    descriptors.map(({ id, defaultWidth }) => [
      id,
      clampRelationshipColumnWidth(defaultWidth),
    ]),
  ),
  sortField: "",
  sortDir: "asc",
});

// Saved references are schema IDs, not labels. Removed fields disappear and
// newly configured fields are appended in their metadata order.
export const reconcileRelationshipColumnState = (descriptors = [], saved = {}) => {
  const defaults = defaultRelationshipColumnState(descriptors);
  const available = new Set(defaults.order);
  const sortable = new Set(descriptors.map(({ sortField }) => sortField).filter(Boolean));
  const savedOrder = Array.isArray(saved?.order)
    ? [...new Set(saved.order.map(String))].filter((id) => available.has(id))
    : [];
  const order = [...savedOrder, ...defaults.order.filter((id) => !savedOrder.includes(id))];
  const widths = Object.fromEntries(order.map((id) => [
    id,
    clampRelationshipColumnWidth(saved?.widths?.[id], defaults.widths[id]),
  ]));
  return {
    order,
    widths,
    sortField: sortable.has(saved?.sortField) ? saved.sortField : "",
    sortDir: saved?.sortDir === "desc" ? "desc" : "asc",
  };
};

export const moveRelationshipColumn = (order, id, direction) => {
  const current = order.indexOf(id);
  const next = current + direction;
  if (current < 0 || next < 0 || next >= order.length) return [...order];
  const result = [...order];
  [result[current], result[next]] = [result[next], result[current]];
  return result;
};

export const relationshipTablePreferenceKey = ({
  memberId,
  definitionId,
  side,
  contextKind,
  objectId,
}) => {
  if (!memberId || !definitionId || !side) return null;
  const context = contextKind === "custom_object" && objectId
    ? `custom_object_${objectId}`
    : String(contextKind || "record");
  return `relationship_columns_${memberId}_${context}_${definitionId}_${side}`;
};