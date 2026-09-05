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
  Array.isArray(payload) ? payload : payload?.data || payload?.definitions || [];

export const relationshipPanels = (payload, context, { includeArchived = false } = {}) =>
  definitionList(payload).flatMap((item) => {
    const rawDefinition = item.definition || item;
    const definition = {
      ...rawDefinition,
      can_edit: item.can_edit ?? item.capabilities?.can_edit ?? rawDefinition.can_edit,
    };
    const suppliedSide = item.side || definition.side || definition.routed_side;
    const sides = suppliedSide
      ? [suppliedSide]
      : applicableSidesForRecord(definition, context.kind, context.objectId);
    return sides
      .filter((side) =>
        definition.status !== "inactive"
        && (includeArchived || definition.status !== "archived"))
      .filter((side) => isDefinitionVisible(definition, side))
      .map((side) => ({
        definition,
        side,
        count: item.count ?? item.total ?? definition.count ?? definition.total,
      }));
  });

export const relationshipTabValue = (definition, side) =>
  `relationship-${definition.id}-${side}`;

export const relatedRecordPath = (related = {}) => {
  if (related.href || related.url) return related.href || related.url;
  const kind = related.kind || related.entity_kind;
  const id = related.id || related.record_id;
  if (!id) return null;
  if (kind === "member") return `/members/${id}`;
  if (kind === "organization") return `/organisations/${id}`;
  if (kind === "organization_group") return `/OrganisationGroups/${id}`;
  const objectId = related.custom_object_id || related.object_id;
  return objectId ? `/CustomObjectsAdmin/${objectId}/records/${id}` : null;
};

export const safeInAppPath = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const parsed = new URL(value, "https://app.local");
    return parsed.origin === "https://app.local"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : null;
  } catch {
    return null;
  }
};

export const relationshipOriginPath = (location = {}) =>
  safeInAppPath(`${location.pathname || ""}${location.search || ""}${location.hash || ""}`);

export const relationshipLinkState = (location) => {
  const returnTo = relationshipOriginPath(location);
  return returnTo ? { relationshipReturnTo: returnTo } : undefined;
};

export const relationshipBackPath = (state, fallback) =>
  safeInAppPath(state?.relationshipReturnTo) || fallback;

export const isDefinitionVisible = (definition, side) =>
  side === "source" ? definition.show_on_source !== false : definition.show_on_target !== false;

