import { shapePersistedCommitments, findLegacyCurrentMembership } from '../membership/member-membership.js';
import { overviewTermExpiry } from '../../shared/membershipTermExpiry.js';

// Only returned members, in bounded batches, with deterministic history paging
// so PostgREST's row cap cannot silently remove competing current terms.
export async function loadMemberListTermExpiries(db, tenantId, memberIds, now = new Date()) {
  const result = new Map(memberIds.map(id => [id, null]));
  const ids = [...result.keys()];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const histories = new Map(batch.map(id => [id, []]));
    for (let start = 0; ; start += 500) {
      const { data, error } = await db.from('member_membership_history')
        .select('*').eq('tenant_id', tenantId).in('member_id', batch)
        .order('membership_year', { ascending: false }).order('id', { ascending: true })
        .range(start, start + 499);
      if (error || !Array.isArray(data)) {
        const failure = new Error('Failed to fetch member membership terms');
        failure.status = 500;
        throw failure;
      }
      for (const row of data) {
        if (row.tenant_id !== tenantId || !histories.has(row.member_id)) continue;
        histories.get(row.member_id).push({ ...row, membership_source: 'personal' });
      }
      if (data.length < 500) break;
    }
    for (const [id, history] of histories) {
      result.set(id, overviewTermExpiry({
        currentCommitments: shapePersistedCommitments(history, now),
        legacyCurrentMembership: findLegacyCurrentMembership(history, tenantId, now),
        history,
      }, now.toISOString().slice(0, 10)));
    }
  }
  return result;
}
