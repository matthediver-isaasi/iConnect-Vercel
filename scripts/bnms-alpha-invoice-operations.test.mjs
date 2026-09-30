import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { createXeroMembershipInvoice } from '../api/_lib/xero.js';
import { resolveAlphaAccountingContext, alphaAccountingMapping, BNMS_ALPHA_MANIFEST } from '../api/_lib/bnmsAlphaAccounting.js';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const plan = '00000000-0000-4000-8000-000000000001';
const agreementId = '00000000-0000-4000-8000-000000000002';
const adoptionId = '00000000-0000-4000-8000-000000000003';
const memberId = '00000000-0000-4000-8000-000000000004';
const invoiceId = '00000000-0000-4000-8000-000000000005';
const contactId = '00000000-0000-4000-8000-000000000006';
const mapping = alphaAccountingMapping('200');
const identity = payment => ({ contactId, xeroTenantId: mapping.xero_tenant_id, amountMinor: 1300,
  currency: 'GBP', revenueCode: '200', paymentReference: `GoCardless DD: ${payment}`,
  idempotencyKey: `inv-${payment}`, paymentIdempotencyKey: `pay-${payment}` });

test('alpha durable invoice guard: service-only, concurrent claims, delayed uncertain runtime retry, immutable linkage', { timeout: 90000 }, async () => {
  const h = await createLocalPostgresHarness('alpha-invoice-ops-');
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  let started = false;
  const clients = [];
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    const connect = async () => {
      const c = new pg.Client({ host: h.socket, port: h.port, database: 'postgres', user: 'postgres' });
      await c.connect(); clients.push(c); return c;
    };
    const owner = await connect();
    await owner.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY);
      INSERT INTO membership_payment_plans VALUES('${plan}');
      CREATE TABLE bnms_dd_alpha_adoption(id uuid,tenant_id uuid,plan_id uuid,agreement_id uuid,mandate_id text,manifest_sha256 text);
      CREATE TABLE bnms_dd_alpha_release(adoption_id uuid,plan_id uuid,tenant_id uuid,evidence jsonb);
      CREATE TABLE gocardless_payments(plan_id uuid,tenant_id uuid,gocardless_payment_id text,gocardless_mandate_id text,
        environment text,status text,currency text,amount_minor integer);
      CREATE TABLE gocardless_collection_reservations(plan_id uuid,tenant_id uuid,gocardless_payment_id text,billing_agreement_id uuid,
        amount_minor integer,currency text,due_date date);
      INSERT INTO bnms_dd_alpha_adoption VALUES('${adoptionId}','${tenant}','${plan}','${agreementId}','MD1','${BNMS_ALPHA_MANIFEST}');
      INSERT INTO bnms_dd_alpha_release VALUES('${adoptionId}','${plan}','${tenant}',
        '{"accounting":{"contactId":"${contactId}","revenueCode":"200"}}');
      INSERT INTO gocardless_payments SELECT '${plan}','${tenant}',p,'MD1','live','confirmed','GBP',1300 FROM unnest(ARRAY['PM1','PM2','PM3']) p;
      INSERT INTO gocardless_collection_reservations SELECT '${plan}','${tenant}',p,'${agreementId}',1300,'GBP','2026-10-01'
        FROM unnest(ARRAY['PM1','PM2','PM3']) p;
    `);
    const migration = readFileSync(new URL('../supabase/migrations/20261118_bnms_alpha_invoice_operations.sql', import.meta.url), 'utf8');
    await owner.query(migration);
    await owner.query(migration); // idempotent installation must not reset claims
    const a = await connect(), b = await connect();
    await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
    const claim = (c, payment = 'PM1', request = identity(payment)) => c.query(
      'SELECT bnms_alpha_claim_invoice($1,$2,$3,$4) AS result', [tenant, plan, payment, request]);
    const race = await Promise.allSettled([claim(a), claim(b)]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(race.find(r => r.status === 'rejected').reason.message, /uncertain/);
    const op = race.find(r => r.status === 'fulfilled').value.rows[0].result;
    await assert.rejects(a.query('DELETE FROM bnms_alpha_invoice_operations'), /permission denied/);
    await assert.rejects(a.query("UPDATE bnms_alpha_invoice_operations SET invoice_id='other'"), /permission denied/);
    await assert.rejects(claim(a, 'PM1', { ...identity('PM1'), amountMinor: 1400 }), /canonical ownership/);
    await assert.rejects(claim(a, 'PM1', { ...identity('PM1'), idempotencyKey: 'changed' }), /identity changed/);
    await assert.rejects(a.query('SELECT bnms_alpha_link_invoice($1,$2,$3)', [op.id, plan, invoiceId]), /ownership mismatch/);
    await a.query('SELECT bnms_alpha_link_invoice($1,$2,$3)', [op.id, op.token, invoiceId]);
    assert.equal((await claim(a)).rows[0].result.invoice_id, invoiceId);
    assert.equal((await claim(a)).rows[0].result.token, null);
    await assert.rejects(a.query('SELECT bnms_alpha_link_invoice($1,$2,$3)', [op.id, op.token, contactId]), /ownership mismatch/);
    await b.query('SET ROLE authenticated');
    await assert.rejects(claim(b), /permission denied/);
    await b.query('SET ROLE anon');
    await assert.rejects(claim(b), /permission denied/);

    const agreement = { id: agreementId, tenant_id: tenant, member_id: memberId,
      provider: 'gocardless', environment: 'live', gocardless_mandate_id: 'MD1', gocardless_customer_id: 'CU1' };
    const adoption = { id: adoptionId, tenant_id: tenant, member_id: memberId, agreement_id: agreementId,
      plan_id: plan, mandate_id: 'MD1', customer_id: 'CU1', manifest_sha256: BNMS_ALPHA_MANIFEST,
      evidence: { ids: { adoption: adoptionId, agreement: agreementId, plan }, identity: { memberId },
        structure: { structure_match_value: 'Full' }, links: [{
          member_id: memberId, tenant_id: tenant, xero_tenant_id: mapping.xero_tenant_id, xero_contact_id: contactId,
          evidence: { contact: { ContactID: contactId, EmailAddress: 'owner@example.test' },
            invoice: { Contact: { ContactID: contactId }, LineItems: [{ AccountCode: '200', TaxType: 'ZERORATEDOUTPUT', TaxAmount: 0 }] } },
        }] } };
    const release = { processing_not_before: '2026-09-30T23:00:00Z',
      evidence: { adoptionId, agreementId, planId: plan, memberId,
        accounting: { mapping, contactId, bankAccountId: mapping.bank_account_id, xeroTenantId: mapping.xero_tenant_id, revenueCode: '200' } } };
    let loseLocalLink = false;
    const db = {
      from(table) { return { select() { return this; }, eq() { return this; }, async maybeSingle() {
        return { data: table === 'bnms_dd_alpha_adoption' ? adoption : table === 'bnms_dd_alpha_release' ? release : null };
      } }; },
      async rpc(name, args) {
        if (loseLocalLink && name === 'bnms_alpha_link_invoice') return { error: { message: 'lost local linkage write' } };
        try {
          const values = Object.values(args);
          const r = await a.query(`SELECT ${name}(${values.map((_, i) => `$${i + 1}`).join(',')}) AS result`, values);
          return { data: r.rows[0].result };
        } catch (error) { return { error }; }
      },
    };
    const context = await resolveAlphaAccountingContext(agreement, db);
    let posts = 0, loseProviderResponse = true;
    const deps = { supabase: db,
      getValidXeroAccessToken: async () => ({ accessToken: 'fixture', tenantId: mapping.xero_tenant_id }),
      findOrCreateXeroContact: () => { throw new Error('Forbidden generic contact operation'); },
      fetch: async (url, init) => {
        let data;
        if (url.endsWith('/Organisation')) data = { Organisations: [{ OrganisationID: mapping.xero_tenant_id, BaseCurrency: 'GBP' }] };
        else if (url.includes('/Accounts/')) data = { Accounts: [{ AccountID: mapping.bank_account_id, Status: 'ACTIVE', Type: 'BANK', CurrencyCode: 'GBP' }] };
        else if (url.includes('/Accounts?')) data = { Accounts: [{ Code: '200', Status: 'ACTIVE', Type: 'REVENUE' }] };
        else if (url.includes('/Contacts/')) data = { Contacts: [{ ContactID: contactId, EmailAddress: 'owner@example.test', ContactStatus: 'ACTIVE' }] };
        else if (url.endsWith('/Invoices') && init.method === 'POST') {
          posts++;
          if (loseProviderResponse) throw new Error('Provider accepted create; connection lost before response');
          data = { Invoices: [{ InvoiceID: invoiceId, Status: 'AUTHORISED', Contact: { ContactID: contactId },
            CurrencyCode: 'GBP', Total: 13, AmountPaid: 0, AmountDue: 13, LineItems: [{ AccountCode: '200' }] }] };
        } else throw new Error(`Unexpected provider request ${url}`);
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      },
    };
    const args = { appTenantId: tenant, organizationName: 'Renamed member', membershipYear: '2026',
      finalCost: 13, currency: 'GBP', nominalCode: '200', markAsPaid: true,
      bankAccountSettingKey: 'xero_gocardless_bank_account_code', strictBankAccount: true,
      ddAccountingMigration: context, ...identity('PM2') };
    await assert.rejects(createXeroMembershipInvoice(args, deps), /connection lost/);
    // Force a realistically late retry; the claim has no expiry/reset path.
    await owner.query("UPDATE bnms_alpha_invoice_operations SET created_at=now()-interval '90 days' WHERE payment_id='PM2'");
    await assert.rejects(createXeroMembershipInvoice(args, deps), /uncertain/);
    assert.equal(posts, 1);
    assert.equal((await owner.query("SELECT count(*) FROM bnms_alpha_invoice_operations WHERE payment_id='PM2'")).rows[0].count, '1');
    loseProviderResponse = false; loseLocalLink = true;
    const nextArgs = { ...args, ...identity('PM3') };
    await assert.rejects(createXeroMembershipInvoice(nextArgs, deps), /lost local linkage/);
    await owner.query("UPDATE bnms_alpha_invoice_operations SET created_at=now()-interval '90 days' WHERE payment_id='PM3'");
    await assert.rejects(createXeroMembershipInvoice(nextArgs, deps), /uncertain/);
    assert.equal(posts, 2); // one PM2 create, one PM3 create; no delayed repeat
    await a.query('SELECT bnms_alpha_assert_invoice($1,$2,$3,$4,$5)', [tenant, plan, 'PM1', invoiceId, contactId]);
    await assert.rejects(a.query('SELECT bnms_alpha_assert_invoice($1,$2,$3,$4,$5)',
      [tenant, plan, 'PM2', invoiceId, contactId]), /exact durable collection linkage/);
  } finally {
    await Promise.all(clients.map(c => c.end()));
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});