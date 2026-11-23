// In-process handler verification with real destination reads and explicit test
// authentication. This is not a signed-in browser session or an auth bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MEMBER, TENANT, TARGET, ORIGINAL, assertRecord } from './lib/bnms-membership-5734-plan.mjs';

assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, 'lvmzliemqnieeoruhkik.supabase.co');
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const auth = await getValidXeroAccessToken(TENANT);
assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
const { supabase: db } = await import('../api/_lib/database.js');
const { createMemberMembershipHandler } = await import('../api/membership/member-membership.js');
const { createMembershipInvoiceHandler } = await import('../api/membership-invoice/[recordId].js');
const { loadFormMembershipRenewalContext } = await import('../api/_lib/formMembershipRenewalContext.js');
const { createMembershipSimulator } = await import('../api/_lib/membershipSimulationCore.js');
const { normalizeAnnualRenewalConfig } = await import('../api/_lib/annualRenewalPolicy.js');
const dir = 'generated-artifacts/bnms-membership-5734';
const manifest = JSON.parse(fs.readFileSync(`${dir}/approved-dry-run.json`));
const getContext = async () => ({ tenantId: TENANT, isAuthenticated: true, tenantUserId: 'offline-verification-principal' });
function response() {
  return { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
  };
}
// Refuse any financial/database mutation from the application handlers.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  // PDF retrieval uses the shared quota lease. These two operational RPCs
  // neither modify membership data nor perform provider financial writes.
  const allowedRpc = url.hostname === 'lvmzliemqnieeoruhkik.supabase.co'
    && ['/rest/v1/rpc/membership_successor_elections_enabled',
      '/rest/v1/rpc/xero_rate_reserve', '/rest/v1/rpc/xero_rate_finish'].includes(url.pathname);
  assert.ok(['GET', 'HEAD'].includes(method) || (method === 'POST' && allowedRpc),
    `Verification forbids ${method} ${url.pathname}`);
  return originalFetch(input, init);
};
try {
  const memberHandler = createMemberMembershipHandler({ db, getTenantContext: getContext,
    getSessionMember: async () => null, hasAdminAccess: async () => true });
  const membershipResponse = response();
  await memberHandler({ method: 'GET', query: { memberId: MEMBER } }, membershipResponse);
  assert.equal(membershipResponse.statusCode, 200, 'Membership API must succeed');
  const payload = membershipResponse.body;
  const current = payload.history.find(h => h.id === TARGET);
  assertRecord(current, manifest.record);
  assert.ok(payload.history.some(h => h.id === ORIGINAL));
  assert.equal(current.linked_structure_name, manifest.record.commitment_snapshot.structure_name);
  const currentCommitment = payload.currentCommitments.find(c => c.id === TARGET);
  assert.ok(currentCommitment);
  assert.equal(currentCommitment.lifecycle, 'current');
  assert.equal(currentCommitment.startDate, '2026-10-06');
  assert.equal(currentCommitment.endDate, '2027-10-05');
  assert.equal(currentCommitment.agreedPrice, 156);
  assert.equal(payload.currentYearCost.finalCost, 156);
  assert.equal(payload.currentYearCost.endDate, '2027-10-05');
  const invoiceHandler = createMembershipInvoiceHandler({ db, getTenantContext: getContext,
    getSessionMember: async () => null, hasAdminAccess: async () => true });
  const downloads = [];
  for (const inline of ['true', 'false']) {
    const invoiceResponse = response();
    await invoiceHandler({ method: 'GET', query: { recordId: TARGET, source: 'personal', inline } }, invoiceResponse);
    assert.equal(invoiceResponse.statusCode, 200);
    assert.equal(invoiceResponse.headers['content-type'], 'application/pdf');
    assert.equal(invoiceResponse.body.subarray(0, 5).toString(), '%PDF-');
    assert.match(invoiceResponse.headers['content-disposition'], /membership-invoice-300005516\.pdf/);
    assert.ok(invoiceResponse.headers['content-disposition'].startsWith(inline === 'true' ? 'inline;' : 'attachment;'));
    downloads.push({ inline, bytes: invoiceResponse.body.length });
  }
  const simulator = createMembershipSimulator(db);
  const context = await loadFormMembershipRenewalContext(db, {
    tenantId: TENANT, memberId: MEMBER, simulate: simulator.simulateMembershipForMember,
  });
  assert.equal(context.renewal.eligible, false, 'Repair must not enable a future purchase');
  assert.equal(context.simulation, null);
  const policy = normalizeAnnualRenewalConfig(current.commitment_snapshot.config);
  assert.equal(policy.changeRole, false);
  assert.equal(policy.disableLogin, false);
  fs.writeFileSync(`${dir}/verification.json`, JSON.stringify({ at: new Date().toISOString(),
    payload, context, downloads, futureAccessActions: { changeRole: false, disableLogin: false } }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ membershipApi: 200, currentHistoryId: current.id,
    structure: current.linked_structure_name, amount: current.total_with_vat,
    start: current.term_start_date, end: current.term_end_date, downloads, renewal: context.renewal,
    futureAccessActions: { changeRole: false, disableLogin: false }, signedInBrowserVerified: false }));
} finally { globalThis.fetch = originalFetch; }
