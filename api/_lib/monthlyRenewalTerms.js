// Read-only term primitives. Keep this module independent of provider clients,
// database singletons and renewal execution helpers.
import { calculateMembershipYearWindow } from './membershipYear.js';

export async function getPausedMemberIdSet(tenantId, db, memberIds = null) {
  if (!db || !tenantId) return new Set();
  const ids = new Set();
  let afterId = null;
  while (true) {
    let query = db.from('member').select('id')
      .eq('tenant_id', tenantId).eq('membership_paused', true)
      .order('id', { ascending: true }).limit(100);
    if (memberIds) query = query.in('id', memberIds);
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query;
    if (error) {
      if (['42703', '42P01'].includes(error.code)) return new Set();
      throw new Error(`Could not check paused memberships: ${error.message}`);
    }
    if (!data?.length) return ids;
    for (const row of data) ids.add(row.id);
    afterId = data[data.length - 1].id;
  }
}

export function monthlySnapshotCommitment(snapshot) {
  return snapshot?.commitment?.term_key ? snapshot.commitment : null;
}

export function monthlyRenewalIdentity(snapshot) {
  const commitment = monthlySnapshotCommitment(snapshot);
  if (!commitment) return null;
  return commitment.commitment_snapshot?.start_mode === 'fixed_date'
    ? calculateMembershipYearWindow(commitment.commitment_snapshot.config, new Date(`${commitment.membership_renewal_date}T00:00:00.000Z`)).label
    : `rolling:${commitment.membership_renewal_date}`;
}

export async function assertTrustedMonthlyTerm(db, tenantId, snapshot) {
  if (monthlySnapshotCommitment(snapshot)) return;
  let immediate = snapshot?.start_mode === 'immediate';
  if (!snapshot?.start_mode && snapshot?.config_id) {
    const { data, error } = await db.from('membership_tier_config')
      .select('start_mode').eq('tenant_id', tenantId).eq('id', snapshot.config_id).maybeSingle();
    if (error) throw new Error(`Cannot verify legacy membership term: ${error.message}`);
    immediate = data?.start_mode === 'immediate';
  }
  if (immediate) throw new Error('Legacy rolling agreement has no reliable dated commitment; review is required before renewal or reminders.');
}