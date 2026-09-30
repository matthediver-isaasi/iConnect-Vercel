export const BNMS_PILOT_ACCOUNTING = Object.freeze({
  version: 1, provider: 'xero',
  xero_tenant_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23',
  bank_account_id: 'd115eacc-1fa7-476d-844e-d3d7f07f5db5',
  revenue_account_code: '200', source: 'bnms_pilot_existing_payment_evidence',
});
export function assertBnmsPilotAccountingContext(appTenantId, context) {
  const mapping = context?.snapshot;
  if (appTenantId !== 'ff2df806-b321-4254-b651-3af11fccf1db'
    || context?.memberId !== '33e5d54d-162e-436d-9bff-ec6676d198f9'
    || context?.environment !== 'live' || context?.provider !== 'gocardless'
    || !mapping || Object.keys(mapping).length !== Object.keys(BNMS_PILOT_ACCOUNTING).length
    || Object.entries(BNMS_PILOT_ACCOUNTING).some(([key, value]) => mapping[key] !== value)) {
    throw new Error('Invalid pinned BNMS pilot accounting migration context');
  }
  return BNMS_PILOT_ACCOUNTING;
}