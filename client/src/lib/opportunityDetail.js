const asArray = (value) => Array.isArray(value)
  ? value
  : Array.isArray(value?.data)
    ? value.data
    : Array.isArray(value?.items)
      ? value.items
      : [];

const firstCollection = (sources, aliases) => {
  for (const source of sources) {
    for (const alias of aliases) {
      if (source && Object.prototype.hasOwnProperty.call(source, alias)) {
        return asArray(source[alias]);
      }
    }
  }
  return [];
};

/**
 * Normalizes the current flattened fullDetail response and older nested
 * response shapes into the single shape consumed by OpportunityDetail.
 */
export function normalizeOpportunityDetail(response) {
  const value = response?.data || response || {};
  const opportunity = value.opportunity || value;
  // Wrapper-level collections take precedence, followed by collections
  // flattened onto the opportunity itself.
  const sources = value.opportunity ? [value, opportunity] : [opportunity];
  return {
    opportunity,
    permissions: value.permissions || value.capabilities
      || opportunity.permissions || opportunity.capabilities || {},
    stages: firstCollection(sources, ["stages"]),
    collections: {
      contacts: firstCollection(sources, ["contacts", "contact-roles", "contactRoles", "contact_roles"]),
      collaborators: firstCollection(sources, ["collaborators"]),
      notes: firstCollection(sources, ["notes"]),
      tasks: firstCollection(sources, ["tasks"]),
      documents: firstCollection(sources, ["documents"]),
      activity: firstCollection(sources, ["activity", "activities"]),
      stageHistory: firstCollection(sources, ["stageHistory", "stage_history", "history"]),
    },
  };
}