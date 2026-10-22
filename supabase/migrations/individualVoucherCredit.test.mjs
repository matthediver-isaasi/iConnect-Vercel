import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('disposable PostgreSQL voucher ownership, grants, idempotency, concurrency and reversals', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('voucher-5241-');
  const run = (cmd, args, input, fail = false) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (fail) assert.notEqual(r.status, 0, 'unsafe statement should fail');
    else assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const args = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = (input, fail = false) => run('psql', args, input, fail);
  const asyncSql = input => new Promise(resolve => {
    const child = spawn('psql', args); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stderr }));
    child.stdin.end(input);
  });
  const t = '00000000-0000-0000-0000-000000000001';
  const o = '00000000-0000-0000-0000-000000000002';
  const m = '00000000-0000-0000-0000-000000000003';
  const other = '00000000-0000-0000-0000-000000000004';
  const role = '00000000-0000-0000-0000-000000000005';
  const reserve = (key, ids, total = 10000, member = m, auth = null, currency = 'GBP') =>
    `SELECT voucher_credit_reserve('${t}','${key}','${member}',${auth ? `'${auth}'` : 'NULL'},ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}],${total},'${currency}',true,false);`;
  const transition = (key, action, outcome = null) =>
    `SELECT voucher_credit_transition('${t}','${key}','${action}',${outcome ? `'${outcome}'` : 'NULL'});`;
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,voucher_allowed_role_ids jsonb);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,role_id uuid);
      CREATE TABLE system_settings(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE voucher(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid NOT NULL,
        code text NOT NULL,value numeric NOT NULL,description text,expires_at timestamptz NOT NULL,
        issued_at timestamptz NOT NULL DEFAULT now(),valid_from timestamptz,status text DEFAULT 'active',
        used_at timestamptz,used_for_transaction_id uuid,funding_source text,notes text,created_by text);
      CREATE TABLE voucher_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),voucher_id uuid NOT NULL REFERENCES voucher(id) ON DELETE CASCADE,
        organization_id uuid,booking_reference text,event_id text,event_title text,member_id uuid,member_email text,
        amount numeric NOT NULL,balance_before numeric NOT NULL,balance_after numeric NOT NULL,type text NOT NULL DEFAULT 'usage',
        created_at timestamptz DEFAULT now(),tenant_id uuid NOT NULL,notes text);
      CREATE TABLE booking(id uuid PRIMARY KEY,tenant_id uuid,booking_reference text,booking_group_reference text,
        voucher_amount numeric,member_id uuid,organization_id uuid);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      ALTER TABLE complex_event_booking ADD COLUMN voucher_id uuid;
      INSERT INTO organization VALUES('${o}','${t}','["${role}"]');
      INSERT INTO member VALUES('${m}','${t}',NULL,NULL),('${other}','${t}','${o}','${role}');
    `);
    sql(readFileSync(new URL('./202610200001_individual_voucher_credit.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('./202610200004_booking_voucher_refunds.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('./202610200014_voucher_allocation_refunds.sql', import.meta.url), 'utf8'));
    assert.equal(sql(`SELECT has_function_privilege('anon','voucher_credit_result(uuid)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role','voucher_admin_write(uuid,uuid,text,jsonb,text,text)','EXECUTE');`), 't');
    sql(`SET ROLE authenticated; SELECT * FROM voucher;`, true);
    sql(`SET ROLE anon; SELECT * FROM voucher_credit_allocation;`, true);
    const issue = (key, owner, value = 100) => `SELECT voucher_admin_write('${t}',NULL,'issue',
      '${JSON.stringify({ ...owner, code: key, value, expires_at: '2099-01-01' })}'::jsonb,'admin','${key}')->>'id';`;
    sql(issue('off', { member_id: m }), true);
    sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','individual_vouchers_enabled','true'),
      ('${t}','member_voucher_display_name',' Personal Credit ');`);
    sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','individual_vouchers_enabled','false');`, true);
    for (const key of ['xero_voucher_clearing_account_code','quickbooks_voucher_clearing_account_id',
      'xero_training_fund_clearing_account_code','quickbooks_training_fund_clearing_account_id',
      'xero_program_sales_account_code','quickbooks_program_sales_item_id',
      'xero_program_tax_code','quickbooks_program_tax_code','program_price_vat_rate_percent']) {
      sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','${key}','fixture');`);
      sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value) VALUES('${t}','${key}','duplicate');`,true);
      sql(`INSERT INTO system_settings(tenant_id,setting_key,setting_value)
        VALUES('00000000-0000-0000-0000-000000000098','${key}','independent-tenant');`);
    }
    const v = sql(issue('personal', { member_id: m }));
    assert.equal(sql(issue('personal', { member_id: m })), v);
    const orgV = sql(issue('org', { organization_id: o }));
    sql(`INSERT INTO member VALUES('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000098',NULL,NULL);`);
    sql(issue('cross-tenant', { member_id: '00000000-0000-0000-0000-000000000099' }), true);
    sql(issue('both', { member_id: m, organization_id: o }), true);
    sql(`UPDATE voucher SET member_id='${other}' WHERE id='${v}';`, true);
    sql(`UPDATE voucher SET value=999 WHERE id='${v}';`, true);
    sql(reserve('wrong-owner', [v], 1000, other), true);
    sql(reserve('wrong-currency', [v], 1000, m, null, 'EUR'), true);
    sql(reserve('duplicate', [v, v], 1000), true);
    sql(`SELECT voucher_admin_write('${t}','${v}','update','{"valid_from":"2098-01-01"}','admin','future');`);
    sql(reserve('future-credit', [v], 1000), true);
    sql(`SELECT voucher_admin_write('${t}','${v}','update','{"valid_from":null}','admin','unfuture');`);
    sql(reserve('org-bearer', [orgV], 1000, other), true);
    sql(`UPDATE member SET role_id=NULL WHERE id='${other}';`);
    sql(reserve('org-role', [orgV], 1000, other, other), true);
    sql(`UPDATE member SET role_id='${role}' WHERE id='${other}';`);
    sql(reserve('org-authorized', [orgV], 1000, other, other));
    sql(transition('org-authorized', 'release', 'not_started'));
    const result = JSON.parse(sql(reserve('purchase', [v], 3000)));
    assert.equal(result.voucherMinor, 3000);
    assert.equal(result.allocations[0].displayName, 'Personal Credit');
    assert.equal(sql(`SELECT value FROM voucher WHERE id='${v}';`), '70.0000000000000000');
    assert.deepEqual(JSON.parse(sql(reserve('purchase', [v], 3000))), result);
    sql(reserve('purchase', [v], 4000), true);
    sql(`SELECT voucher_admin_write('${t}','${v}','update','{"value":90}','admin','adjust-during-hold');`, true);
    sql(transition('purchase', 'release', 'pending'), true);
    sql(transition('purchase', 'commit'));
    sql(transition('purchase', 'commit'));
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${v}' AND type='booking_usage';`), '1');
    sql(transition('purchase', 'release', 'failed'), true);
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    sql(reserve('off-new', [v], 1000), true);
    sql(transition('purchase', 'release', 'refunded'));
    sql(transition('purchase', 'release', 'refunded'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)), 100);
    sql(transition('purchase', 'commit'), true);
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    // Two separate DB sessions race a full-balance request: exactly one wins.
    const races = await Promise.all([asyncSql(reserve('race-a', [v])), asyncSql(reserve('race-b', [v]))]);
    assert.equal(races.filter(r => r.status === 0).length, 1, JSON.stringify(races));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${v}';`)), 0);
    const winner = races[0].status === 0 ? 'race-a' : 'race-b';
    sql(transition(winner, 'release', 'failed'));
    sql(`SELECT voucher_admin_write('${t}','${v}','update','{"value":90}','admin','adjust');`);
    sql(`SELECT voucher_admin_write('${t}','${v}','update','{"value":90}','admin','adjust');`);
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${v}' AND type='debit_adjustment';`), '1');
    sql(`SELECT voucher_admin_write('${t}','${v}','delete','{}','admin','delete-used');`, true);
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${v}' AND owner_member_id='${m}';`),
      sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${v}';`));
    const expire = (id, key) => `SELECT voucher_admin_write('${t}','${id}','expire','{}','expiry-cron','${key}');`;
    sql(expire(v, 'too-early'), true);
    // Active holds cannot be expired even if the date has since elapsed.
    sql(reserve('expiry-held', [v], 1000));
    sql(`UPDATE voucher SET expires_at=now()-interval '1 day' WHERE id='${v}';`);
    sql(expire(v, 'held-expiry'), true);
    sql(transition('expiry-held', 'release', 'failed'));
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    const expired = JSON.parse(sql(expire(v, 'expiry')));
    assert.equal(expired.status, 'expired');
    assert.equal(expired.value, 0);
    assert.deepEqual(JSON.parse(sql(expire(v, 'expiry'))), expired);
    sql(expire(v, 'expiry-another-run'));
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${v}' AND type='expiry';`), '1');
    assert.equal(Number(sql(`SELECT amount FROM voucher_transaction WHERE voucher_id='${v}' AND type='expiry';`)), 90);
    assert.equal(sql(`SELECT owner_display_name FROM voucher_transaction WHERE voucher_id='${v}' AND type='expiry';`), 'Personal Credit');
    sql(`UPDATE voucher SET expires_at=now()-interval '1 day' WHERE id='${orgV}';`);
    sql(expire(orgV, 'org-expiry'));
    assert.equal(sql(`SELECT organization_id FROM voucher_transaction WHERE voucher_id='${orgV}' AND type='expiry';`), o);
    // Owner-preserving booking cancellation, bounded by booking and group usage.
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    const cancelV = sql(issue('cancel-credit', { member_id: m }));
    sql(reserve('cancel-group', [cancelV], 10000));
    sql(transition('cancel-group', 'commit'));
    const b1 = '00000000-0000-0000-0000-000000000011';
    const b2 = '00000000-0000-0000-0000-000000000012';
    const b3 = '00000000-0000-0000-0000-000000000013';
    sql(`INSERT INTO booking VALUES('${b1}','${t}','cancel-1','cancel-group',30,'${m}',NULL),
      ('${b2}','${t}','cancel-2','cancel-group',80,'${m}',NULL),
      ('${b3}','${t}','cancel-3','cancel-group',20,'${m}',NULL);`);
    const refund = (id, allocation = {}, options = {}, source = 'booking') =>
      `SELECT voucher_credit_refund_booking('${t}','${id}','${source}','${JSON.stringify(allocation)}','${JSON.stringify(options)}');`;
    sql(`UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    // Moving the member to an organization does not transfer the original credit.
    sql(`UPDATE member SET organization_id='${o}' WHERE id='${m}';`);
    const firstRefund = JSON.parse(sql(refund(b1)));
    assert.equal(firstRefund.vouchers[0].amount, 30);
    assert.deepEqual(JSON.parse(sql(refund(b1))), firstRefund);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${cancelV}';`)), 30);
    assert.equal(sql(`SELECT owner_member_id FROM voucher_transaction WHERE voucher_id='${cancelV}' AND type='cancellation_refund';`), m);
    // Group-level compensation restores only remaining units, not the 30 above.
    sql(transition('cancel-group', 'release', 'refunded'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${cancelV}';`)), 100);
    assert.equal(JSON.parse(sql(refund(b2))).vouchers[0].amount, 0);
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';`);
    const replacementV = sql(issue('replace-credit', { member_id: m }));
    sql(reserve('replace-group', [replacementV], 10000));
    sql(transition('replace-group', 'commit'));
    sql(`UPDATE booking SET booking_group_reference='replace-group',voucher_amount=30 WHERE id='${b3}';
      UPDATE voucher SET expires_at=now()-interval '1 day' WHERE id='${replacementV}';
      UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled';`);
    assert.equal(JSON.parse(sql(refund(b3))).vouchers[0].expired, true);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${replacementV}';`)), 0);
    const replacementOptions = { voucherReplacements: [{ voucherId: replacementV, newExpiryDate: '2099-01-01' }] };
    const replacementResult = JSON.parse(sql(refund(b3, { vouchers: { [replacementV]: 10 } }, replacementOptions)));
    const replacementId = replacementResult.vouchers[0].newVoucherId;
    assert.equal(replacementResult.vouchers[0].amount, 10);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${replacementId}';`)), 10);
    assert.equal(sql(`SELECT member_id FROM voucher WHERE id='${replacementId}';`), m);
    sql(refund(b3, { vouchers: { [replacementV]: 30 } }, replacementOptions));
    assert.equal(sql(`SELECT count(*) FROM voucher_booking_refund WHERE booking_id='${b3}';`), '1');
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${replacementId}';`)), 10);
    assert.equal(sql(`SELECT has_function_privilege('authenticated','voucher_credit_refund_booking(uuid,uuid,text,jsonb,jsonb)','EXECUTE');`), 'f');
    // Concurrent sibling cancellations share a 100 original-usage ceiling,
    // although each booking's own historical voucher amount claims 60.
    const complexV = sql(issue('complex-cancel-credit', { organization_id: o }));
    sql(reserve('complex-cancel-group', [complexV], 10000, other, other));
    sql(transition('complex-cancel-group', 'commit'));
    sql(`INSERT INTO complex_event_booking VALUES
      ('${b1}','${t}','complex-cancel-1','complex-cancel-group',60,'${other}','${o}','${complexV}'),
      ('${b2}','${t}','complex-cancel-2','complex-cancel-group',60,'${other}','${o}','${complexV}');`);
    const cancellationRaces = await Promise.all([
      asyncSql(refund(b1, {}, {}, 'complex_event_booking')),
      asyncSql(refund(b2, {}, {}, 'complex_event_booking')),
    ]);
    assert.ok(cancellationRaces.every(r => r.status === 0), JSON.stringify(cancellationRaces));
    assert.equal(Number(sql(`SELECT sum(amount) FROM voucher_transaction WHERE voucher_id='${complexV}' AND type='cancellation_refund';`)), 100);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${complexV}';`)), 100);
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${complexV}' AND type='cancellation_refund' AND organization_id='${o}';`), '2');
    sql(`UPDATE booking SET booking_group_reference='missing-provenance' WHERE id='${b2}';`);
    sql(refund(b2), true);
    sql(`SELECT voucher_credit_refund_booking('00000000-0000-0000-0000-000000000098','${b1}','booking','{}','{}');`, true);
    // Same cron key (voucher+expiry date) must reconcile restored credit, not
    // return a stale cached expiry result after legitimate group compensation.
    const cycleV = sql(issue('expiry-cycle', { organization_id: o }));
    sql(reserve('expiry-cycle-purchase', [cycleV], 3000, other, other));
    sql(transition('expiry-cycle-purchase', 'commit'));
    sql(`UPDATE voucher SET expires_at=now()-interval '1 day' WHERE id='${cycleV}';`);
    sql(expire(cycleV, 'stable-expiry-key'));
    assert.equal(Number(sql(`SELECT amount FROM voucher_transaction WHERE voucher_id='${cycleV}' AND type='expiry';`)), 70);
    sql(transition('expiry-cycle-purchase', 'release', 'refunded'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${cycleV}';`)), 30);
    const expiryRace = await Promise.all([
      asyncSql(expire(cycleV, 'stable-expiry-key')),
      asyncSql(expire(cycleV, 'stable-expiry-key')),
    ]);
    assert.ok(expiryRace.every(r => r.status === 0), JSON.stringify(expiryRace));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${cycleV}';`)), 0);
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${cycleV}' AND type='expiry';`), '2');
    assert.equal(Number(sql(`SELECT sum(amount) FROM voucher_transaction WHERE voucher_id='${cycleV}' AND type='expiry';`)), 100);
    sql(expire(cycleV, 'stable-expiry-key'));
    assert.equal(sql(`SELECT count(*) FROM voucher_transaction WHERE voucher_id='${cycleV}' AND type='expiry';`), '2');
    const mixedV = sql(issue('mixed-refund-race', { organization_id: o }));
    const mixedPurchase = JSON.parse(sql(reserve('mixed-refund-race', [mixedV], 10000, other, other)));
    sql(transition('mixed-refund-race', 'commit'));
    const mixedAllocation = mixedPurchase.allocations[0].id;
    sql(`UPDATE booking SET booking_reference='mixed-booking',booking_group_reference='mixed-refund-race',
      voucher_amount=60 WHERE id='${b2}';`);
    const mixedRace = await Promise.all([
      asyncSql(refund(b2)),
      asyncSql(`SELECT voucher_credit_refund_allocation('${t}','${mixedAllocation}','mixed-allocation',6000,'{}');`),
    ]);
    assert.equal(mixedRace[0].status, 0, JSON.stringify(mixedRace));
    const mixedRestored = Number(sql(`SELECT sum(amount) FROM voucher_transaction
      WHERE allocation_id='${mixedAllocation}' AND type='cancellation_refund';`));
    assert.ok(mixedRestored>=60 && mixedRestored<=100);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${mixedV}';`)), mixedRestored);
    sql(transition('mixed-refund-race', 'release', 'refunded'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${mixedV}';`)),100);
    // Complex legacy voucher_id names only the first voucher, but durable new
    // allocation provenance must restore BOTH personal and organization credit.
    sql(`UPDATE system_settings SET setting_value='true' WHERE setting_key='individual_vouchers_enabled';
      UPDATE member SET organization_id='${o}',role_id='${role}' WHERE id='${m}';`);
    const personalTen = sql(issue('mixed-personal-ten', { member_id: m },10));
    const orgTen = sql(issue('mixed-org-ten', { organization_id: o },10));
    sql(reserve('complex-mixed-20', [personalTen,orgTen],2000,m,m));
    sql(transition('complex-mixed-20','commit'));
    const singleMixed = '00000000-0000-0000-0000-000000000021';
    sql(`INSERT INTO complex_event_booking VALUES('${singleMixed}','${t}','mixed-twenty','complex-mixed-20',20,'${m}','${o}','${personalTen}');`);
    const mixedResult = JSON.parse(sql(refund(singleMixed,{}, {},'complex_event_booking')));
    assert.equal(mixedResult.vouchers.filter(row=>row.success && !row.skipped).length,2);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${personalTen}';`)),10);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${orgTen}';`)),10);
    // 2002 pennies over 3 attendees: cumulative rounding freezes 667/668/667.
    // Voucher intervals also reconcile to exactly 1001 personal + 1001 org.
    const oddPersonal = sql(issue('odd-personal', { member_id: m },10.01));
    const oddOrg = sql(issue('odd-org', { organization_id: o },10.01));
    sql(reserve('odd-penny-group',[oddPersonal,oddOrg],2002,m,m));
    sql(transition('odd-penny-group','commit'));
    const oddBookings = ['22','23','24'].map(n=>`00000000-0000-0000-0000-0000000000${n}`);
    for(const [i,id] of oddBookings.entries()) sql(`INSERT INTO complex_event_booking
      VALUES('${id}','${t}','odd-${i}','odd-penny-group',20.02/3,'${m}','${o}','${oddPersonal}');`);
    const oddRaces=await Promise.all([
      asyncSql(refund(oddBookings[2],{}, {},'complex_event_booking')),
      asyncSql(refund(oddBookings[0],{}, {},'complex_event_booking')),
    ]);
    assert.ok(oddRaces.every(r=>r.status===0),JSON.stringify(oddRaces));
    sql(refund(oddBookings[1],{}, {},'complex_event_booking'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${oddPersonal}';`)),10.01);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${oddOrg}';`)),10.01);
    assert.equal(sql(`SELECT string_agg(total::text,',' ORDER BY booking_id) FROM
      (SELECT s.booking_id,sum(s.amount_minor)::bigint total FROM voucher_booking_credit_share s
       JOIN voucher_credit_allocation a ON a.id=s.allocation_id JOIN voucher_credit_purchase p ON p.id=a.purchase_id
       WHERE p.purchase_key='odd-penny-group' GROUP BY s.booking_id) x;`),'667,668,667');
    const finalRace=await Promise.all([
      asyncSql(refund(oddBookings[1],{}, {},'complex_event_booking')),
      asyncSql(transition('odd-penny-group','release','refunded')),
    ]);
    assert.ok(finalRace.every(r=>r.status===0),JSON.stringify(finalRace));
    assert.equal(Number(sql(`SELECT sum(value) FROM voucher WHERE id IN ('${oddPersonal}','${oddOrg}');`)),20.02);
    // Genuine old single-voucher complex provenance has no durable allocation.
    // Preserve its voucher_id restriction rather than broadening legacy policy.
    const legacyFirst = sql(issue('legacy-first',{organization_id:o},0));
    const legacyOther = sql(issue('legacy-other',{organization_id:o},0));
    const legacyBooking='00000000-0000-0000-0000-000000000025';
    sql(`INSERT INTO complex_event_booking VALUES('${legacyBooking}','${t}','legacy-single','legacy-single',20,'${m}','${o}','${legacyFirst}');
      INSERT INTO voucher_transaction(voucher_id,tenant_id,organization_id,booking_reference,amount,balance_before,balance_after,type)
      VALUES('${legacyFirst}','${t}','${o}','legacy-single',10,10,0,'booking_usage'),
        ('${legacyOther}','${t}','${o}','legacy-single',10,10,0,'booking_usage');`);
    sql(refund(legacyBooking,{}, {},'complex_event_booking'));
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${legacyFirst}';`)),10);
    assert.equal(Number(sql(`SELECT value FROM voucher WHERE id='${legacyOther}';`)),0);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
