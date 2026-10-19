import { normalizeDirectoryExpression, expressionFieldIds, matchesDirectoryExpression } from '../../shared/directoryExpression.js';
import { createHash } from 'node:crypto';

export async function canManageDirectoryConfiguration(context, { hasAdminAccess, hasFeatureAccess }) {
  if (!context?.isAuthenticated || context.tenantMismatch || !context.tenantId) return false;
  return Boolean(await hasAdminAccess(context) || (context.roleId
    && await hasFeatureAccess(context.roleId, 'page_DynamicDirectoryManagement', context.memberExcludedFeatures || [])));
}

export function directoryInclusionIdentity(directory) {
  return JSON.stringify([directory.entity_type, directory.filter_expression ?? null,
    directory.filter_field_id ?? null, directory.filter_value ?? null, directory.is_active, directory.allowed_role_ids]);
}

export function projectDirectoryInclusion(directory) {
  const { filter_expression, filter_value, ...publicDirectory } = directory;
  return { ...publicDirectory, inclusion_revision: createHash('sha256').update(directoryInclusionIdentity(directory)).digest('hex') };
}

export async function revalidateDirectoryInclusion(db, tenantId, directory, candidateIds) {
  const { data, error } = await db.from('dynamic_directory').select('*')
    .eq('tenant_id', tenantId).eq('id', directory.id).limit(1);
  if (error) throw new Error('Unable to revalidate directory inclusion');
  if (!data?.[0] || directoryInclusionIdentity(data[0]) !== directoryInclusionIdentity(directory)) return false;
  const eligible = await directoryEligibleIds(db, tenantId, data[0], candidateIds);
  return eligible === null || candidateIds.every(id => eligible.includes(id));
}

// Continue until an empty page, not a short page: PostgREST can cap responses.
export async function readDirectoryPages(factory) {
  const rows = [];
  for (let offset = 0; offset <= 100000;) {
    const { data, error } = await factory().range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error('Unable to read directory eligibility');
    if (!data.length) return rows;
    rows.push(...data);
    offset += data.length;
  }
  throw new Error('Directory eligibility inventory exceeds its safety limit');
}

export async function validateDirectoryConfiguration(db, tenantId, directory) {
  if (!['member', 'organization'].includes(directory.entity_type)) throw new Error('Invalid directory entity type');
  const expression = normalizeDirectoryExpression(directory);
  const ids = expressionFieldIds(expression);
  if (!ids.length) return expression;
  const fields = await readDirectoryPages(() => db.from('preference_field').select('id, tenant_id, entity_scope, is_active, field_type')
    .eq('tenant_id', tenantId).in('id', ids).order('id'));
  for (const id of ids) {
    const field = fields.find(field => field.id === id);
    if (!field || field.tenant_id !== tenantId || (field.entity_scope || 'member') !== directory.entity_type
      || field.is_active !== true || !['picklist', 'dropdown', 'boolean'].includes(field.field_type)) {
      throw new Error(`Inclusion field ${id} is unavailable. Remove it or select an active field for this directory type.`);
    }
  }
  return expression;
}

export async function directoryEligibleIds(db, tenantId, directory, candidateIds = null) {
  const expression = await validateDirectoryConfiguration(db, tenantId, directory);
  if (!expression) return candidateIds;
  const entity = directory.entity_type;
  const ids = candidateIds || (await readDirectoryPages(() => db.from(entity).select('id')
    .eq('tenant_id', tenantId).order('id'))).map(row => row.id);
  const fields = expressionFieldIds(expression);
  const eligible = [];
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100);
    // Values have no tenant column. Candidate IDs come from a tenant-scoped inventory.
    const values = await readDirectoryPages(() => db.from(`${entity}_preference_value`)
      .select(`${entity}_id, field_id, value`).in(`${entity}_id`, chunk).in('field_id', fields)
      .order('id'));
    const byEntity = new Map();
    for (const row of values) {
      const id = row[`${entity}_id`];
      if (!byEntity.has(id)) byEntity.set(id, new Map());
      const map = byEntity.get(id);
      map.set(row.field_id, [...(map.get(row.field_id) || []), row.value]);
    }
    for (const id of chunk) if (matchesDirectoryExpression(expression, byEntity.get(id) || new Map())) eligible.push(id);
  }
  return eligible;
}

// Expressions contain only positive equality leaves joined by AND/OR. An
// entity without any of the referenced values therefore cannot match. Start
// with those field-indexed rows instead of scanning every tenant entity and
// then issuing preference reads for every hundred IDs.
// Field ownership is verified before reading values (which have no tenant
// column); callers must still tenant-scope the final entity fetch.
export async function directoryMatchingCandidateIds(db, tenantId, directory) {
  const expression = await validateDirectoryConfiguration(db, tenantId, directory);
  if (!expression) return null;
  const entityKey = `${directory.entity_type}_id`;
  const fields = expressionFieldIds(expression);
  const values = await readDirectoryPages(() => db.from(`${directory.entity_type}_preference_value`)
    .select(`id, ${entityKey}, field_id, value`).in('field_id', fields).order('id'));
  const byEntity = new Map();
  for (const row of values) {
    if (!row[entityKey]) continue;
    if (!byEntity.has(row[entityKey])) byEntity.set(row[entityKey], new Map());
    const map = byEntity.get(row[entityKey]);
    map.set(row.field_id, [...(map.get(row.field_id) || []), row.value]);
  }
  return [...byEntity].filter(([, entries]) => matchesDirectoryExpression(expression, entries))
    .map(([id]) => id).sort();
}
