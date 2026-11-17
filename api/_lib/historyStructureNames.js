// Display-only enrichment: never replace purchased snapshots or financial data.
export async function attachLinkedHistoryStructureNames(db, tenantId, records = []) {
  const ids = [...new Set(records.filter(r => r.tenant_id === tenantId && r.config_id).map(r => r.config_id))];
  for (const record of records) delete record.linked_structure_name;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const { data, error } = await db.from('membership_tier_config')
      .select('id,tenant_id,name').eq('tenant_id', tenantId).in('id', chunk);
    if (error) throw new Error('Could not load linked membership structure names');
    const names = new Map((data || []).filter(c => c.tenant_id === tenantId && chunk.includes(c.id)).map(c => [c.id, c.name]));
    for (const record of records) {
      if (record.tenant_id === tenantId && names.has(record.config_id)) {
        record.linked_structure_name = names.get(record.config_id);
      }
    }
  }
}
