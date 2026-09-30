export const MAIN_SITE_SCOPE = 'main';

export function canvasFooterScopeId(footer) {
  return footer?.microsite_id ? String(footer.microsite_id) : MAIN_SITE_SCOPE;
}

export function buildCanvasFooterCreatePayload({
  name,
  design,
  siteId = MAIN_SITE_SCOPE,
  assignToMicrosite = false,
}) {
  const micrositeId = siteId && siteId !== MAIN_SITE_SCOPE ? String(siteId) : null;
  return {
    name,
    design,
    microsite_id: micrositeId,
    assign_to_microsite: !!micrositeId && assignToMicrosite === true,
  };
}