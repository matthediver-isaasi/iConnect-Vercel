// Data-only rules for the Canvas Resource showcase source modes. Keeping this
// separate from the JSX renderer lets the author-defined manual order be
// verified without coupling the rule to the canvas UI.

export function getResourceShowcaseSourceMode(content) {
  return content?.sourceMode === 'specific' ? 'specific' : 'automatic';
}

export function resolveSpecificResourceShowcaseItems(resources, resourceIds) {
  const byId = new Map(
    (Array.isArray(resources) ? resources : []).map((resource) => [String(resource.id), resource]),
  );
  const seen = new Set();

  return (Array.isArray(resourceIds) ? resourceIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => byId.get(id))
    .filter(Boolean);
}