export const canEditDefinitionFrom = (definition, side, hasPermission = true) =>
  Boolean(
    hasPermission &&
      definition.can_edit !== false &&
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

const createCapability = (object = {}) => {
  const capabilities = object.capabilities || object.permissions;
  if (!capabilities) return true;
  if (Array.isArray(capabilities))
    return capabilities.includes("create_records") || capabilities.includes("create");
  return capabilities.create_records ?? capabilities.can_create_records ?? capabilities.create ?? true;
};

// A relationship panel can only offer contextual creation for an active Custom
// Object at its opposite endpoint. Core records deliberately never qualify.
export const contextualCreateEligibility = ({ definition, side, object }) => {
  const endpoint = oppositeKindFor(definition, side);
  if (endpoint.kind !== "custom_object" || !endpoint.customObjectId) return null;
  if (!object || String(object.id) !== String(endpoint.customObjectId)) return null;
  return object.status === "active" && createCapability(object)
    ? { objectId: endpoint.customObjectId, endpoint }
    : null;
};

export const initialRelationshipSelectors = (payload, context) =>
  relationshipPanels(payload, context)
    .filter(({ definition, side }) =>
      definition.status === "active" && canEditDefinitionFrom(definition, side))
    .map(({ definition, side }) => ({ definition, side }));

export const relationshipSelectorKey = (definitionId, side) =>
  `${definitionId}:${side}`;

// SQL only enforces a required relationship where the newly-created record is
// the source endpoint. A target-side/inbound definition must stay optional.
export const isRequiredInitialRelationship = (definition, newRecordSide) =>
  definition.is_required === true && newRecordSide === "source";

// Relationship labels describe what is shown while viewing that endpoint.
// Contextual creation therefore uses the new record's routed-side label, not
// the opposite endpoint's label.
export const initialRelationshipLabel = (definition, newRecordSide) =>
  (newRecordSide === "source" ? definition.source_label : definition.target_label)
  || "Related records";

export const initialRelationshipAllowsMultiple = (definition, newRecordSide) => {
  const cardinality = definition.cardinality || "many_to_many";
  if (cardinality === "one_to_one") return false;
  if (cardinality === "many_to_one") return newRecordSide === "target";
  if (cardinality === "one_to_many") return newRecordSide === "source";
  return true;
};

export const relationshipCandidateLabel = (entry) =>
  entry?.primary_label || entry?.display_value || entry?.name || "Untitled record";

export const contextualOriginLabel = (context, record) => {
  if (!record) return "";
  if (context?.kind === "member") {
    return [record.first_name, record.last_name].filter(Boolean).join(" ").trim()
      || record.email
      || "";
  }
  return record.primary_label || record.display_value || record.name || "";
};

export const contextualPrimaryNameSuggestion = ({
  originLabel,
  selectors,
  relationships,
}) => {
  const singleSelectors = (selectors || []).filter(({ definition, side, fixed }) =>
    !fixed && !initialRelationshipAllowsMultiple(definition, side));
  if (!originLabel || singleSelectors.length !== 1) return "";
  const selector = singleSelectors[0];
  const selected = relationships?.[relationshipSelectorKey(selector.definition.id, selector.side)] || [];
  if (selected.length !== 1) return "";
  const relatedLabel = relationshipCandidateLabel(selected[0]);
  return relatedLabel && relatedLabel !== "Untitled record"
    ? `${originLabel} - ${relatedLabel}`
    : "";
};

export const shouldApplyContextualNameSuggestion = ({
  manuallyOverridden,
  currentValue,
  suggestedValue,
}) => !manuallyOverridden && currentValue !== suggestedValue;

export const nextInitialRelationshipSelection = ({
  selected,
  entry,
  checked,
  allowsMultiple,
}) => {
  const current = Array.isArray(selected) ? selected : [];
  const id = String(entry.id);
  if (!checked) return current.filter((item) => String(item.id) !== id);
  if (!allowsMultiple) return [entry];
  return [...current.filter((item) => String(item.id) !== id), entry];
};

export const contextualRelationshipPayload = ({
  definitionId, originContext, originSide, relatedRecordId,
}) => {
  const originIsSource = originSide === "source";
  return {
    relationship_definition_id: definitionId,
    source_record_id: originIsSource ? originContext.recordId : relatedRecordId,
    target_record_id: originIsSource ? relatedRecordId : originContext.recordId,
    source_kind: originIsSource ? originContext.kind : "custom_object",
    target_kind: originIsSource ? "custom_object" : originContext.kind,
    routed_side: originSide,
    routed_record_id: originContext.recordId,
  };
};

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

export const relationshipCreatePayload = ({
  contextKind,
  definitionId,
  recordId,
  entityId,
  editSide,
}) => contextKind === "custom_object"
  ? relationshipPayload({ definitionId, recordId, entityId, editSide })
  : {
      relationship_definition_id: definitionId,
      related_record_id: entityId,
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

export const relationshipSourceName = (object = {}) =>
  object.plural_label || object.singular_label || object.object_key || "Current custom object";

export const resolveRelationshipSourceObject = ({
  currentObject,
  sourceObjectId,
  objects = [],
}) => {
  if (!sourceObjectId || String(sourceObjectId) === String(currentObject?.id)) {
    return currentObject;
  }
  return objects.find((item) => String(item.id) === String(sourceObjectId)) || null;
};

export const canDefineRelationships = (object = {}) => object.status === "active";

export const definitionPayload = (form) => ({
  ...form,
  relationship_key: form.relationship_key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
  source_custom_object_id: form.source_kind === "custom_object" ? form.source_custom_object_id : null,
  target_custom_object_id: form.target_kind === "custom_object" ? form.target_custom_object_id : null,
  configuration: form.configuration || {},
});