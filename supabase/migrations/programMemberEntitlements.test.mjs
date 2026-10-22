import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('personal programme purchase, atomic consumption, scoped original-owner cancellation', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('program-member-');
  const run = (cmd, args, input, fail = false) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(result.status, 0);
    else assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const sql = (input, fail = false) => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], input, fail);
  const t = '00000000-0000-0000-0000-000000000001';
  const m = '00000000-0000-0000-0000-000000000002';
  const other = '00000000-0000-0000-0000-000000000003';
  const e = '00000000-0000-0000-0000-000000000004';
  const o = '00000000-0000-0000-0000-000000000005';
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,role_id uuid,email text);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,program_ticket_balances jsonb,training_fund_balance numeric,
        account_balance numeric,training_fund_allowed_role_ids jsonb);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,program_tag text,status text,event_state text,registration_closes_at timestamptz);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,event_id uuid,payment_method text,
        booking_group_reference text,booking_reference text,status text,attendee_email text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE program_ticket_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid,
        program_name text,transaction_type text,quantity numeric,member_email text,payment_method text,stripe_payment_intent_id text,
        purchase_order_number text,booking_reference text,discount_code_id uuid,discount_amount_applied numeric,
        total_cost_before_discount numeric,notes text,cancelled_at timestamptz,cancelled_by_member_email text,cancellation_reason text);
      CREATE TABLE discount_code(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean,expires_at timestamptz,
        max_usage_count integer,current_usage_count integer,organization_id uuid,member_id uuid,role_id uuid,member_group_id uuid);
      CREATE TABLE discount_code_usage(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,discount_code_id uuid,
        organization_id uuid NOT NULL,member_id uuid,usage_count numeric);
      CREATE TABLE training_fund_transaction(tenant_id uuid,organization_id uuid,type text,amount numeric,balance_before numeric,balance_after numeric,reason text);
      INSERT INTO tenant VALUES('${t}');
      INSERT INTO member VALUES('${m}','${t}',NULL,NULL,'owner@example.invalid'),('${other}','${t}',NULL,NULL,'other@example.invalid');
      INSERT INTO event VALUES('${e}','${t}','tag','active',NULL,NULL);
      INSERT INTO organization VALUES('${o}','${t}','{"tag":4}',0,0,'[]');
    `);
    sql(readFileSync(new URL('./202610200006_program_voucher_purchase.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('./202610200008_program_member_entitlements.sql', import.meta.url), 'utf8'));
    const quote = { tenantId: t, memberId: m, organizationId: null, programName: 'Programme', programTag: 'tag', tickets: 3,
      totalMinor: 0, grossMinor: 0, discountMinor: 0, discountId: null, trainingFundMinor: 0, remainingMinor: 0,
      voucherMinor: 0, voucherIds: [], manualOrder: false, binding: 'server-quote' };
    const purchase = `SELECT complete_program_credit_purchase('${t}','purchase','${JSON.stringify(quote)}','card',NULL,NULL)->>'success';`;
    assert.equal(sql(purchase), 'true');
    assert.equal(sql(purchase), 'true');
    assert.equal(sql('SELECT count(*) FROM program_ticket_transaction;'), '1');
    sql(`INSERT INTO program_member_entitlement(tenant_id,member_id,program_tag,balance)
      VALUES('00000000-0000-0000-0000-000000000099','${m}','forged',1);`,true);
    sql(`UPDATE program_member_entitlement SET member_id='${other}' WHERE member_id='${m}';`,true);
    const attemptId = reference => {
      const hex = createHash('sha256').update(reference).digest('hex').slice(0, 32);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    const book = (reference, bookings, owner = 'member', fingerprint = 'a'.repeat(64)) =>
      `SELECT consume_program_entitlement('${t}','${m}','${e}','${reference}','${JSON.stringify(bookings)}','${attemptId(reference)}','${fingerprint}','${owner}')->>'transaction_id';`;
    sql(book('bad', [{ status: 'confirmed' }]), true);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    assert.equal(sql('SELECT count(*) FROM booking;'), '0');
    const tx = sql(book('booking', [{ status: 'confirmed', attendee_email: 'owner@example.invalid' }, { status: 'confirmed', attendee_email: 'guest@example.invalid' }]));
    assert.equal(sql(book('booking', [{ status: 'confirmed', attendee_email: 'owner@example.invalid' }, { status: 'confirmed', attendee_email: 'guest@example.invalid' }])), tx);
    sql(book('booking', [{ status: 'confirmed', attendee_email: 'changed@example.invalid' }]), true);
    sql(book('booking', [{ status: 'confirmed', attendee_email: 'owner@example.invalid' }, { status: 'confirmed', attendee_email: 'guest@example.invalid' }], 'member', 'b'.repeat(64)), true);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '1');
    assert.equal(sql('SELECT count(*) FROM booking;'), '2');
    sql(book('overspend', [{ attendee_email: 'a' }, { attendee_email: 'b' }]), true);
    const cancel = member => `SELECT cancel_program_entitlement_usage('${t}','${member}','${tx}','test')->>'success';`;
    sql(cancel(other), true);
    // Membership moving into an organization must not redirect the personal refund.
    sql(`UPDATE member SET organization_id='${o}' WHERE id='${m}';`);
    assert.equal(sql(cancel(m)), 'true');
    assert.equal(sql(cancel(m)), 'true');
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '4');
    assert.equal(sql("SELECT count(*) FROM booking WHERE status='cancelled';"), '2');
    assert.equal(sql("SELECT has_function_privilege('authenticated','consume_program_entitlement(uuid,uuid,uuid,text,jsonb,uuid,text,text)','EXECUTE');"), 'f');
    assert.equal(sql("SELECT has_table_privilege('authenticated','program_member_entitlement','SELECT');"), 'f');
    // Existing organization behavior uses the same transactional consumer.
    sql(book('org-booking', [{ attendee_email: 'org@example.invalid' }], 'organization'));
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '3');
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    // Explicit personal selection still works after joining an organization.
    const personalTx = sql(book('joined-personal', [{ status: 'confirmed', attendee_email: 'personal@example.invalid' }], 'member'));
    assert.equal(sql(book('joined-personal', [{ status: 'confirmed', attendee_email: 'personal@example.invalid' }], 'member')), personalTx);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '2');
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '3');
    const personalBooking = sql(`SELECT id FROM booking WHERE program_entitlement_transaction_id='${personalTx}';`);
    // Existing cancellation paths update status: restoration shares that transaction.
    sql(`UPDATE booking SET status='cancelled' WHERE id='${personalBooking}';`);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    assert.equal(sql(`SELECT restore_program_booking_entitlement('${t}','${personalBooking}')->>'already_refunded';`), 'true');
    assert.equal(sql(`SELECT cancel_program_entitlement_usage('${t}','${m}','${personalTx}','retry')->>'already_cancelled';`), 'true');
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '3');
    sql('GRANT SELECT,UPDATE ON booking TO authenticated;');
    sql(`SET ROLE authenticated; UPDATE booking SET program_entitlement_refunded_at=NULL WHERE id='${personalBooking}';`, true);
    // Cancelling one attendee, then the group, restores each unit exactly once.
    const partialTx = sql(book('partial', [{ status: 'confirmed', attendee_email: 'one@example.invalid' }, { status: 'confirmed', attendee_email: 'two@example.invalid' }]));
    sql(`UPDATE booking SET status='cancelled' WHERE id=(SELECT id FROM booking WHERE program_entitlement_transaction_id='${partialTx}' ORDER BY id LIMIT 1);`);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '2');
    sql(`SELECT cancel_program_entitlement_usage('${t}','${m}','${partialTx}','rest');`);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    const concurrent = statement => new Promise((resolve, reject) => {
      const child = spawn('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At']);
      let output = '', error = '';
      child.stdout.on('data', value => { output += value; });
      child.stderr.on('data', value => { error += value; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
      child.stdin.end(statement);
    });
    const race = book('concurrent', [{ status: 'confirmed', attendee_email: 'race@example.invalid' }]);
    const raced = await Promise.all([concurrent(race), concurrent(race)]);
    assert.equal(raced[0], raced[1]);
    assert.equal(sql(`SELECT count(*) FROM booking WHERE program_entitlement_transaction_id='${raced[0]}';`), '1');
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '2');
    sql(`SELECT cancel_program_entitlement_usage('${t}','${m}','${raced[0]}','race cleanup');`);
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
    // Organisation provenance is equally immutable when a booker later leaves.
    const orgTx = sql(book('org-original-owner', [{ status: 'confirmed', attendee_email: 'org-owner@example.invalid' }], 'organization'));
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '2');
    sql(`UPDATE member SET organization_id=NULL WHERE id='${m}';
      UPDATE event SET program_tag='changed-tag' WHERE id='${e}';
      UPDATE booking SET status='cancelled' WHERE program_entitlement_transaction_id='${orgTx}';`);
    assert.equal(sql(`SELECT program_ticket_balances->>'tag' FROM organization WHERE id='${o}';`), '3');
    assert.equal(sql('SELECT balance FROM program_member_entitlement;'), '3');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup();
  }
});
