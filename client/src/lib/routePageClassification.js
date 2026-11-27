// Resolves the Layout page name for the route that actually matched.
//
// The URL-based classifier only knows explicit prefixes and single-segment
// page names, so a parameterised route such as /FormSubmission/:id falls back
// to "_DynamicPage" (its last segment is an ID). Layout treats that marker as a
// hybrid CMS page that handles its own auth, which skipped the login redirect
// for protected deep links. When the URL classifier gives up, use the page
// registered for the matched route component instead.

export const DYNAMIC_PAGE_NAME = '_DynamicPage';

// Builds component -> page-name lookups. The first registered name wins so
// aliases (e.g. Signup/TenantSignup) keep a stable canonical name.
export function buildComponentPageNames(pages, extraNames = []) {
  const names = new Map();
  for (const [name, component] of Object.entries(pages || {})) {
    if (component && !names.has(component)) names.set(component, name);
  }
  for (const [component, name] of extraNames) {
    if (component && !names.has(component)) names.set(component, name);
  }
  return names;
}

/**
 * @param {object} input
 * @param {string} input.pathPageName - result of the URL-based classifier.
 * @param {unknown} input.component - element type of the deepest matched route.
 * @param {string} [input.routePath] - path pattern of that route. Only
 *   parameterised patterns are reclassified; static aliases keep their name.
 * @param {Map<unknown,string>} input.componentPageNames - from buildComponentPageNames.
 * @param {Set<unknown>} input.dynamicComponents - CMS renderers (always "_DynamicPage").
 * @param {Set<unknown>} [input.retainDynamicComponents] - matched components whose
 *   parameterised routes intentionally keep the hybrid "_DynamicPage" policy.
 */
export function resolveRoutePageName({
  pathPageName,
  component,
  routePath,
  componentPageNames,
  dynamicComponents,
  retainDynamicComponents = new Set(),
}) {
  if (dynamicComponents.has(component)) return DYNAMIC_PAGE_NAME;
  if (pathPageName !== DYNAMIC_PAGE_NAME) return pathPageName;
  if (!component || !/[:*]/.test(routePath || '') || retainDynamicComponents.has(component)) {
    return DYNAMIC_PAGE_NAME;
  }
  return componentPageNames.get(component) || DYNAMIC_PAGE_NAME;
}
