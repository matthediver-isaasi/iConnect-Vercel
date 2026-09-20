import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated PostgreSQL: default-off settings, immutable snapshot, no payment/accounting mutations', { timeout: 45000 }, async () => {
  const h = await createLocalPostgresHarness('public-po-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0, 'unsafe statement must fail');
    else assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const sql = (input, fail = false) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], input, fail);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE TABLE event(id text);
      CREATE TABLE complex_event(id text);
      CREATE TABLE booking(id text, tenant_id text, event_id text, created_at timestamptz,
        member_id text, organization_id text, payment_method text, status text DEFAULT 'confirmed',
        stripe_payment_intent_id text, xero_invoice_id text, xero_invoice_number text,
        accounting_invoice_id text, accounting_invoice_number text, accounting_provider text,
        voucher_amount numeric DEFAULT 0, training_fund_amount numeric DEFAULT 0,
        account_amount numeric DEFAULT 0, po_to_follow boolean DEFAULT false);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING DEFAULTS);
      ALTER TABLE complex_event_booking ADD COLUMN total_paid numeric DEFAULT 0,
        ADD COLUMN payment_status text DEFAULT 'pending';
      INSERT INTO event VALUES ('existing');
    `);
    const migration = readFileSync(new URL('./202607200001_public_invoice_po.sql', import.meta.url), 'utf8');
    sql(migration);
    sql(migration); // Idempotent rollout.
    assert.equal(sql('SELECT allow_public_invoice_po FROM event;').trim(), 'f');
    const context = JSON.stringify({ classification: 'public_non_member', details: { email: 'buyer@example.com' } });
    for (const table of ['booking', 'complex_event_booking']) {
      sql(`INSERT INTO ${table}(id, payment_method, purchaser_context) VALUES ('public', 'public_invoice_po', '${context}');`);
      for (const update of [
        `purchaser_context = '{}'`, `payment_method = 'invoice'`, `stripe_payment_intent_id = 'pi_123'`,
        `xero_invoice_id = 'invoice'`, `accounting_invoice_id = 'qbo'`, `voucher_amount = 50`,
        `training_fund_amount = 50`, `account_amount = 50`, `po_to_follow = true`,
      ]) sql(`UPDATE ${table} SET ${update} WHERE id='public';`, true);
      sql(`UPDATE ${table} SET member_id='later-attendee-account', organization_id='later-attendee-org' WHERE id='public';`);
      assert.equal(sql(`SELECT purchaser_context->>'classification' FROM ${table} WHERE id='public';`).trim(), 'public_non_member');
      assert.equal(sql(`SELECT member_id FROM ${table} WHERE id='public';`).trim(), 'later-attendee-account');
      sql(`UPDATE ${table} SET status='cancelled', purchase_order_number='PO-123' WHERE id='public';`);
      sql(`INSERT INTO ${table}(id, payment_method) VALUES ('ordinary', 'invoice');`);
      sql(`UPDATE ${table} SET xero_invoice_id='existing-invoice' WHERE id='ordinary';`);
      sql(`INSERT INTO ${table}(payment_method) VALUES ('public_invoice_po');`, true);
    }
    sql(`UPDATE complex_event_booking SET total_paid=100 WHERE id='public';`, true);
    sql(`UPDATE complex_event_booking SET payment_status='paid' WHERE id='public';`, true);
    // Run the real ticket-capacity RPCs against the new method, not a mock.
    sql(`
      TRUNCATE booking, complex_event_booking, event, complex_event;
      ALTER TABLE event ALTER COLUMN id TYPE uuid USING id::uuid, ADD COLUMN pricing_config jsonb;
      ALTER TABLE complex_event ALTER COLUMN id TYPE uuid USING id::uuid;
      ALTER TABLE booking ALTER COLUMN id TYPE uuid USING id::uuid,
        ALTER COLUMN event_id TYPE uuid USING event_id::uuid, ADD COLUMN ticket_class_id text;
      ALTER TABLE complex_event_booking ALTER COLUMN id TYPE uuid USING id::uuid,
        ALTER COLUMN event_id TYPE uuid USING event_id::uuid, ADD COLUMN ticket_class_id text,
        ADD PRIMARY KEY (id);
      CREATE TABLE complex_event_ticket_class(id uuid, complex_event_id uuid, available_count integer, is_unlimited_tickets boolean);
      CREATE PUBLICATION supabase_realtime;
    `);
    sql(readFileSync(new URL('./20260623_oneoff_ticket_capacity_guard.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('./20260623_complex_event_ticket_capacity_guard.sql', import.meta.url), 'utf8'));
    const eventId = '00000000-0000-0000-0000-000000000001';
    const ticketId = '00000000-0000-0000-0000-000000000002';
    const winnerId = '00000000-0000-0000-0000-000000000003';
    const loserId = '00000000-0000-0000-0000-000000000004';
    sql(`INSERT INTO event(id,pricing_config) VALUES ('${eventId}', '{"ticket_classes":[{"id":"${ticketId}","available_count":1}]}');
      INSERT INTO complex_event_ticket_class VALUES ('${ticketId}','${eventId}',1,false);`);
    for (const [table, rpc] of [['booking', 'check_oneoff_ticket_capacity'], ['complex_event_booking', 'check_complex_event_ticket_capacity']]) {
      sql(`INSERT INTO ${table}(id,event_id,ticket_class_id,created_at,payment_method,purchaser_context)
        VALUES ('${winnerId}','${eventId}','${ticketId}','2026-01-01','public_invoice_po','${context}');`);
      assert.equal(sql(`SELECT ${rpc}('${eventId}','${ticketId}',1)->>'ok';`).trim(), 'false');
      assert.equal(sql(`SELECT ${rpc}('${eventId}','${ticketId}',1,ARRAY['${winnerId}'::uuid])->>'ok';`).trim(), 'true');
      assert.equal(sql(`SELECT purchaser_context->>'classification' FROM ${table};`).trim(), 'public_non_member');
      sql(`INSERT INTO ${table}(id,event_id,ticket_class_id,created_at,payment_method,purchaser_context)
        VALUES ('${loserId}','${eventId}','${ticketId}','2026-01-02','public_invoice_po','${context}');`);
      assert.equal(sql(`SELECT ${rpc}('${eventId}','${ticketId}',1,ARRAY['${loserId}'::uuid])->>'ok';`).trim(), 'false');
      assert.equal(sql(`SELECT count(*) FROM ${table};`).trim(), '1');
      sql(`UPDATE ${table} SET status='cancelled';`);
      assert.equal(sql(`SELECT ${rpc}('${eventId}','${ticketId}',1)->>'ok';`).trim(), 'true');
    }
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});