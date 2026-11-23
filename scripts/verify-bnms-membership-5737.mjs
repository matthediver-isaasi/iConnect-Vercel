// Actual read handlers with explicit in-process test authentication, not browser auth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MEMBER, TENANT } from './lib/bnms-membership-5734-plan.mjs';
import { ORIGINAL, TARGET, assertRecord } from './lib/bnms-membership-5737-plan.mjs';
const mode = process.argv[2];
assert.ok(['before', 'after'].includes(mode));
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, 'lvmzliemqnieeoruhkik.supabase.co');
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
assert.equal((await getValidXeroAccessToken(TENANT)).tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
const { supabase: db } = await import('../api/_lib/database.js');
const { createMemberMembershipHandler } = await import('../api/membership/member-membership.js');
const { createMembershipInvoiceHandler } = await import('../api/membership-invoice/[recordId].js');
const { loadFormMembershipRenewalContext } = await import('../api/_lib/formMembershipRenewalContext.js');
const { createMembershipSimulator } = await import('../api/_lib/membershipSimulationCore.js');
const dir = 'generated-artifacts/bnms-membership-5737';
const manifest = JSON.parse(fs.readFileSync(`${dir}/approved-dry-run.json`));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const rpc = url.hostname === 'lvmzliemqnieeoruhkik.supabase.co'
    && ['/rest/v1/rpc/membership_successor_elections_enabled', '/rest/v1/rpc/xero_rate_reserve', '/rest/v1/rpc/xero_rate_finish'].includes(url.pathname);
  assert.ok(['GET', 'HEAD'].includes(method) || method === 'POST' && rpc, 'Verification forbids mutations');
  return originalFetch(input, init);
};
function response() { return { statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(v) { this.body = v; return this; },
  send(v) { this.body = v; return this; } }; }
try {
  const deps = { db, getTenantContext: async () => ({ tenantId: TENANT, isAuthenticated: true, tenantUserId: 'offline-verification-principal' }),
    getSessionMember: async () => null, hasAdminAccess: async () => true };
  const r = response();
  await createMemberMembershipHandler(deps)({ method: 'GET', query: { memberId: MEMBER } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.history.length, 2);
  assertRecord(r.body.history.find(h => h.id === TARGET), manifest.current);
  assertRecord(r.body.history.find(h => h.id === ORIGINAL), mode === 'before' ? manifest.original : manifest.record);
  const context = await loadFormMembershipRenewalContext(db, { tenantId: TENANT, memberId: MEMBER,
    simulate: createMembershipSimulator(db).simulateMembershipForMember });
  const downloads = [];
  if (mode === 'after') {
    const before = JSON.parse(fs.readFileSync(`${dir}/handlers-before.json`));
    assert.deepEqual(context, before.context, 'Full renewal context changed');
    assert.deepEqual(r.body.currentCommitments, before.payload.currentCommitments);
    assert.deepEqual(r.body.currentYearCost, before.payload.currentYearCost);
    for (const [id, number] of [[ORIGINAL, '300004583'], [TARGET, '300005516']]) {
      for (const inline of ['true', 'false']) {
        const pdf = response();
        await createMembershipInvoiceHandler(deps)({ method: 'GET', query: { recordId: id, source: 'personal', inline } }, pdf);
        assert.equal(pdf.statusCode, 200); assert.equal(pdf.headers['content-type'], 'application/pdf');
        assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
        assert.ok(pdf.headers['content-disposition'].includes(`membership-invoice-${number}.pdf`));
        assert.ok(pdf.headers['content-disposition'].startsWith(inline === 'true' ? 'inline;' : 'attachment;'));
        downloads.push({ number, inline, bytes: pdf.body.length });
      }
    }
  }
  fs.writeFileSync(`${dir}/handlers-${mode}.json`, JSON.stringify({ payload: r.body, context, downloads }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ mode, membershipApi: 200, historyCount: 2, downloads,
    renewalContextUnchanged: mode === 'after', signedInBrowserVerified: false }));
} finally { globalThis.fetch = originalFetch; }
