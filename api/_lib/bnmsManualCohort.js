// Separate operator-attested cohort. Never changes Alpha/Beta/pilot scope.
export const MANUAL_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MANUAL_WORKBOOK = 'ddbc1a3d789e17ad78d507284b7823570e2f383fd5455f1e57a6a6e962f09d2a';
export const MANUAL_GATE = '2026-09-30T23:00:00Z';
export const MANUAL_RECOGNITION_FROM = '2026-09-24';
export const MANUAL_RECOGNITION_UNTIL = '2027-10-01';
export const MANUAL_ADOPTION = 'bnms_dd_manual_adoption';
export const MANUAL_RECOGNITION = 'bnms_dd_manual_membership_recognition';
export const MANUAL_BANK_SOURCE = 'bnms_manual_95_existing_bank';
const contexts = new WeakSet();
export const isMissingManualTable = error => ['42P01', 'PGRST205'].includes(error?.code);

export function isManualRecognition(row) {
  return row?.provenance === 'bnms_manual_95'
    && row.workbook_sha256 === MANUAL_WORKBOOK
    && row.effective_from === MANUAL_RECOGNITION_FROM
    && row.effective_until === MANUAL_RECOGNITION_UNTIL;
}

export async function findManualAdoption(agreement, db) {
  if (agreement?.tenant_id !== MANUAL_TENANT || !agreement.member_id) return null;
  const { data, error } = await db.from(MANUAL_ADOPTION).select('*')
    .eq('tenant_id', MANUAL_TENANT).eq('member_id', agreement.member_id).maybeSingle();
  if (error && !(isMissingManualTable(error) && !agreement.metadata?.bnms_manual_cohort)) {
    throw new Error('Unable to load manual cohort provenance', { cause: error });
  }
  if (!data) {
    if (agreement.metadata?.bnms_manual_cohort) throw new Error('Manual cohort canonical adoption missing');
    return null;
  }
  if (data.workbook_sha256 !== MANUAL_WORKBOOK || data.tenant_id !== agreement.tenant_id
    || data.member_id !== agreement.member_id || data.agreement_id !== agreement.id
    || data.mandate_id !== agreement.gocardless_mandate_id
    || data.customer_id !== agreement.gocardless_customer_id) {
    throw new Error('Manual cohort canonical ownership mismatch');
  }
  return data;
}

export async function resolveManualAccountingContext(agreement, db) {
  const adoption = await findManualAdoption(agreement, db);
  if (!adoption) return null;
  const { data: release, error } = await db.from('bnms_dd_manual_release').select('*')
    .eq('tenant_id', MANUAL_TENANT).eq('adoption_id', adoption.id).maybeSingle();
  const accounting = adoption.evidence?.accounting;
  if (error || !release || release.manifest_sha256 !== adoption.manifest_sha256
    || release.plan_id !== adoption.plan_id || release.member_id !== adoption.member_id
    || Date.parse(release.processing_not_before) !== Date.parse(MANUAL_GATE)
    || !accounting?.contactId || !accounting.contactEmail
    || accounting.bankAccountId !== 'd115eacc-1fa7-476d-844e-d3d7f07f5db5'
    || accounting.xeroTenantId !== '3d57dce6-2205-462f-abf6-9c7cbf00be23'
    || !/^\d+$/.test(accounting.revenueCode || '')) {
    throw new Error('Manual cohort reviewed release/accounting evidence incomplete');
  }
  const context = Object.freeze({
    memberId: adoption.member_id, planId: adoption.plan_id, agreementId: adoption.agreement_id,
    contactId: accounting.contactId, contactEmail: accounting.contactEmail,
    environment: agreement.environment, provider: agreement.provider,
    snapshot: Object.freeze({
      version: 1, provider: 'xero', source: MANUAL_BANK_SOURCE,
      xero_tenant_id: accounting.xeroTenantId, bank_account_id: accounting.bankAccountId,
      revenue_account_code: accounting.revenueCode, workbook_sha256: MANUAL_WORKBOOK,
    }),
  });
  contexts.add(context);
  assertManualAccountingContext(agreement.tenant_id, context);
  return context;
}

export function assertManualAccountingContext(tenantId, context) {
  if (tenantId !== MANUAL_TENANT || !contexts.has(context)
    || context.environment !== 'live' || context.provider !== 'gocardless') {
    throw new Error('Untrusted manual cohort accounting context');
  }
  return context.snapshot;
}