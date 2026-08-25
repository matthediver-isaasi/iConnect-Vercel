export const ENTITY_KINDS = [
  ["member", "Member"],
  ["organization", "Organization"],
  ["organization_group", "Organization group"],
  ["custom_object", "Custom object"],
];

export const CARDINALITIES = [
  ["one_to_one", "One to one"],
  ["one_to_many", "One to many"],
  ["many_to_one", "Many to one"],
  ["many_to_many", "Many to many"],
];

export const definitionList = (payload) =>
  Array.isArray(payload) ? payload : payload?.data || [];

export const isDefinitionVisible = (definition, side) =>
  side === "source" ? definition.show_on_source !== false : definition.show_on_target !== false;

export const canEditDefinitionFrom = (definition, side, hasPermission = true) =>
  Boolean(
    hasPermission &&
      (side === "source" ? definition.edit_from_source !== false : definition.edit_from_target !== false),
  );

export const oppositeSide = (side) => (side === "source" ? "target" : "source");

export const displaySide = (definition, currentKind, currentObjectId) => {
  const sourceMatch =
    definition.source_kind === currentKind &&
    (currentKind !== "custom_object" ||
      String(definition.source_custom_object_id) === String(currentObjectId));
  return sourceMatch ? "source" : "target";
};

export const applicableSidesForRecord = (definition, currentKind, currentObjectId) => {
  const matches = (side) =>
    definition[`${side}_kind`] === currentKind &&
    (currentKind !== "custom_object" ||
      String(definition[`${side}_custom_object_id`]) === String(currentObjectId));
  return ["source", "target"].filter(matches);
};

export const oppositeKindFor = (definition, side) =>
  side === "source"
    ? { kind: definition.target_kind, customObjectId: definition.target_custom_object_id }
    : { kind: definition.source_kind, customObjectId: definition.source_custom_object_id };

export const labelForSide = (definition, side) =>
  (side === "source" ? definition.source_label : definition.target_label) ||
  (side === "source" ? "Related records" : "Related records");

export const cardinalityLimitReached = (definition, editSide, currentTotal) => {
  const cardinality = definition.cardinality || "many_to_many";
  if (cardinality === "one_to_one") return currentTotal >= 1;
  if (cardinality === "one_to_many") return editSide === "target" && currentTotal >= 1;
  if (cardinality === "many_to_one") return editSide === "source" && currentTotal >= 1;
  return false;
};

export const relationshipPayload = ({ definitionId, recordId, entityId, editSide }) =>
  editSide === "source"
    ? {
        relationship_definition_id: definitionId,
        source_record_id: recordId,
        target_record_id: entityId,
        routed_side: editSide,
        routed_record_id: recordId,
      }
    : {
        relationship_definition_id: definitionId,
        source_record_id: entityId,
        target_record_id: recordId,
        routed_side: editSide,
        routed_record_id: recordId,
      };

export const defaultDefinitionForm = (objectId) => ({
  relationship_key: "",
  source_kind: "custom_object",
  source_custom_object_id: String(objectId),
  target_kind: "member",
  target_custom_object_id: "",
  cardinality: "many_to_many",
  source_label: "",
  target_label: "",
  is_required: false,
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: false,
  status: "active",
  configuration: {},
});

export const definitionPayload = (form) => ({
  ...form,
  relationship_key: form.relationship_key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
  source_custom_object_id: form.source_kind === "custom_object" ? form.source_custom_object_id : null,
  target_custom_object_id: form.target_kind === "custom_object" ? form.target_custom_object_id : null,
  configuration: form.configuration || {},
});