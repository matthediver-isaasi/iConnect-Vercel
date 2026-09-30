// Explicitly approved existing bank; never a generic AccountID fallback.
export const BNMS_BETA_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const BNMS_BETA_BATCH = 'aaeb5efa50de77db5b6213c23d32a71ae0aa19d88484f1afd911f49fa44739c2';
export const BNMS_BETA_REVENUE = Object.freeze({
  '01625a3e-7e11-4815-9260-b7fbd892d3ef': '201',
  '99d2da94-5b35-444b-b8f0-55851ef343fd': '200',
  '1ea77248-91d3-4e71-b101-6fd330a0c516': '201',
  '001c4956-5400-40df-8d35-df201f5b7f85': '201',
  '00a4b763-f0e9-40b9-b45d-4360799d6d7c': '200',
  '87d784a4-6010-438b-bdbe-fd3b537eaab4': '200',
  '6a094fb6-a5be-4aa8-9cb4-9edccae1e547': '201',
  '01c58921-573b-4aa4-93af-525ce9449e75': '200',
  '6ba9cd22-d08b-4388-91db-c252c5d85ee2': '200',
  '006e7cc3-9528-4061-b65c-72315bef9e50': '201',
});
export const BNMS_BETA_BANK = Object.freeze({
  version: 1, provider: 'xero',
  xero_tenant_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23',
  bank_account_id: 'd115eacc-1fa7-476d-844e-d3d7f07f5db5',
  source: 'bnms_beta_approved_existing_bank',
  batch_hash: BNMS_BETA_BATCH,
});
export function betaAccountingMapping(memberId) {
  const revenue = Object.hasOwn(BNMS_BETA_REVENUE, memberId) ? BNMS_BETA_REVENUE[memberId] : null;
  if (!revenue) throw new Error('Member outside approved beta accounting scope');
  return { ...BNMS_BETA_BANK, revenue_account_code: revenue };
}
export function assertBnmsBetaAccountingContext(tenantId, context) {
  const expected = betaAccountingMapping(context?.memberId);
  if (tenantId !== BNMS_BETA_TENANT || context?.environment !== 'live' || context?.provider !== 'gocardless'
    || !context.snapshot || Object.keys(context.snapshot).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => context.snapshot[key] !== value)) {
    throw new Error('Invalid pinned BNMS beta accounting context');
  }
  return expected;
}
export async function resolveBetaAccountingContext(agreement, db) {
  if (agreement.tenant_id !== BNMS_BETA_TENANT || !Object.hasOwn(BNMS_BETA_REVENUE, agreement.member_id)) return null;
  const read = async (query) => {
    const { data, error } = await query.maybeSingle();
    if (error || !data) throw new Error('Approved beta accounting requires immutable adoption and release');
    return data;
  };
  const a = await read(db.from('bnms_dd_beta_adoption').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).eq('agreement_id', agreement.id));
  const batch = await read(db.from('bnms_dd_beta_batch').select('evidence_sha256')
    .eq('id', a.batch_id).eq('tenant_id', agreement.tenant_id));
  const r = await read(db.from('bnms_dd_beta_release').select('*')
    .eq('adoption_id', a.id).eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).eq('plan_id', a.plan_id));
  const context = { memberId: agreement.member_id, environment: agreement.environment,
    provider: agreement.provider, snapshot: r.evidence?.accounting?.mapping };
  const mapping = assertBnmsBetaAccountingContext(agreement.tenant_id, context);
  if (batch.evidence_sha256 !== BNMS_BETA_BATCH || a.mandate_id !== agreement.gocardless_mandate_id
    || a.customer_id !== agreement.gocardless_customer_id
    || r.evidence?.adoptionId !== a.id || r.evidence?.agreementId !== agreement.id
    || r.evidence?.memberId !== agreement.member_id || r.evidence?.planId !== a.plan_id
    || r.evidence?.accounting?.bankAccountId !== mapping.bank_account_id
    || r.evidence?.accounting?.xeroTenantId !== mapping.xero_tenant_id
    || r.evidence?.accounting?.revenueCode !== mapping.revenue_account_code) {
    throw new Error('Beta release accounting ownership/mapping mismatch');
  }
  return context;
}