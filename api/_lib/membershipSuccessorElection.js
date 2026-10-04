/**
 * An unresolved external outcome never expires automatically. Retrying adopts
 * the original quote; changing method requires explicit provider reconciliation.
 */
export async function membershipSuccessorElectionsEnabled(db) {
  const { data, error } = await db.rpc('membership_successor_elections_enabled');
  if (error && ['PGRST202', '42883'].includes(error.code)) return false;
  if (error) throw new Error(`Could not verify successor reservation schema: ${error.message}`);
  return data === true;
}

export async function reserveMembershipSuccessor(db, {
  tenantId, memberId = null, organizationId = null, predecessorId, start, end,
  paymentMethod, origin = 'form', quote,
}) {
  const { data, error } = await db.rpc('reserve_membership_successor', {
    p_tenant_id: tenantId, p_member_id: memberId, p_organization_id: organizationId,
    p_previous_term_id: predecessorId, p_start: start, p_end: end,
    p_payment_method: paymentMethod, p_origin: origin, p_quote: quote,
  });
  if (error || !data?.id) throw new Error(`Next-term reservation unavailable: ${error?.message || 'missing reservation'}`);
  return data;
}

export async function reserveWorkerSuccessor(db, { tenantId, memberId, organizationId, previousAgreement, provider, snapshot, termEnd }) {
  if (!await membershipSuccessorElectionsEnabled(db)) return null;
  const { data: previous, error } = await db.from(organizationId ? 'organisation_membership_history' : 'member_membership_history')
    .select('*').eq('tenant_id', tenantId).eq(organizationId ? 'organization_id' : 'member_id', organizationId || memberId)
    .eq('billing_agreement_id', previousAgreement.id).maybeSingle();
  if (error || !previous) throw new Error('The renewal worker cannot verify its predecessor term');
  if (!previous.term_start_date || !previous.term_end_date) {
    // Preserve the existing legacy continuation authority. Forms cannot elect
    // against undated predecessors, so do not invent dates to enrol them.
    const { data: election, error: electionError } = await db.from('membership_successor_election')
      .select('id').eq('tenant_id', tenantId).eq('previous_term_id', previous.id)
      .eq('status', 'reserved').maybeSingle();
    if (electionError || election) throw new Error('Legacy renewal conflicts with a successor reservation; review required');
    return null;
  }
  const start = new Date(`${previous.term_end_date}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  const end = snapshot.commitment?.term_end_date || termEnd;
  if (!end) throw new Error('The renewal worker requires authoritative successor dates');
  return reserveMembershipSuccessor(db, {
    tenantId, memberId: organizationId ? null : memberId, organizationId: organizationId || null,
    predecessorId: previous.id, start: start.toISOString().slice(0, 10), end,
    paymentMethod: provider === 'stripe' ? 'monthly_card' : 'direct_debit', origin: 'worker',
    quote: { snapshot },
  });
}