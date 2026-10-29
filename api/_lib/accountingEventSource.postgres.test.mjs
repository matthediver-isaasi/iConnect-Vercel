import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('event queue SQL: atomic capture, immutable evidence, original payment owner and fenced linkage', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('event-accounting-');
  const cmd = (name, args) => { const r = spawnSync(name, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  let db;
  try {
    cmd('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    cmd('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }); await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,event_id uuid,
        booking_group_reference text,status text DEFAULT 'confirmed',payment_method text DEFAULT 'card',
        payment_status text DEFAULT 'paid',stripe_payment_intent_id text,xero_invoice_id text,xero_invoice_number text,
        invoice_recovery_status text,invoice_recovery_next_attempt_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE tenant_accounting_settings(tenant_id uuid,active_provider text);
      CREATE TABLE quickbooks_token(id uuid,app_tenant_id uuid,realm_id text,environment text);
      CREATE TABLE event_invoice_recovery(tenant_id uuid,source text,booking_group_reference text,settlement_payment_intent_id text);`);
    for (const name of ['202612050001_accounting_request_queue.sql', '202612050002_accounting_request_gc_preparation.sql', '202612050005_event_accounting_queue.sql']) {
      await db.query(readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const t = '00000000-0000-4000-8000-000000000001';
    const event = '00000000-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO tenant_accounting_settings VALUES($1,'quickbooks');`, [t]);
    await db.query(`INSERT INTO quickbooks_token VALUES($1,$1,'realm','production');`, [t]);
    await db.query(`INSERT INTO booking(tenant_id,event_id,booking_group_reference,stripe_payment_intent_id) VALUES($1,$2,'group','pi_original');`, [t,event]);
    const snapshot = { version: 1, preparation: true, environment: 'production',
      invoice: { capturedAt: new Date().toISOString(), eventId: event, paymentMethod: 'stripe', amount: 20 },
      payment: { paymentIntentId: 'pi_original' }, linkage: { source: 'booking', group: 'group' } };
    await db.query('SET ROLE service_role');
    const capture = () => db.query('SELECT * FROM accounting_event_capture($1,$2,$3,$4,$5,$6)', [t,'booking','group',t,'realm',snapshot]);
    const row = (await capture()).rows[0];
    assert.ok(row.id);
    assert.equal((await capture()).rows[0].id, row.id);
    assert.equal(row.preparation_status, 'pending');
    const claim = (await db.query('SELECT * FROM accounting_request_claim($1)', [row.id])).rows[0];
    const guard = () => db.query('SELECT accounting_event_guard($1,$2) AS ok', [row.id,claim.lease_token]);
    assert.equal((await guard()).rows[0].ok, true);
    await assert.rejects(db.query('SELECT accounting_event_link($1,$2)', [row.id,claim.lease_token]));
    await assert.rejects(db.query("UPDATE accounting_event_operation SET snapshot='{}'"));
    await db.query('RESET ROLE');
    await assert.rejects(db.query(`INSERT INTO event_invoice_recovery VALUES($1,'booking','other','pi_original')`, [t]));
    await db.query(`UPDATE booking SET payment_status='refunded'`);
    assert.equal((await guard()).rows[0].ok, false);
    await db.query(`UPDATE booking SET payment_status='paid'`);
    // Simulate already-validated durable stages, then exercise the actual link RPC.
    await db.query(`UPDATE accounting_request_queue SET preparation_status='done',invoice_status='done',invoice_result='{"id":"invoice","invoiceNumber":"INV-1"}',
      payment_status='done',payment_result='{"id":"payment"}' WHERE id=$1`, [row.id]);
    await db.query('SET ROLE service_role');
    assert.equal((await db.query('SELECT accounting_event_link($1,$2) AS result', [row.id,claim.lease_token])).rows[0].result.linked, true);
    assert.equal((await guard()).rows[0].ok, true);
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT accounting_invoice_id FROM booking')).rows[0].accounting_invoice_id, 'invoice');
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT accounting_event_due()'));
    // Explicit public-PO approval can invoice an old registration without
    // manufacturing a payment or pretending it was a fresh checkout.
    await db.query('RESET ROLE');
    await db.query(`CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE role(id uuid,tenant_id uuid,requires_effective_from_date boolean,max_members integer);
      ALTER TABLE booking ADD COLUMN purchaser_context jsonb,ADD COLUMN total_cost numeric,ADD COLUMN currency text;
      ALTER TABLE complex_event_booking ADD COLUMN purchaser_context jsonb,ADD COLUMN total_cost numeric,ADD COLUMN currency text;`);
    for(const name of ['202612090003_public_invoice_po_billing.sql','202612090004_public_invoice_booker_member.sql'])
      await db.query(readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
    await db.query(`INSERT INTO member VALUES($1,$1,'booker@example.invalid');
      `,[t]);
    const bookingId=(await db.query(`INSERT INTO booking(tenant_id,event_id,booking_group_reference,payment_method,payment_status,total_cost,currency,created_at,purchaser_context)
      VALUES($1,$2,'public-po','public_invoice_po','unpaid',20,'GBP',now()-interval '5 days',
      '{"classification":"public_non_member","details":{"email":"booker@example.invalid"}}') RETURNING id`,[t,event])).rows[0].id;
    const originals=(await db.query(`SELECT jsonb_agg(to_jsonb(b) ORDER BY id) rows FROM booking b WHERE id=$1`,[bookingId])).rows[0].rows;
    const invoiceSnapshot={version:1,preparation:true,environment:'production',invoice:{amount:20,currency:'GBP',paymentMethod:'invoice',eventId:event,capturedAt:new Date().toISOString(),
      contact:{name:'Booker',email:'booker@example.invalid',provenance:{kind:'member',id:t}}},
      payment:null,linkage:{source:'booking',group:'public-po'},approvalProvider:{connectionId:t,realmId:'realm'}};
    const approve=()=>db.query('SELECT public_invoice_po_bill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',
      [t,'booking','public-po',t,'admin',JSON.stringify(originals),20,'GBP','quickbooks',invoiceSnapshot]);
    await db.query('SET ROLE authenticated');await assert.rejects(approve());
    await db.query('RESET ROLE');
    const approval=(await approve()).rows[0].result;
    assert.equal((await approve()).rows[0].result.id,approval.id,'repeat approval cannot invoice twice');
    const converted=(await db.query('SELECT * FROM booking WHERE id=$1',[bookingId])).rows[0];
    assert.equal(converted.payment_method,'invoice');
    assert.equal(converted.payment_status,'unpaid');
    assert.equal(converted.stripe_payment_intent_id,null);
    assert.equal(converted.purchaser_context.invoice_approval_id,approval.id);
    assert.equal((await db.query(`SELECT count(*)::int n FROM accounting_request_queue WHERE source_id='public-po'`)).rows[0].n,1);
  } finally {
    await db?.end();
    spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
