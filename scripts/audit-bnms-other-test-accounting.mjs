// Read-only, DEST-pinned investigation. No OAuth refresh or provider mutations.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { connectDestination } from './annual-meeting-destination.mjs';
import { TENANT, XERO_TENANT } from './prepare-bnms-paid-invoice-renumber.mjs';

assert.equal(process.argv.length, 2, 'No apply mode or arguments supported');
const dir = 'generated-artifacts/bnms-other-test-accounting';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const save = (name, value) => fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2), { mode: 0o600 });
const excluded = new Set([...fs.readFileSync('scripts/cleanup-bnms-confirmed-stripe-tests.mjs', 'utf8')
  .matchAll(/'(INV-\d+)':/g)].map(m => m[1]));
assert.equal(excluded.size, 16);
const db = await connectDestination();
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
  assert.equal(options.method || (url instanceof Request ? url.method : 'GET'), 'GET', 'Only GET permitted');
  return originalFetch(url, options);
};
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='20s'");
  const read = async (sql, params = [TENANT]) => (await db.query(sql, params)).rows;
  const snapshot = {};
  // Exact count + bounded rows: overflow is a failure, never a partial audit.
  for (const table of ['membership_instalment_invoices', 'gocardless_payments']) {
    const count = Number((await read(`select count(*) n from ${table} where tenant_id=$1`))[0].n);
    assert(count <= 2000, 'Audit bound exceeded');
    snapshot[table] = await read(`select to_jsonb(i) row from ${table} i where tenant_id=$1 order by id limit 2001`);
    snapshot[table] = snapshot[table].map(x => x.row);
    assert.equal(snapshot[table].length, count);
  }
  snapshot.agreements = await read(`select id,member_id,provider,environment,status,created_at,
    stripe_subscription_id,stripe_checkout_session_id,billing_contact_name,billing_contact_email,
    metadata,commitment_snapshot from membership_billing_agreements where tenant_id=$1 order by id limit 2001`);
  snapshot.plans = (await read(`select to_jsonb(p) row from membership_payment_plans p
    where tenant_id=$1 order by id limit 2001`)).map(x => x.row);
  assert(snapshot.agreements.length < 2001 && snapshot.plans.length < 2001);
  save('snapshot', snapshot);
  const tokens = await read('select tenant_id,access_token,expires_at from xero_token where app_tenant_id=$1');
  assert(tokens.length === 1 && tokens[0].tenant_id === XERO_TENANT);
  const xero = async path => {
    await new Promise(r => setTimeout(r, 1250));
    const res = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      headers: { Authorization: `Bearer ${tokens[0].access_token}`, 'xero-tenant-id': XERO_TENANT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    assert(res.ok, `Xero GET HTTP ${res.status}`);
    return res.json();
  };
  const { getStripeIntegrationCredentials } = await import('../api/_lib/stripeCredentials.js');
  const { getTenantGocardlessCredentials } = await import('../api/_lib/gocardlessCredentials.js');
  const credentials = await getStripeIntegrationCredentials(TENANT);
  const clients = Object.fromEntries([['test', credentials.test_secret_key], ['live', credentials.secret_key]]
    .filter(([, key]) => key).map(([mode, key]) => [mode, new Stripe(key, { maxNetworkRetries: 0, timeout: 30000 })]));
  let gc;
  try { gc = await getTenantGocardlessCredentials(TENANT); } catch { /* Explicit unresolved evidence below. */ }
  const result = { at: new Date().toISOString(), counts: Object.fromEntries(Object.entries(snapshot).map(([k,v]) => [k,v.length])),
    excluded: [...excluded], stripe: [], gocardless: [], invoices: [], payments: [] };
  const persist = () => save('evidence', result);
  for (const row of snapshot.membership_instalment_invoices) {
    if (excluded.has(row.accounting_invoice_number)) continue;
    const agreement = snapshot.agreements.find(a => a.id === row.billing_agreement_id);
    const item = { row, agreement, attempts: [] };
    for (const mode of [...new Set([agreement?.environment === 'test' ? 'test' : 'live', 'test', 'live'])]) {
      if (!clients[mode]) continue;
      try {
        const invoice = await clients[mode].invoices.retrieve(row.external_payment_id);
        const sid = invoice.subscription || invoice.parent?.subscription_details?.subscription;
        const sub = sid ? await clients[mode].subscriptions.retrieve(sid) : null;
        item.provider = { mode, id: invoice.id, livemode: invoice.livemode, status: invoice.status,
          amount_paid: invoice.amount_paid, currency: invoice.currency, customer_name: invoice.customer_name,
          customer_email: invoice.customer_email, created: invoice.created, subscription: sid,
          subscription_status: sub?.status, subscription_livemode: sub?.livemode, metadata: sub?.metadata };
        break;
      } catch (e) { item.attempts.push({ mode, status: e.statusCode, code: e.code }); }
    }
    result.stripe.push(item); persist();
  }
  for (const row of snapshot.gocardless_payments) {
    const item = { row, provider: null };
    if (gc) {
      const host = gc.environment === 'live' ? 'api.gocardless.com' : 'api-sandbox.gocardless.com';
      const res = await fetch(`https://${host}/payments/${encodeURIComponent(row.gocardless_payment_id)}`, {
        headers: { Authorization: `Bearer ${gc.accessToken}`, 'GoCardless-Version': '2015-07-06' },
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      item.lookup = { environment: gc.environment, http: res.status };
      if (res.ok) item.provider = (await res.json()).payments;
      else assert.equal(res.status, 404, `GoCardless unexpected HTTP ${res.status}`);
    } else item.lookup = { error: 'tenant_credentials_unavailable' };
    result.gocardless.push(item); persist();
  }
  const ids = [...new Set([...result.stripe, ...result.gocardless].flatMap(x =>
    [x.row.accounting_invoice_id, x.row.xero_invoice_id]).filter(Boolean))];
  // Xero supports explicit IDs; batch without a contact filter to include every name.
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const invoices = (await xero(`Invoices?IDs=${batch.join(',')}`)).Invoices;
    assert(batch.every(id => invoices.some(x => x.InvoiceID === id)), 'Missing Xero invoice');
    result.invoices.push(...invoices); persist();
  }
  const testInvoiceIds = new Set([...result.stripe.filter(x => x.provider?.livemode === false),
    ...result.gocardless.filter(x => x.row.environment === 'sandbox' || x.lookup?.environment === 'sandbox')]
    .flatMap(x => [x.row.accounting_invoice_id, x.row.xero_invoice_id]).filter(Boolean));
  for (const invoice of result.invoices.filter(x => testInvoiceIds.has(x.InvoiceID))) {
    for (const p of invoice.Payments || []) {
      result.payments.push(...(await xero(`Payments/${p.PaymentID}`)).Payments); persist();
    }
  }
  result.complete = true;
  persist();
  console.log(JSON.stringify({ output: dir, counts: result.counts, stripe: result.stripe.length,
    gc: result.gocardless.length, invoices: result.invoices.length,
    stripeTest: result.stripe.filter(x => x.provider?.livemode === false).length,
    gcUnresolved: result.gocardless.filter(x => !x.provider).length }));
} finally { await db.end(); }
