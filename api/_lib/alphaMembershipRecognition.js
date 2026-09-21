// Administrative membership recognition is NOT settlement, collection release,
// a contract amendment, a joining date, or permission to create a payment.
export const ALPHA_RECOGNITION_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export function currentMembershipRecognition(record, today = new Date().toISOString().slice(0, 10)) {
  const recognition = record?.membershipRecognition;
  if (!recognition || record.membership_source === 'organisation'
      || ['cancelled', 'canceled', 'expired', 'paused', 'failed', 'activation_failed'].includes(record.status)
      || recognition.revoked_at || recognition.tenant_id !== record.tenant_id
      || recognition.member_id !== record.member_id || recognition.history_id !== record.id
      || recognition.agreement_id !== record.billing_agreement_id
      || recognition.tenant_id !== ALPHA_RECOGNITION_TENANT
      || recognition.effective_from !== '2026-09-21'
      || recognition.effective_until !== '2027-10-01'
      || today < recognition.effective_from || today >= recognition.effective_until) return null;
  return recognition;
}

export async function attachAlphaMembershipRecognition(db, tenantId, memberId, records, today) {
  if (tenantId !== ALPHA_RECOGNITION_TENANT || !records.length) return records;
  const { data, error } = await db.from('bnms_dd_alpha_membership_recognition')
    .select('tenant_id,member_id,history_id,agreement_id,effective_from,effective_until,revoked_at')
    .eq('tenant_id', tenantId).eq('member_id', memberId);
  // During schema-first/rolling deployment an absent new relation means no
  // recognition, never inferred current access. All other failures are explicit.
  if (['42P01', 'PGRST205'].includes(error?.code)) return records;
  if (error) throw new Error('Unable to load administrative membership recognition', { cause: error });
  for (const row of data || []) {
    if (row.tenant_id !== tenantId || row.member_id !== memberId) {
      throw new Error('Membership recognition ownership mismatch');
    }
    const record = records.find(item => item.id === row.history_id && item.membership_source !== 'organisation');
    if (!record) continue;
    const candidate = { ...record, membershipRecognition: row };
    const recognition = currentMembershipRecognition(candidate, today);
    if (recognition) record.membershipRecognition = recognition;
  }
  return records;
}