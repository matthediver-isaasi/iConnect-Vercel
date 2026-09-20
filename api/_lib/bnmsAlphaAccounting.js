// Alpha has no batch table. Its append-only adoption rows pin the reviewed
// manifest and complete per-member economic evidence. Only this resolver can
// mint an accounting context: a caller-provided AccountID is never authority.
export const BNMS_ALPHA_TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const BNMS_ALPHA_MANIFEST = '3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a';
export const BNMS_ALPHA_PROCESSING_NOT_BEFORE = '2026-09-30T23:00:00Z';
export const BNMS_ALPHA_BANK = Object.freeze({
  version: 1, provider: 'xero',
  xero_tenant_id: '3d57dce6-2205-462f-abf6-9c7cbf00be23',
  bank_account_id: 'd115eacc-1fa7-476d-844e-d3d7f07f5db5',
  source: 'bnms_alpha_approved_existing_bank',
  manifest_sha256: BNMS_ALPHA_MANIFEST,
});
const contexts = new WeakSet();
const revenueByClass = Object.freeze({
  Full: '200', 'Full with NMC': '200',
  'Full junior': '201', 'Full junior with NMC': '201',
});

// Pure mapping builder for release tooling; this alone cannot authorize runtime
// posting. The immutable adoption and release must also resolve successfully.
export function alphaAccountingMapping(revenueCode) {
  if (!['200', '201'].includes(revenueCode)) throw new Error('Unapproved alpha revenue code');
  return { ...BNMS_ALPHA_BANK, revenue_account_code: revenueCode };
}

export function assertBnmsAlphaAccountingContext(tenantId, context) {
  if (tenantId !== BNMS_ALPHA_TENANT || !contexts.has(context)
    || context.environment !== 'live' || context.provider !== 'gocardless') {
    throw new Error('Invalid pinned BNMS alpha accounting context');
  }
  return context.snapshot;
}

export async function findAlphaAdoption(agreement, db) {
  if (agreement.tenant_id !== BNMS_ALPHA_TENANT) return null;
  // Query by member, not agreement: replacing a canonical agreement cannot
  // silently move an adopted member onto generic accounting/collection paths.
  const { data, error } = await db.from('bnms_dd_alpha_adoption').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).maybeSingle();
  if (error) throw new Error(`Load immutable alpha adoption: ${error.message}`);
  if (!data) {
    if (agreement.metadata?.bnms_alpha_held || agreement.metadata?.bnms_alpha_adoption) {
      throw new Error('Alpha accounting requires immutable adoption');
    }
    return null;
  }
  if (data.manifest_sha256 !== BNMS_ALPHA_MANIFEST || data.tenant_id !== agreement.tenant_id
    || data.member_id !== agreement.member_id || data.agreement_id !== agreement.id
    || data.mandate_id !== agreement.gocardless_mandate_id
    || data.customer_id !== agreement.gocardless_customer_id) {
    throw new Error('Alpha adoption ownership/manifest mismatch');
  }
  return data;
}

export async function resolveAlphaAccountingContext(agreement, db) {
  const a = await findAlphaAdoption(agreement, db);
  if (!a) return null;
  const { data: r, error } = await db.from('bnms_dd_alpha_release').select('*')
    .eq('adoption_id', a.id).eq('tenant_id', agreement.tenant_id)
    .eq('member_id', agreement.member_id).eq('plan_id', a.plan_id).maybeSingle();
  if (error || !r) throw new Error('Approved alpha accounting requires immutable adoption and release');
  const member = a.evidence;
  const revenue = revenueByClass[member?.structure?.structure_match_value];
  const mapping = alphaAccountingMapping(revenue);
  const e = r.evidence, actual = e?.accounting?.mapping;
  const lines = member?.links?.flatMap(link => link.evidence?.invoice?.LineItems || []);
  const links = member?.links || [];
  const contactId = e?.accounting?.contactId;
  const contactEmail = links[0]?.evidence?.contact?.EmailAddress?.trim().toLowerCase();
  if (!contactId || !contactEmail || !links.length || links.some(link =>
    link.xero_contact_id !== contactId || link.member_id !== agreement.member_id
    || link.tenant_id !== agreement.tenant_id || link.xero_tenant_id !== mapping.xero_tenant_id
    || link.evidence?.contact?.ContactID !== contactId
    || link.evidence?.invoice?.Contact?.ContactID !== contactId
    || link.evidence?.contact?.EmailAddress?.trim().toLowerCase() !== contactEmail)) {
    throw new Error('Alpha immutable Xero contact ownership mismatch');
  }
  if (member?.ids?.adoption !== a.id || member?.ids?.agreement !== agreement.id
    || member?.ids?.plan !== a.plan_id || member?.identity?.memberId !== agreement.member_id
    // Historical invoices remain historical: three approved junior imports
    // previously used 200. The immutable *current* class pins new revenue;
    // do not rewrite old invoices or force their former class onto new charges.
    || !lines?.length || lines.some(line => !['200', '201'].includes(line.AccountCode)
      || line.TaxType !== 'ZERORATEDOUTPUT' || Number(line.TaxAmount || 0) !== 0)
    || !actual || Object.keys(actual).length !== Object.keys(mapping).length
    || Object.entries(mapping).some(([key, value]) => actual[key] !== value)
    || Date.parse(r.processing_not_before) !== Date.parse(BNMS_ALPHA_PROCESSING_NOT_BEFORE)
    || e?.adoptionId !== a.id || e?.agreementId !== agreement.id
    || e?.memberId !== agreement.member_id || e?.planId !== a.plan_id
    || e?.accounting?.bankAccountId !== mapping.bank_account_id
    || e?.accounting?.xeroTenantId !== mapping.xero_tenant_id
    || e?.accounting?.revenueCode !== revenue) {
    throw new Error('Alpha release accounting ownership/mapping mismatch');
  }
  const context = Object.freeze({ memberId: agreement.member_id,
    contactId, contactEmail,
    planId: a.plan_id, agreementId: agreement.id,
    environment: agreement.environment, provider: agreement.provider,
    snapshot: Object.freeze(mapping) });
  contexts.add(context);
  assertBnmsAlphaAccountingContext(agreement.tenant_id, context);
  return context;
}