/**
 * Existing individual membership evidence outranks CRM organisation affiliation.
 * Do not filter by status: cancelled/paused/uncertain evidence must still go
 * through the individual renewal eligibility checks, not switch owner.
 */
export async function resolveFormMembershipOrganizationId(db, tenantId, member) {
  if (!tenantId || member?.tenant_id !== tenantId || !member?.id) {
    throw new Error('Membership owner tenant could not be verified');
  }
  if (!member.organization_id) return null;
  for (const table of ['member_membership_history', 'membership_billing_agreements']) {
    let query = db.from(table).select('id')
      .eq('tenant_id', tenantId).eq('member_id', member.id);
    if (table === 'membership_billing_agreements') query = query.is('organization_id', null);
    const { data, error } = await query.limit(1);
    if (error || !Array.isArray(data)) throw new Error('Membership ownership could not be verified');
    if (data.length) return null;
  }
  // Preserve the established organisation route when there is no individual
  // membership evidence. Affiliation alone must never override a personal term.
  return member.organization_id;
}
