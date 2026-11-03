// Provider-only disposable fixtures. Hard sandbox boundary, no application
// member writes and no live operations. Public provider test banking data only.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getTenantGocardlessCredentials } from '../api/_lib/gocardlessCredentials.js';
import { createGocardlessClient, buildIdempotencyKey } from '../api/_lib/gocardless.js';

const root = new URL('../generated-artifacts/gocardless-handover/', import.meta.url);
const authorization = JSON.parse(await fs.readFile(new URL('authorization.json', root), 'utf8'));
assert.equal(authorization.environment, 'sandbox');
const dest = new URL(process.env.DEST_SUPABASE_URL);
assert.equal(dest.hostname, 'lvmzliemqnieeoruhkik.supabase.co');
const db = createClient(dest.href, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
const creds = await getTenantGocardlessCredentials(authorization.tenantId, { db });
assert.equal(creds.environment, 'sandbox');
assert.equal(creds.source, 'tenant');
assert.equal(creds.tenantId, authorization.tenantId);
const gc = createGocardlessClient(creds); // test fixtures only; no app collection authority
const evidencePath = new URL('provider-switch-evidence.json', root);
let evidence;
try { evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; evidence = { run: 'disposable-replacement-contract-v1', environment: 'sandbox', phases: {} }; }
const save = () => fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
async function create(kind, role, attributes) {
  const saved = evidence.phases[`${role}-${kind}`];
  if (saved) return saved;
  const response = await fetch(`https://api-sandbox.gocardless.com/${kind}`, {
    method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json',
      'GoCardless-Version': '2015-07-06', 'Idempotency-Key': buildIdempotencyKey(evidence.run, role, kind) },
    body: JSON.stringify({ [kind]: attributes }), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Sandbox ${kind}: HTTP ${response.status}; ${result.error?.type}; ${(result.error?.errors || []).map(e => e.reason).join(',')}`);
  // Store provider IDs only, never account details or token.
  const value = { id: result[kind].id };
  evidence.phases[`${role}-${kind}`] = value; await save(); return value;
}
for (const role of ['original', 'replacement']) {
  const customer = await create('customers', role, {
    given_name: 'Successful', family_name: 'Disposable Handover Test',
    email: `gocardless-handover-${role}@example.invalid`, address_line1: '1 Test Street',
    city: 'London', postal_code: 'SW1A 1AA', country_code: 'GB',
  });
  const bank = await create('customer_bank_accounts', role, {
    account_holder_name: 'Disposable Handover Test', account_number: '55779911',
    branch_code: '200000', country_code: 'GB', links: { customer: customer.id },
  });
  await create('mandates', role, {
    scheme: 'bacs', metadata: { test: evidence.run, role },
    links: { customer_bank_account: bank.id, ...(creds.creditorId ? { creditor: creds.creditorId } : {}) },
  });
}
const oldId = evidence.phases['original-mandates'].id;
const newId = evidence.phases['replacement-mandates'].id;
async function activeMandate(id) {
  let value = await gc.getMandate(id);
  if (value.status === 'pending_submission' && !evidence.completed) {
    const response = await fetch('https://api-sandbox.gocardless.com/scenario_simulators/mandate_activated/actions/run', {
      method: 'POST', headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json',
        'GoCardless-Version': '2015-07-06' }, body: JSON.stringify({ data: { links: { resource: id } } }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Sandbox activation simulator: HTTP ${response.status}`);
    value = await gc.getMandate(id);
  }
  return value;
}
const old = await activeMandate(oldId), candidate = await activeMandate(newId);
if (evidence.completed) {
  assert.equal(old.status, 'cancelled'); assert.equal(candidate.status, 'active');
  console.log('Previously completed sandbox switch verified read-only.'); process.exit(0);
}
assert.equal(old.status, 'active'); assert.equal(candidate.status, 'active');
const start = new Date(`${[old.next_possible_charge_date,candidate.next_possible_charge_date].sort().at(-1)}T12:00:00Z`);
start.setUTCMonth(start.getUTCMonth()+2); start.setUTCDate(15);
const startDate = start.toISOString().slice(0,10);
const oldSub = await gc.createSubscription({ mandateId: oldId, amountMinor: 100, currency: 'GBP',
  intervalUnit: 'monthly', dayOfMonth: 15, startDate, count: 2,
  metadata: { test: evidence.run }, idempotencyKey: buildIdempotencyKey(evidence.run,'original-subscription') });
evidence.oldSubscription = oldSub; await save();
assert.equal(oldSub.upcoming_payments.length, 2);
assert.deepEqual(await gc.listPayments({ mandateId: oldId }), []);
if (oldSub.status !== 'cancelled') await gc.cancelSubscription(oldSub.id);
assert.equal((await gc.getSubscription(oldSub.id)).status,'cancelled');
const successor = await gc.createSubscription({ mandateId: newId, amountMinor: 100, currency: 'GBP',
  intervalUnit: 'monthly', dayOfMonth: 15, startDate: oldSub.upcoming_payments[0].charge_date, count: 2,
  metadata: { test: evidence.run }, idempotencyKey: buildIdempotencyKey(evidence.run,'replacement-subscription') });
evidence.newSubscription = successor; await save();
assert.deepEqual(successor.upcoming_payments,oldSub.upcoming_payments);
assert.equal(successor.links.mandate,newId);
assert.deepEqual(await gc.listPayments({ mandateId: oldId }), []);
assert.deepEqual(await gc.listPayments({ mandateId: newId }), []);
await gc.cancelMandate(oldId);
assert.equal((await gc.getMandate(oldId)).status,'cancelled');
assert.equal((await gc.getMandate(newId)).status,'active');
assert.equal((await gc.getSubscription(successor.id)).status,'active');
evidence.completed = new Date().toISOString(); await save();
console.log('Sandbox switch verified: two unchanged future instalments, no created payments, old mandate cancelled, successor active.');
