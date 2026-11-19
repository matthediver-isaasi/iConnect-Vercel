// Financial choices follow configured direct secondary affiliations, never
// department ownership or arbitrary graph reachability.
async function complete(db, table, tenantId, configure, maximum = 100) {
  const rows = [];
  for (let start = 0; start <= maximum;) {
    const result = await configure(db.from(table).select('*').eq('tenant_id', tenantId))
      .order('id').range(start, Math.min(start + 99, maximum));
    if (result.error || !Array.isArray(result.data)) throw new Error('Billing affiliations unavailable');
    if (!result.data.length) return rows;
    rows.push(...result.data);
    if (rows.length > maximum) throw new Error('Billing affiliation limit requires review');
    start += result.data.length;
  }
  throw new Error('Incomplete billing affiliations');
}
export async function billingOrganizationIds(db, tenantId, member) {
  const ids = new Set(member.organization_id ? [member.organization_id] : []);
  const policy = await db.from('profile_affiliation_policy').select('config').eq('tenant_id', tenantId).maybeSingle();
  if (policy.error) {
    if (['42P01','PGRST205'].includes(policy.error.code)) return [...ids];
    throw new Error('Billing affiliation policy unavailable');
  }
  const config = policy.data?.config;
  if (!config?.secondaryMemberDefinitionId && !config?.secondaryOrganizationDefinitionId) return [...ids];
  if (!config.secondaryMemberDefinitionId || !config.secondaryOrganizationDefinitionId) throw new Error('Incomplete billing affiliation policy');
  const definitions = await complete(db, 'custom_object_relationship_definition', tenantId,
    q => q.in('id', [config.secondaryMemberDefinitionId, config.secondaryOrganizationDefinitionId]).eq('status','active'), 2);
  const endpoint = (d, kind) => d?.source_kind === kind && d.target_kind === 'custom_object'
    ? { side:'source', object:d.target_custom_object_id } : d?.target_kind === kind && d.source_kind === 'custom_object'
      ? { side:'target', object:d.source_custom_object_id } : null;
  const md = definitions.find(d => d.id === config.secondaryMemberDefinitionId);
  const od = definitions.find(d => d.id === config.secondaryOrganizationDefinitionId);
  const me = endpoint(md,'member'), org = endpoint(od,'organization');
  if (!me || !org || me.object !== org.object) throw new Error('Invalid billing affiliation endpoints');
  const links = await complete(db,'custom_object_relationship',tenantId,q => q.eq('relationship_definition_id',md.id)
    .eq(`${me.side}_record_id`,member.id).is('archived_at',null));
  const opposite = me.side === 'source' ? 'target' : 'source';
  const assignmentIds = [...new Set(links.map(e => e[`${opposite}_record_id`]))];
  if (!assignmentIds.length) return [...ids];
  const live = await complete(db,'custom_object_record',tenantId,q => q.eq('custom_object_id',me.object)
    .in('id',assignmentIds).is('archived_at',null));
  if (!live.length) return [...ids];
  const side = org.side === 'source' ? 'target' : 'source';
  const owners = await complete(db,'custom_object_relationship',tenantId,q => q.eq('relationship_definition_id',od.id)
    .in(`${side}_record_id`,live.map(r=>r.id)).is('archived_at',null));
  for (const record of live) {
    const matches = owners.filter(e => e[`${side}_record_id`] === record.id);
    if (matches.length !== 1) throw new Error('Ambiguous billing affiliation');
    ids.add(matches[0][`${org.side}_record_id`]);
  }
  return [...ids];
}
