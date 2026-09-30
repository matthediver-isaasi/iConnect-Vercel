/**
 * Form builder reachability helpers (Task #3497).
 *
 * A page or field with `starts_hidden` is only ever shown publicly when a
 * visibility rule reveals it. If nothing does, it is unreachable — the
 * admin's payment step (or any other content) silently never appears.
 *
 * Also: the membership-structure conditional action derives the charge
 * amount server-side, so a generic Payment field on such a form does not
 * need a price source field.
 */

/**
 * True when any visibility rule carries a membership_structure action with
 * a selected structure. Mirrors isMembershipStructureAction on the server
 * (api/_lib/formMembershipAction.js).
 */
export function hasMembershipStructureAction(visibilityRules) {
  const rules = Array.isArray(visibilityRules) ? visibilityRules : [];
  return rules.some((rule) =>
    Array.isArray(rule?.actions) && rule.actions.some(
      (a) => a
        && a.action_type === 'membership_structure'
        && typeof a.config_id === 'string'
        && a.config_id.trim() !== ''
    )
  );
}

/**
 * Collect ids that at least one rule can set visible. Recognises the same
 * shapes the builder's save-time normalisation does:
 *  - actions[].action_type === 'visibility' with field_states[id].visible === true
 *  - actions[].action_type === 'show' with target_field_ids
 *  - legacy rule.action === 'show' with rule.target_field_ids
 */
export function collectRevealableIds(visibilityRules) {
  const revealable = new Set();
  const rules = Array.isArray(visibilityRules) ? visibilityRules : [];
  for (const rule of rules) {
    if (!rule) continue;
    if (Array.isArray(rule.actions)) {
      for (const action of rule.actions) {
        if (!action) continue;
        if (action.action_type === 'visibility' && action.field_states && typeof action.field_states === 'object') {
          for (const [id, state] of Object.entries(action.field_states)) {
            if (state && state.visible === true) revealable.add(id);
          }
        }
        if (action.action_type === 'show' && Array.isArray(action.target_field_ids)) {
          for (const id of action.target_field_ids) revealable.add(id);
        }
      }
    }
    if (rule.action === 'show' && Array.isArray(rule.target_field_ids)) {
      for (const id of rule.target_field_ids) revealable.add(id);
    }
  }
  return revealable;
}

/**
 * Find starts-hidden pages and fields that no visibility rule ever reveals.
 * Fields sitting on an unreachable hidden page are NOT re-reported
 * individually (the page finding covers them).
 *
 * Returns { pages: [{ id, title }], fields: [{ id, label }] }.
 */
// Public renderer (FormView.jsx) treats both boolean true and the legacy
// persisted string 'true' as hidden — mirror that here.
export function isStartsHidden(item) {
  return !!item && (item.starts_hidden === true || item.starts_hidden === 'true');
}

export function findUnrevealedHidden(fields, pages, visibilityRules) {
  const revealable = collectRevealableIds(visibilityRules);
  const pageList = Array.isArray(pages) ? pages : [];
  const fieldList = Array.isArray(fields) ? fields : [];

  const unreachablePages = pageList
    .filter((p) => isStartsHidden(p) && !revealable.has(p.id))
    .map((p) => ({ id: p.id, title: p.title || 'Untitled page' }));
  const unreachablePageIds = new Set(unreachablePages.map((p) => p.id));

  const unreachableFields = fieldList
    .filter((f) => isStartsHidden(f)
      && !revealable.has(f.id)
      && !unreachablePageIds.has(f.page_id))
    .map((f) => ({ id: f.id, label: f.label || 'Untitled field' }));

  return { pages: unreachablePages, fields: unreachableFields };
}
