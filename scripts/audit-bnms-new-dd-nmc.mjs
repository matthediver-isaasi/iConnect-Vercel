// Read-only audit of the two Existing DD dates proposal cases. No mutation mode.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
import { NMC_TENANT, NMC_FIELDS, projectNmcReport } from '../api/_lib/nmcMembershipReport.js';
import { MEMBERSHIP_RECOGNITION_TABLES } from '../api/_lib/alphaMembershipRecognition.js';
import { createClient } from '@supabase/supabase-js';

assert.equal(process.argv.length, 2);
const proposal = JSON.parse(fs.readFileSync('generated-artifacts/bnms-nmc-25-evidence/proposal.json'));
const cases = Object.values(proposal).find(v => Array.isArray(v) && v.some(r => r.category?.startsWith('Existing DD dates')));
const cohort = cases.filter(r => r.category === 'Existing DD dates: reconcile activation/collection, not term dates');
assert.equal(cohort.length, 2);
const ids = cohort.map(r => r.memberId);
assert.deepEqual([...ids].sort(), ['8f562891-d55c-4ea8-b774-e274feeabc8e', '9f0b38cd-b81d-4f61-be61-d80f5f1d3306']);
const db = await connectDestination();
const evidence = { capturedAt: new Date().toISOString(), database: 'production DEST', writes: 0, migrations: 0 };
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='60s'");
  const read = async (sql, params = [NMC_TENANT, ids]) => (await db.query(sql, params)).rows.map(r => r.row);
  assert.equal((await db.query('SELECT name FROM tenant WHERE id=$1', [NMC_TENANT])).rows[0]?.name, 'BNMS');
  evidence.members = await read('SELECT to_jsonb(t) row FROM member t WHERE tenant_id=$1 AND id=ANY($2::uuid[])');
  assert.equal(evidence.members.length, 2);
  for (const [key, table] of Object.entries({ history: 'member_membership_history', agreements: 'membership_billing_agreements', plans: 'membership_payment_plans' })) {
    evidence[key] = await read(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 AND member_id=ANY($2::uuid[])`);
  }
  for (const c of cohort) {
    const agreement = evidence.agreements.filter(a => a.member_id === c.memberId);
    assert.equal(agreement.length, 1);
    assert.equal(agreement[0].environment, 'live');
    assert.equal(agreement[0].metadata.dd.membership_year_start, c.proposedStart);
    assert.equal(agreement[0].metadata.dd.membership_year_end, c.proposedEnd);
    const history = evidence.history.filter(h => h.billing_agreement_id === agreement[0].id && h.member_id === c.memberId);
    assert.equal(history.length, 1);
    assert.equal(history[0].term_start_date, c.proposedStart);
    assert.equal(history[0].term_end_date, c.proposedEnd);
  }
  const mandateIds = [...new Set(evidence.agreements.map(a => a.gocardless_mandate_id).filter(Boolean))];
  for (const table of ['gocardless_mandates', 'gocardless_payments']) {
    evidence[table] = await read(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 AND gocardless_mandate_id=ANY($2::text[])`, [NMC_TENANT, mandateIds]);
  }
  evidence.webhooks = await read(`SELECT to_jsonb(t) row FROM payment_webhook_events t
    WHERE provider='gocardless' AND (payload->'links'->>'mandate'=ANY($1::text[])
    OR payload->'links'->>'payment'=ANY($2::text[]))`, [mandateIds, evidence.gocardless_payments.map(p => p.gocardless_payment_id)]);
  evidence.fields = await read('SELECT to_jsonb(t) row FROM preference_field t WHERE tenant_id=$1 AND name=ANY($2::text[]) AND entity_scope=$3 AND is_active', [NMC_TENANT, NMC_FIELDS, 'member']);
  evidence.preferences = await read('SELECT to_jsonb(t) row FROM member_preference_value t WHERE member_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])', [ids, evidence.fields.map(f => f.id)]);
  evidence.organizations = await read('SELECT to_jsonb(t) row FROM organization t WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [NMC_TENANT, evidence.members.map(m => m.organization_id).filter(Boolean)]);
  evidence.recognitions = [];
  for (const table of MEMBERSHIP_RECOGNITION_TABLES) evidence.recognitions.push(...await read(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 AND history_id=ANY($2::uuid[])`, [NMC_TENANT, evidence.history.map(h => h.id)]));
  await db.query('ROLLBACK');
} finally { await db.end(); }

const rest = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
const { getTenantGocardlessCredentials } = await import('../api/_lib/gocardlessCredentials.js');
const credentials = await getTenantGocardlessCredentials(NMC_TENANT, { db: rest });
assert.equal(credentials.environment, 'live');
async function get(path) {
  const url = new URL(path, 'https://api.gocardless.com/');
  assert.equal(url.origin, 'https://api.gocardless.com');
  const response = await fetch(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${credentials.accessToken}`, 'GoCardless-Version': '2015-07-06' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Provider GET failed (${response.status})`);
  return response.json();
}
evidence.provider = [];
for (const agreement of evidence.agreements) {
  const id = agreement.gocardless_mandate_id;
  if (!id) { evidence.provider.push({ agreementId: agreement.id, noMandate: true }); continue; }
  const mandate = (await get(`/mandates/${encodeURIComponent(id)}`)).mandates;
  assert.equal(mandate.id, id);
  const payments = [], events = [];
  for (const resource of ['payments', 'events']) {
    let after;
    do {
      const query = new URLSearchParams({ mandate: id, limit: '500', ...(after ? { after } : {}) });
      const result = await get(`/${resource}?${query}`);
      assert.ok(Array.isArray(result[resource]) && result.meta?.cursors);
      (resource === 'payments' ? payments : events).push(...result[resource]);
      after = result.meta?.cursors?.after;
    } while (after);
  }
  for (const payment of payments) {
    assert.equal(payment.links.mandate, id);
    let after;
    do {
      const query = new URLSearchParams({ payment: payment.id, limit: '500', ...(after ? { after } : {}) });
      const result = await get(`/events?${query}`);
      assert.ok(Array.isArray(result.events) && result.meta?.cursors);
      events.push(...result.events);
      after = result.meta.cursors.after;
    } while (after);
  }
  evidence.provider.push({ agreementId: agreement.id, mandate, payments, events });
}
const reportDate = evidence.capturedAt.slice(0, 10);
evidence.report = projectNmcReport({ ...evidence, reportDate });
evidence.perMember = cohort.map(c => {
  const memberEvidence = { ...evidence, members: evidence.members.filter(m => m.id === c.memberId), reportDate };
  const actual = projectNmcReport(memberEvidence);
  // Projection only: this is NOT proof of payment and is never persisted.
  const hypothetical = projectNmcReport({ ...memberEvidence,
    history: evidence.history.map(h => h.member_id === c.memberId ? { ...h, status: 'active', payment_status: 'partial' } : h),
    agreements: evidence.agreements.map(a => a.member_id === c.memberId ? { ...a, status: 'active' } : a) });
  return { memberId: c.memberId, name: c.name, retainedStart: c.proposedStart, retainedEnd: c.proposedEnd, actual, hypotheticalAfterValidActivation: hypothetical };
});
const directory = 'generated-artifacts/bnms-new-dd-nmc';
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${directory}/audit.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({
  capturedAt: evidence.capturedAt, writes: 0,
  agreements: evidence.agreements.map(a => ({ id: a.id, status: a.status, activation_rule: a.metadata.dd.activation_rule })),
  history: evidence.history.map(h => ({ member_id: h.member_id, status: h.status, payment_status: h.payment_status, term_start_date: h.term_start_date, term_end_date: h.term_end_date })),
  localPayments: evidence.gocardless_payments.map(p => ({ id: p.gocardless_payment_id, status: p.status, charge_date: p.charge_date })),
  provider: evidence.provider.map(p => ({ agreementId: p.agreementId, mandateStatus: p.mandate?.status, payments: p.payments?.map(x => ({ id: x.id, status: x.status, charge_date: x.charge_date })), events: p.events?.map(e => ({ id: e.id, action: e.action, resource_type: e.resource_type, created_at: e.created_at })) })),
  webhooks: evidence.webhooks.map(e => ({ event_id: e.event_id, processing_status: e.processing_status, processed_at: e.processed_at })),
  report: evidence.perMember.map(r => ({ name: r.name, actualTotal: r.actual.total, reviewCounts: r.actual.reviewCounts,
    hypotheticalTotal: r.hypotheticalAfterValidActivation.total, hypotheticalSheets: r.hypotheticalAfterValidActivation.sheets }))
}, null, 2));
