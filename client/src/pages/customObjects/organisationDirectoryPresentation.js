export const emptyOrganisationDirectoryPresentation = () => ({
  enabled: false,
  relationships: [],
  field_ids: [],
});

export const organisationDirectoryPresentation = (presentation = {}) => {
  const configured = presentation?.organisation_directory;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return emptyOrganisationDirectoryPresentation();
  }
  return {
    enabled: configured.enabled === true,
    relationships: Array.isArray(configured.relationships)
      ? configured.relationships.map(({ relationship_id, direction }) => ({
          relationship_id: String(relationship_id),
          direction,
        }))
      : [],
    field_ids: Array.isArray(configured.field_ids)
      ? configured.field_ids.map(String)
      : [],
  };
};

export const eligibleOrganisationDirectoryRelationships = (
  definitions = [],
  objectId,
) => definitions.flatMap((definition) => {
  if (definition?.status !== "active" || definition.archived_at) return [];
  return ["source", "target"].flatMap((direction) => {
    const objectSide = direction === "source" ? "target" : "source";
    if (
      definition[`${direction}_kind`] !== "organization"
      || definition[`${objectSide}_kind`] !== "custom_object"
      || String(definition[`${objectSide}_custom_object_id`] || "") !== String(objectId)
    ) return [];
    return [{
      relationship_id: String(definition.id),
      direction,
      definition,
      label: definition[`${direction}_label`]
        || definition.relationship_key
        || "Related records",
    }];
  });
});

export const organisationDirectoryRelationshipKey = (selection) =>
  `${selection.relationship_id}:${selection.direction}`;