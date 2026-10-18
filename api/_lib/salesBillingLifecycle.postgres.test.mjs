import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('real Sales migration chain: draft, issue, amendment, staff/public acceptance and immutable schedules', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('sales-billing-lifecycle-');
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let started = false, db;
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[]);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text,UNIQUE(tenant_id,id));
      CREATE TABLE tenant_identity(id varchar PRIMARY KEY,first_name text,last_name text,email text);
      CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid,identity_id varchar,first_name text,last_name text,email text);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,
        is_group_ticket boolean DEFAULT false,group_size integer,available_count integer,is_unlimited_tickets boolean DEFAULT true);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,identity_id text,first_name text,last_name text,email text);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,ticket_class_id text,status text,
        attendee_email text,organization_id uuid,created_at timestamptz);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text,UNIQUE(tenant_id,setting_key));
    `);
    await db.query(readFileSync('scripts/migrations/add-project-management.sql', 'utf8'));
    await db.query(readFileSync('supabase/migrations/20260908_opportunity_pipeline.sql', 'utf8'));
    const migrations = [
      '20260907_sales_foundation', '20260908_sales_catalogue', '20260909_sales_quotes',
      '20260910_sales_commercial_allocation', '20260911_sales_quote_delivery', '20260912_sales_accounting_invoice',
      '20260912_sales_allocation_delegate_registration', '20260913_sales_concurrency_hardening',
      '202610090001_sales_project_tasks', '202610090002_sales_direct_tax_codes',
      '202610120001_sales_quote_rate_limit_digest', '202610120002_sales_acceptance_tasks',
      '202610120003_sales_acceptance_task_grants', '202610120004_sales_automatic_quote_task_lists',
      '202610130002_sales_catalogue_atomic_create', '202610180001_sales_catalogue_visibility',
      '202610180002_sales_quote_naming', '202610180003_sales_grouped_billing',
      '202610180004_sales_billing_configuration',
    ];
    for (const name of migrations) {
      try { await db.query(readFileSync(`supabase/migrations/${name}.sql`, 'utf8')); }
      catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    }
    const tenant = randomUUID(), actor = randomUUID();
    await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
    const terms = { id: randomUUID(), name: '14 days', days: 14 };
    const group = { id: randomUUID(), name: 'Remainder', linePosition: null, position: 0, currency: 'GBP',
      netMinor: 100, taxMinor: 0, grossMinor: 100, timing: { kind: 'acceptance', days: 0 }, paymentTerms: terms, contents: [] };
    const schedule = { timezone: 'UTC', timezoneFallback: true, recipient: { email: 'customer@example.test' },
      remainderPaymentTerms: terms, groups: [group] };
    const payload = { currency: 'GBP', termsSnapshot: {}, billingSchedule: schedule, lines: [{
      kind: 'free_text', description: 'Consulting', quantity: '1', standardUnitPriceMinor: 100, quotedUnitPriceMinor: 100,
      priceOverridden: false, discountBps: 0, taxRateBps: 0, netMinor: 100, taxMinor: 0, grossMinor: 100, components: [],
    }], totals: { netMinor: 100, taxMinor: 0, grossMinor: 100 } };
    const rpc = async (name, params) => (await db.query(`SELECT public.${name}(${params.map((_,i)=>`$${i+1}`).join(',')}) AS value`, params)).rows[0].value;
    const create = () => rpc('save_sales_quote_draft', [tenant, null, null, payload, actor, 'tenant_user']);
    const issue = q => rpc('issue_sales_quote', [tenant, q.id, q.row_version, actor, 'tenant_user']);
    const count = async () => Number((await db.query('SELECT count(*) FROM sales_invoice_schedule')).rows[0].count);
    const staff = await create();
    assert.equal(await count(), 0);
    const changed = structuredClone(payload);
    Object.assign(changed.lines[0], { standardUnitPriceMinor: 200, quotedUnitPriceMinor: 200, netMinor: 200, grossMinor: 200 });
    Object.assign(changed.totals, { netMinor: 200, grossMinor: 200 });
    Object.assign(changed.billingSchedule.groups[0], { netMinor: 200, grossMinor: 200 });
    const repriced = await rpc('save_sales_quote_draft', [tenant, staff.id, staff.row_version, changed, actor, 'tenant_user']);
    const savedAgain = await rpc('save_sales_quote_draft', [tenant, staff.id, repriced.row_version, payload, actor, 'tenant_user']);
    const issued = await issue(savedAgain);
    assert.equal(await count(), 0);
    await db.query(`UPDATE sales_settings SET default_terms='Changed terms' WHERE tenant_id=$1`, [tenant]);
    await db.query(`UPDATE sales_settings SET billing_presets=$2 WHERE tenant_id=$1`, [tenant,
      { issueDelays: [], paymentTerms: [{ ...terms, name: 'Edited', days: 30, isActive: false, isDefault: false }] }]);
    await db.query(`INSERT INTO sales_catalogue_bundle(tenant_id,code,name,currency,selling_price_minor)
      VALUES($1,'NEW','Changed catalogue','GBP',500)`, [tenant]);
    assert.deepEqual((await db.query('SELECT billing_schedule FROM sales_quote_version WHERE id=$1', [staff.version_id])).rows[0].billing_schedule, schedule);
    await assert.rejects(db.query(`UPDATE sales_quote_version SET billing_schedule=NULL WHERE id=$1`, [staff.version_id]), /immutable/);
    const accepted = await rpc('transition_sales_quote', [tenant, staff.id, issued.row_version, 'accepted', 'Staff accepted', actor, 'tenant_user']);
    assert.equal(accepted.status, 'converted');
    assert.equal(await count(), 1, 'staff scheduled acceptance converts atomically, without browser follow-up');
    const sale = await rpc('confirm_sales_quote_sale', [tenant, staff.id, accepted.row_version, `staff-scheduled-acceptance:${staff.version_id}`, 'tenant_user', actor]);
    assert.equal(await count(), 1);
    const repeated = await rpc('confirm_sales_quote_sale', [tenant, staff.id, accepted.row_version, `staff-scheduled-acceptance:${staff.version_id}`, 'tenant_user', actor]);
    assert.equal(repeated.saleId, sale.saleId);
    assert.equal(await count(), 1);
    const publicDraft = await create();
    await assert.rejects(rpc('confirm_sales_quote_sale', [tenant, publicDraft.id, publicDraft.row_version, 'unissued', 'tenant_user', actor]), /accepted/);
    await issue(publicDraft);
    await assert.rejects(rpc('confirm_sales_quote_sale', [tenant, publicDraft.id, 2, 'unaccepted', 'tenant_user', actor]), /accepted/);
    const token = 'ab'.repeat(32);
    await db.query(`INSERT INTO sales_quote_delivery_token(tenant_id,quote_id,quote_version_id,token_hash,
      expires_at,activated_at,created_by) VALUES($1,$2,$3,decode($4,'hex'),now()+interval '1 day',now(),$5)`,
    [tenant, publicDraft.id, publicDraft.version_id, token, actor]);
    const decision = [token, 'accepted', 'Customer', 'Director', null, null, null, true, 'public-key', {}];
    assert.equal((await rpc('decide_sales_quote_public', decision)).outcome, 'accepted');
    assert.equal(await count(), 2);
    const scheduleRow = (await db.query('SELECT * FROM sales_invoice_schedule LIMIT 1')).rows[0];
    await assert.rejects(db.query(`INSERT INTO sales_invoice_schedule
      (tenant_id,sale_id,quote_version_id,group_id,snapshot,planned_issue_date,timezone)
      VALUES($1,$2,$3,$4,$5,'2000-01-01','UTC')`, [scheduleRow.tenant_id, scheduleRow.sale_id,
      scheduleRow.quote_version_id, scheduleRow.group_id, scheduleRow.snapshot]), /dates must match/);
    const forged = { ...scheduleRow.snapshot, acceptedAt: '2000-01-01T00:00:00Z' };
    await assert.rejects(db.query(`INSERT INTO sales_invoice_schedule
      (tenant_id,sale_id,quote_version_id,group_id,snapshot,planned_issue_date,timezone)
      VALUES($1,$2,$3,$4,$5,$6,'UTC')`, [scheduleRow.tenant_id, scheduleRow.sale_id,
      scheduleRow.quote_version_id, scheduleRow.group_id, forged, scheduleRow.planned_issue_date]), /dates must match/);
    assert.equal((await rpc('decide_sales_quote_public', decision)).idempotent, true);
    assert.equal(await count(), 2);
    const amended = await create();
    const beforeAmend = await issue(amended);
    const amendment = await rpc('amend_sales_quote', [tenant, amended.id, beforeAmend.row_version, actor, 'tenant_user']);
    const clone = (await db.query('SELECT * FROM sales_quote_version WHERE quote_id=$1 AND version_number=2', [amended.id])).rows[0];
    assert.deepEqual(clone.billing_schedule, schedule);
    assert.equal(clone.status, 'draft');
    await assert.rejects(rpc('confirm_sales_quote_sale', [tenant, amended.id, amendment.row_version, 'draft-key', 'tenant_user', actor]), /accepted/);
    assert.equal(await count(), 2);
    const declined = await create(), beforeDecline = await issue(declined);
    const decline = await rpc('transition_sales_quote', [tenant, declined.id, beforeDecline.row_version, 'declined', null, actor, 'tenant_user']);
    await assert.rejects(rpc('confirm_sales_quote_sale', [tenant, declined.id, decline.row_version, 'declined-key', 'tenant_user', actor]), /accepted/);
    assert.equal(await count(), 2);
    const expired = await create(), beforeExpire = await issue(expired);
    const expire = await rpc('transition_sales_quote', [tenant, expired.id, beforeExpire.row_version, 'expired', null, actor, 'tenant_user']);
    await assert.rejects(rpc('confirm_sales_quote_sale', [tenant, expired.id, expire.row_version, 'expired-key', 'tenant_user', actor]), /accepted/);
    const legacy = await rpc('save_sales_quote_draft', [tenant, null, null, { ...payload, billingSchedule: null }, actor, 'tenant_user']);
    const legacyIssued = await issue(legacy);
    assert.equal((await rpc('transition_sales_quote', [tenant, legacy.id, legacyIssued.row_version, 'accepted', null, actor, 'tenant_user'])).status, 'accepted');
    assert.equal(await count(), 2, 'legacy remains unscheduled');
    await assert.rejects(db.query('DELETE FROM sales_invoice_schedule'), /Schedules cannot be deleted/);
    await assert.rejects(db.query('DELETE FROM sales_quote_version WHERE id=$1', [staff.version_id]), /immutable/);
    const rights = (await db.query(`SELECT
      has_table_privilege('service_role','sales_invoice_schedule','DELETE') AS can_delete,
      has_table_privilege('service_role','sales_invoice_schedule','TRUNCATE') AS can_truncate`)).rows[0];
    assert.deepEqual(rights, { can_delete: false, can_truncate: false });
    assert.equal(await count(), 2);
  } finally {
    await db?.end();
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
