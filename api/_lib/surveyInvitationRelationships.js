import { invitationMapping } from '../../shared/surveyInvitationPrefill.js';
import { savedRelationshipField } from './formRelationshipOptions.js';
import { isRelationshipMultiSelect } from '../../shared/formRelationshipSelection.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';

const checked = result => { if (result.error) throw result.error; return result.data; };
const ROOTS = new Set(['member', 'organization', 'organization_group']);
const TABLES = { member: 'member', organization: 'organization', organization_group: 'organization_group', custom_object: 'custom_object_record' };
const MAX_FIELDS = 25;
const MAX_EDGES = 100;

// One published, bounded hop per field. Roots can only come from the confirmed
// attendee, never URL/body IDs. Saved dropdown chains can only use a preceding
// single-selection result, not an arbitrary respondent-selected parent.
export async function resolveInvitationRelationships({ db, tenantId, fields, settings, member, organization, relationships }) {
  const values = {};
  const reasons = {};
  const roots = { member: member.id, organization: organization?.id, organization_group: relationships.organization_group_id };
  let count = 0;
  for (const field of fields) {
    if (!field?.relationship_config && field?.type !== 'relationship_dropdown') continue;
    reasons[field.id] = 'relationship_scope_unavailable';
    if (++count > MAX_FIELDS || field.prefill_field || field.option_source
      || field.conditional_filter || field.conditional_filters) continue;
    let definitionId, parent, related, parentId, parentField;
    if (field.relationship_config) {
      const config = field.relationship_config;
      // Explicit server grammar for published attendee relationship mappings.
      // Only endpoint IDs are mapped; arbitrary relationship/record fields are
      // intentionally not exported.
      const allowedKeys = ['relationship_definition_id', 'source', 'source_side', 'related_kind', 'related_custom_object_id', 'value'];
      if (Object.keys(config).some(key => !allowedKeys.includes(key)) || !ROOTS.has(config.source)
        || !['source', 'target'].includes(config.source_side)
        || !TABLES[config.related_kind] || ![undefined, 'id'].includes(config.value)) continue;
      definitionId = config.relationship_definition_id;
      parent = { kind: config.source, side: config.source_side, custom_object_id: null };
      related = { kind: config.related_kind, custom_object_id: config.related_custom_object_id || null };
      parentId = roots[parent.kind];
    } else {
      let saved;
      try { saved = savedRelationshipField({ fields }, field.id); } catch { continue; }
      ({ relationshipDefinitionId: definitionId, parent, related, parentField } = saved);
      const mapping = invitationMapping(parentField, settings);
      const expectedRootKey = { organization: 'organization_id', organization_group: 'organization_group_id' }[parent.kind];
      if (mapping?.kind === 'relationship' && mapping.key === expectedRootKey) parentId = relationships[mapping.key];
      else if (mapping?.kind === 'member' && mapping.key === expectedRootKey) parentId = relationships[mapping.key];
      else if (parentField.type === 'relationship_dropdown' && typeof values[parentField.id] === 'string') parentId = values[parentField.id];
    }
    if (!definitionId || !parentId || !TABLES[related.kind]) continue;
    if (parent.kind === 'organization' && parentField) {
      if (!organization || organization.id !== parentId
        || !await isOrganizationEligibleForField({ db, tenantId, organization, field: parentField })) continue;
    }
    const definition = checked(await db.from('custom_object_relationship_definition')
      .select('id,source_kind,source_custom_object_id,target_kind,target_custom_object_id,status,archived_at,show_on_source,show_on_target')
      .eq('tenant_id', tenantId).eq('id', definitionId).eq('status', 'active').maybeSingle());
    if (!definition || definition.archived_at) continue;
    const sides = ['source', 'target'].filter(side => {
      const other = side === 'source' ? 'target' : 'source';
      return (!parent.side || parent.side === side) && definition[`show_on_${side}`] !== false
        && definition[`${side}_kind`] === parent.kind
        && (definition[`${side}_custom_object_id`] || null) === (parent.custom_object_id || null)
        && definition[`${other}_kind`] === related.kind
        && (definition[`${other}_custom_object_id`] || null) === (related.custom_object_id || null);
    });
    if (sides.length !== 1) continue;
    if (related.kind === 'custom_object') {
      const object = checked(await db.from('custom_object_definition').select('id,archived_at,primary_display_field_id')
        .eq('tenant_id', tenantId).eq('id', related.custom_object_id).eq('status', 'active').maybeSingle());
      if (!object || object.archived_at || related.primary_display_field_id
        && object.primary_display_field_id !== related.primary_display_field_id) continue;
    }
    const side = sides[0];
    const other = side === 'source' ? 'target' : 'source';
    const edges = checked(await db.from('custom_object_relationship').select(`${other}_record_id`)
      .eq('tenant_id', tenantId).eq('relationship_definition_id', definitionId)
      .eq(`${side}_record_id`, parentId).is('archived_at', null).order('id').limit(MAX_EDGES + 1));
    if ((edges || []).length > MAX_EDGES) { reasons[field.id] = 'relationship_scope_limit'; continue; }
    const ids = [...new Set((edges || []).map(edge => edge[`${other}_record_id`]).filter(Boolean))];
    if (!ids.length) { reasons[field.id] = 'relationship_value_unavailable'; continue; }
    let query = db.from(TABLES[related.kind]).select(related.kind === 'member' ? 'id,email,login_enabled,membership_paused' : 'id')
      .eq('tenant_id', tenantId).in('id', ids);
    if (related.kind === 'custom_object') query = query.eq('custom_object_id', related.custom_object_id).is('archived_at', null);
    const records = checked(await query);
    let eligible = (records || []).filter(row => related.kind !== 'member'
      || row.login_enabled !== false && row.membership_paused !== true && !/^deleted_.*@deleted\.local$/.test(row.email || ''));
    if (Array.isArray(field.options) && field.options.length) {
      const allowed = new Set(field.options.map(option => typeof option === 'object' ? option.value ?? option.id : option));
      eligible = eligible.filter(row => allowed.has(row.id));
    }
    const selected = eligible.map(row => row.id).sort();
    if (!selected.length) reasons[field.id] = 'relationship_value_unavailable';
    else if (isRelationshipMultiSelect(field)) values[field.id] = selected;
    else if (selected.length === 1) values[field.id] = selected[0];
    else reasons[field.id] = 'relationship_ambiguous';
    if (Object.hasOwn(values, field.id)) delete reasons[field.id];
  }
  return { values, reasons };
}