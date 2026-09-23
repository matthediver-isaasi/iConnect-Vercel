export async function loadApprovedAddonLines(db, tenantId, organizationId, membershipYear) {
  const { data, error } = await db.from('organisation_membership_invoicing').select('addon_lines, fees_approved')
    .eq('tenant_id', tenantId).eq('organization_id', organizationId).eq('membership_year', membershipYear).maybeSingle();
  if (error) throw new Error(`Could not load membership addons: ${error.message}`);
  return data?.fees_approved && Array.isArray(data.addon_lines) ? data.addon_lines : [];
}
export function computeAddonTotals(lines) {
  let subtotal = 0, vat = 0;
  for (const line of lines || []) {
    const value = Number(line.line_total) || 0;
    subtotal += value;
    const rate = Number(line.vat_rate?.effectiveRate);
    if (Number.isFinite(rate) && rate > 0) vat += value * rate / 100;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  vat = Math.round(vat * 100) / 100;
  return { subtotal, vat, total: Math.round((subtotal + vat) * 100) / 100 };
}
export function buildAddonDisplayLines(lines) {
  return (lines || []).map(line => ({
    description: String(line.description || 'Add-on'), quantity: Number(line.quantity) || 1,
    unit_cost: Number(line.unit_cost) || 0, line_total: Number(line.line_total) || 0,
    vat_rate_percent: Number.isFinite(Number(line.vat_rate?.effectiveRate)) ? Number(line.vat_rate.effectiveRate) : null,
  }));
}
export async function readPausedOwners(db, tenantId, memberIds = null) {
  const ids = new Set();
  let after = null;
  for (;;) {
    let query = db.from('member').select('id').eq('tenant_id', tenantId).eq('membership_paused', true).order('id').limit(100);
    if (memberIds) query = query.in('id', memberIds);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) {
      if (['42703', '42P01'].includes(error.code)) return ids;
      throw new Error(`Could not read paused memberships: ${error.message}`);
    }
    if (!data?.length) return ids;
    data.forEach(row => ids.add(row.id));
    after = data.at(-1).id;
  }
}