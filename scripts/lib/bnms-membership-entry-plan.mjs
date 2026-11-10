import assert from 'node:assert/strict';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const CONTINUING = '7e263a45-ad57-4404-bc18-05288fd52ec9';
export const PAID_FORMS = [
  '518d4626-1c5c-4dff-85e3-0e9743b01563',
  'edd2ac75-e9aa-46e1-a971-82859fe96af5',
  'e50e9180-2392-44c6-9465-b95cae23eb8a',
  'cba644ba-2704-41cc-b7f0-8fce3bb0bdd2',
];

// Pure proposal builder. Never changes schedules, approval, questions or rules.
// Application requires a separately reviewed transaction and fresh snapshots.
export function planBnmsEntryForm(form, configs, today) {
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(form.tenant_id, TENANT);
  assert.equal(form.is_active, true);
  assert.equal(form.archived_at, null);
  assert.ok(!form.deactivate_at || Date.parse(form.deactivate_at) > Date.parse(`${today}T23:59:59Z`));
  const proposed = structuredClone(form);
  if (form.id === CONTINUING) {
    assert.equal(form.fields.some(f => /payment/.test(f.type)), false);
    assert.equal(form.entity_pipelines.organisations.length, 0);
    proposed.require_authentication = true;
    proposed.mutation_access_policy = { version: 1, mode: 'authenticated_owner' };
    // This entry only chooses a branch. It must not create an identity or
    // downgrade an existing member to the old fixed signup role.
    proposed.entity_pipelines = { ...form.entity_pipelines, members: [] };
    return proposed;
  }
  assert.ok(PAID_FORMS.includes(form.id), 'Only the four approved paid copies may change');
  assert.equal(form.require_authentication, true);
  assert.equal(form.mutation_access_policy?.mode, 'authenticated_owner');
  const payments = proposed.fields.filter(f => f.type === 'payment');
  assert.equal(payments.length, 1, 'Review unexpected payment contract');
  const actions = (form.visibility_rules || []).flatMap(r => r.actions || [])
    .filter(a => a.action_type === 'membership_structure');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].resolve_mode, 'auto');
  const classField = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
  const sourceId = actions[0].field_mappings?.[classField];
  const source = form.fields.find(f => f.id === sourceId);
  assert.ok(['radio', 'select', 'dropdown'].includes(source?.type));
  const values = (source.options || []).map(o => typeof o === 'string' ? o : o.value ?? o.label);
  assert.ok(values.length && new Set(values).size === values.length);
  const entries = values.map(value => {
    const matches = configs.filter(c => c.tenant_id === TENANT && c.is_active !== false
      && c.structure_scope_type === 'member' && c.structure_field_id === classField
      && c.structure_match_value === value
      && (!c.effective_from || c.effective_from.slice(0, 10) <= today)
      && (!c.effective_to || c.effective_to.slice(0, 10) >= today));
    assert.equal(matches.length, 1, `No unique current schedule for ${value}`);
    assert.equal(matches[0].start_mode, 'immediate');
    assert.equal(matches[0].billing_period, 'annual');
    return { value, config_id: matches[0].id };
  });
  Object.assign(payments[0], {
    type: 'membership_payment',
    field_mappings: { ...payments[0].field_mappings, ...actions[0].field_mappings },
    membership_config_id: entries[0].config_id,
    membership_schedule_mapping: { source_field_id: sourceId, entries },
  });
  return proposed;
}
