// A narrow, audited extraction of the verified "Your organisation" page.
// Never copy the source form's pipelines or registration configuration.
export const PROFILE_AFFILIATION_SOURCE = '6880a70a-8643-4fcc-a5b9-0af603f00b40';
export const PROFILE_AFFILIATION_PAGE = 'page_1788778075414';
const excluded = new Set(['field_1786367685995', 'field_1788273087721',
  'field_1788942958189', 'field_1789540048027']);
export function adaptProfileAffiliationPage(source, newId) {
  if (source.id !== PROFILE_AFFILIATION_SOURCE || source.pages?.[1]?.id !== PROFILE_AFFILIATION_PAGE) {
    throw new Error('The source page changed; inspect it before extraction.');
  }
  const selected = source.fields.filter(f => f.page_id === PROFILE_AFFILIATION_PAGE && !excluded.has(f.id));
  if (!selected.some(f => f.id === 'field_1787932022165' && f.type === 'organisation_group_dropdown')
    || !selected.some(f => f.id === 'field_1788674418554' && f.type === 'repeatable_rows')) {
    throw new Error('The verified Group or additional-sites selector changed.');
  }
  const ids = new Map();
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(collect);
    // Field IDs only: embedded CRM object/relationship IDs must stay unchanged.
    if (typeof value.id === 'string' && /^(field_|row_field_)/.test(value.id)) ids.set(value.id, newId());
    Object.values(value).forEach(collect);
  };
  selected.forEach(collect);
  const pageId = newId();
  const remap = value => {
    if (typeof value === 'string') return ids.get(value) || value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [ids.get(key) || key, remap(item)]));
    return value;
  };
  const fields = selected.map(field => ({ ...remap(field), page_id: pageId }));
  // Retain only visibility actions. Pricing/class/region/copy-to-creation
  // actions belong to registration, not profile affiliation management.
  const rules = [];
  for (const rule of source.visibility_rules || []) {
    // This registration rule combines the overseas branch with the NMC
    // journal answer. The page already has an independent country-only
    // overseas visibility rule; retain that, not the journal dependency.
    if (rule.id === 'rule_1788777735347'
      && rule.conditions?.some(c => c.field_id === 'field_1788103326282' && c.value === 'No')) continue;
    const actions = (rule.actions || []).filter(a => a.action_type === 'visibility').map(action => ({
      ...action, field_states: Object.fromEntries(Object.entries(action.field_states || {}).filter(([id]) => ids.has(id))),
    })).filter(a => Object.keys(a.field_states).length);
    if (!actions.length) continue;
    if ((rule.conditions || []).some(c => !ids.has(c.field_id))) {
      throw new Error(`Cross-page condition requires explicit adaptation: ${rule.id}`);
    }
    rules.push(remap({ ...rule, id: newId(), actions: actions.map(a => ({ ...a, id: newId() })) }));
  }
  return {
    form: { name: 'Update my affiliations', slug: 'update-my-affiliations', form_type: 'standard',
      fields, pages: [{ id: pageId, title: 'Your affiliations', page_style: 'standard', column_count: 1 }],
      visibility_rules: rules, is_active: false, require_authentication: true,
      mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
      entity_pipelines: {}, field_mappings: [], structured_actions: { version: 1, actions: [] },
      auto_create_entity: false, is_application_form: false, is_due_diligence_enabled: false,
      due_diligence_required: false, allow_save_continue_later: false,
      success_message: 'Your affiliation changes have been saved.', submit_button_text: 'Save affiliations',
      form_width: source.form_width || 'narrow' },
    references: Object.fromEntries(ids),
  };
}
