import { organizationGroupScope, organizationGroupConditionError } from '../../shared/audienceOrganizationGroup.js';

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Organisation Group audience data could not be loaded.');
  return data;
}

export async function validateAudienceOrganizationGroups(db, tenantId, segments) {
  const conditions = (segments || []).filter(s => s.type === 'field_filter')
    .flatMap(s => (s.filter_groups || []).flatMap(g => g.conditions || []))
    .filter(c => c.entity_scope === organizationGroupScope);
  for (const c of conditions) {
    const fields = await rows(db.from('preference_field').select('id,entity_scope,is_active,field_type,options')
      .eq('tenant_id', tenantId).eq('id', c.field_key));
    const error = organizationGroupConditionError(c, fields[0]);
    if (error) throw Object.assign(new Error(error), { status: 400 });
  }
}

// Bounded member batches keep both the preview resolver and resumable preparation
// on the same relationship/predicate contract. Missing owners never satisfy even
// a negative or empty predicate; only an existing group's missing value is empty.
export async function matchOrganizationGroupMembers(db, tenantId, members, condition, applyPrefValueCondition) {
  const matched = new Set();
  for (let offset = 0; offset < members.length; offset += 200) {
    const batch = members.slice(offset, offset + 200);
    const orgIds = [...new Set(batch.map(m => m.organization_id).filter(Boolean))];
    const orgs = orgIds.length ? await rows(db.from('organization').select('id,organization_group_id')
      .eq('tenant_id', tenantId).in('id', orgIds)) : [];
    const orgMap = new Map(orgs.map(o => [o.id, o.organization_group_id]));
    const effective = m => m.organization_id ? orgMap.get(m.organization_id) : m.organization_group_id;
    const ids = [...new Set(batch.map(effective).filter(Boolean))];
    if (!ids.length) continue;
    const groups = await rows(db.from('organization_group').select('id').eq('tenant_id', tenantId).in('id', ids));
    const valid = new Set(groups.map(g => g.id));
    if (!valid.size) continue;
    let query = db.from('organization_group_preference_value').select('organization_group_id,value')
      .eq('tenant_id', tenantId).eq('field_id', condition.field_key).in('organization_group_id', [...valid]);
    let postFilter;
    if (condition.operator === 'is_empty') query = query.not('value', 'is', null).neq('value', '').neq('value', '[]');
    else ({ query, postFilter } = applyPrefValueCondition(query, condition.operator, condition.value, condition.data_type));
    const values = await rows(query);
    const matchingGroups = new Set((postFilter ? postFilter(values) : values).map(v => v.organization_group_id));
    for (const m of batch) {
      const id = effective(m);
      if (valid.has(id) && (condition.operator === 'is_empty' ? !matchingGroups.has(id) : matchingGroups.has(id))) matched.add(m.id);
    }
  }
  return matched;
}
