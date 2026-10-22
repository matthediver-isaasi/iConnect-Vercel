import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('membership funding SQL: atomic reservation, concurrent completion, cash binding and release', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('membership-voucher-');
  const clients = [];
  let started = false;
  const command = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 2; i++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect(); clients.push(client);
    }
    const [db, second] = clients;
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE system_settings(tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,role_id uuid);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,voucher_allowed_role_ids jsonb);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,status text,metadata jsonb,
        stripe_checkout_session_id text,gocardless_billing_request_id text,updated_at timestamptz);
      CREATE TABLE voucher(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        organization_id uuid NOT NULL,code text,value numeric,status text,expires_at timestamptz,
        issued_at timestamptz,valid_from timestamptz,description text,funding_source text,notes text,
        used_at timestamptz,created_by text);
      CREATE TABLE voucher_transaction(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        voucher_id uuid,organization_id uuid,member_id uuid,amount numeric,balance_before numeric,
        balance_after numeric,type text,booking_reference text,notes text,created_at timestamptz DEFAULT now());
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,
        member_id uuid,membership_year text,final_cost numeric,total_with_vat numeric,payment_status text,
        paid_at timestamptz,stripe_payment_intent_id text,payment_method text,status text,
        term_start_date date,scheduled_activation_date date,accounting_sync_status text,accounting_sync_error text,
        billing_agreement_id uuid,billing_period text,vat_amount numeric);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
        status text,expires_at timestamptz,final_cost numeric,currency text,cost_breakdown jsonb,membership_year text,
        stripe_payment_intent_id text,stripe_client_secret text,history_record_id uuid,paid_at timestamptz,updated_at timestamptz,
        token text UNIQUE,created_at timestamptz);
    `);
    for (const file of ['202610200001_individual_voucher_credit.sql',
      '202610200002_membership_voucher_quotes.sql', '202610200003_membership_voucher_settlement.sql',
      '202610200010_membership_voucher_monthly.sql', '202610200011_membership_checkout_provider_attempts.sql',
      '202610200012_membership_voucher_accounting_binding.sql',
      '202610200013_membership_fee_requote.sql', '202610200014_voucher_allocation_refunds.sql']) {
      try {
        await db.query(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
      } catch (error) {
        throw new Error(`${file}: ${error.message}; position=${error.position}; internal=${error.internalQuery || ''}`);
      }
    }
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const tenant = id(1), member = id(2), voucher = id(3), token = id(4), quote = id(5), history = id(6);
    await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [member, tenant]);
    await db.query("INSERT INTO system_settings VALUES($1,'individual_vouchers_enabled','true')", [tenant]);
    await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at,issued_at)
      VALUES($1,$2,$3,NULL,'personal',100,'active','2099-01-01',now())`, [voucher, tenant, member]);
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,membership_year,final_cost,total_with_vat,payment_status)
      VALUES($1,$2,$3,'2026',100,100,'unpaid')`, [history, tenant, member]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year,history_record_id)
      VALUES($1,$2,$3,'pending','2099-01-01',100,'GBP','{}','2026',$4)`, [token, tenant, member, history]);
    const quoteData = { grossMinor: 10000, creditMinor: 10000, cashMinor: 0, currency: 'GBP',
      allocations: [{ voucherId: voucher, amountMinor: 10000 }] };
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,'fingerprint',$5,'2099-01-01')`, [quote, tenant, token, member, quoteData]);
    const snapshot = { tenant_id: tenant, member_id: member, membership_year: '2026', total_with_vat: 100, final_cost: 100 };
    const reserve = client => client.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5) AS result',
      [tenant, token, quote, 'fingerprint', snapshot]);
    const [r1, r2] = await Promise.all([reserve(db), reserve(second)]);
    assert.equal(r1.rows[0].result.id, r2.rows[0].result.id);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1', [voucher])).rows[0].value), 0);
    const complete = client => client.query('SELECT membership_voucher_complete($1,$2,NULL,0,$3) AS result', [tenant, token, 'GBP']);
    await Promise.all([complete(db), complete(second)]);
    assert.equal((await db.query("SELECT count(*) FROM voucher_transaction WHERE type='booking_usage'")).rows[0].count, '1');
    const paid = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [history])).rows[0];
    assert.equal(paid.payment_status, 'paid');
    assert.equal(paid.stripe_payment_intent_id, null);
    assert.equal(Number(paid.total_with_vat), 100);
    await assert.rejects(db.query("SELECT membership_voucher_release($1,$2,NULL,'not_started')", [tenant, token]), /Paid membership/);
    const partialVoucher = id(13), partialToken = id(14), partialQuote = id(15), partialHistory = id(16);
    await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at,issued_at)
      VALUES($1,$2,$3,NULL,'partial',70,'active','2099-01-01',now())`, [partialVoucher, tenant, member]);
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,membership_year,final_cost,total_with_vat,payment_status)
      VALUES($1,$2,$3,'2027',100,100,'unpaid')`, [partialHistory, tenant, member]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year,history_record_id)
      VALUES($1,$2,$3,'pending','2099-01-01',100,'GBP','{}','2027',$4)`, [partialToken, tenant, member, partialHistory]);
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,'partial',$5,'2099-01-01')`, [partialQuote, tenant, partialToken, member,
      { ...quoteData, creditMinor: 7000, cashMinor: 3000, allocations: [{ voucherId: partialVoucher, amountMinor: 7000 }] }]);
    const partial = (await db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5) AS result',
      [tenant, partialToken, partialQuote, 'partial', { ...snapshot, membership_year: '2027' }])).rows[0].result;
    assert.equal(partial.funding.remainingMinor, 3000);
    await assert.rejects(db.query('SELECT membership_voucher_complete($1,$2,NULL,0,$3)',
      [tenant, partialToken, 'GBP']), /Cash evidence/);
    await db.query("UPDATE membership_voucher_settlement SET state='provider_pending',provider_payment_id='pi_cash',provider_attempted_at=now() WHERE id=$1", [partial.id]);
    await assert.rejects(db.query("SELECT membership_voucher_release($1,$2,NULL,'not_started')",
      [tenant, partialToken]), /Reconcile/);
    await db.query("SELECT membership_voucher_release($1,$2,'pi_cash','cancelled')", [tenant, partialToken]);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1', [partialVoucher])).rows[0].value), 70);
    const retryQuote = id(17);
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      SELECT $1,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at FROM membership_voucher_quote WHERE id=$2`, [retryQuote, partialQuote]);
    await db.query(`UPDATE membership_voucher_quote q SET quote=q.quote||jsonb_build_object('tokenUpdatedAt',t.updated_at)
      FROM membership_fee_token t WHERE q.id=$1 AND t.id=q.fee_token_id`, [retryQuote]);
    const retry = (await db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5) AS result',
      [tenant, partialToken, retryQuote, 'partial', { ...snapshot, membership_year: '2027' }])).rows[0].result;
    assert.notEqual(retry.id, partial.id);
    await db.query("UPDATE membership_voucher_settlement SET state='provider_pending',provider_payment_id='pi_retry',provider_attempted_at=now() WHERE id=$1", [retry.id]);
    await assert.rejects(db.query("SELECT membership_voucher_complete($1,$2,'pi_wrong',3000,'GBP')",
      [tenant, partialToken]), /Cash evidence/);
    await db.query("SELECT membership_voucher_complete($1,$2,'pi_retry',3000,'GBP')", [tenant, partialToken]);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1', [partialVoucher])).rows[0].value), 0);
    const partialPaid = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [partialHistory])).rows[0];
    assert.equal(partialPaid.payment_status, 'paid');
    assert.equal(partialPaid.stripe_payment_intent_id, 'pi_retry');
    assert.equal(Number(partialPaid.total_with_vat), 100);
    const newVoucher = id(23), newToken = id(24), newQuote = id(25);
    await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at,issued_at)
      VALUES($1,$2,$3,NULL,'new-membership',50,'active','2099-01-01',now())`, [newVoucher, tenant, member]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year)
      VALUES($1,$2,$3,'pending','2099-01-01',50,'GBP','{}','2028')`, [newToken, tenant, member]);
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,'new',$5,'2099-01-01')`, [newQuote, tenant, newToken, member,
      { grossMinor: 5000, creditMinor: 5000, cashMinor: 0, currency: 'GBP', allocations: [{ voucherId: newVoucher, amountMinor: 5000 }] }]);
    await db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5)', [tenant, newToken, newQuote, 'new',
      { ...snapshot, membership_year: '2028', final_cost: 50, total_with_vat: 50, status: 'active' }]);
    await db.query("SELECT membership_voucher_complete($1,$2,NULL,0,'GBP')", [tenant, newToken]);
    const inserted = (await db.query("SELECT * FROM member_membership_history WHERE membership_year='2028'")).rows;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].payment_status, 'paid');
    assert.equal(inserted[0].stripe_payment_intent_id, null);
    assert.equal(Number(inserted[0].total_with_vat), 50);
    for (const [index, mode, invoicingMode, credit] of [
      [0, 'stripe_monthly', 'annual', 4000], [1, 'stripe_monthly', 'per_instalment', 4000],
      [2, 'direct_debit', 'annual', 4000], [3, 'direct_debit', 'per_instalment', 4000],
      [4, 'stripe_monthly', 'per_instalment', 10000],
    ]) {
      const v = id(100 + index * 10), t = id(101 + index * 10), q = id(102 + index * 10), a = id(103 + index * 10);
      const year = String(2030 + index);
      await db.query(`INSERT INTO voucher(id,tenant_id,member_id,organization_id,code,value,status,expires_at,issued_at)
        VALUES($1,$2,$3,NULL,$4,$5,'active','2099-01-01',now())`, [v, tenant, member, `monthly-${index}`, credit / 100]);
      await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year)
        VALUES($1,$2,$3,'pending','2099-01-01',100,'GBP','{}',$4)`, [t, tenant, member, year]);
      const monthlySnapshot = { payment_mode: mode, instalment_count: 4, plan_total: 100,
        currency: 'GBP', membership_year: year, invoicing_mode: invoicingMode, accepted_at: '2098-01-31T00:00:00Z' };
      await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,member_id,fingerprint,quote,expires_at)
        VALUES($1,$2,$3,$4,'monthly',$5,'2099-01-01')`, [q, tenant, t, member,
        { grossMinor: 10000, creditMinor: credit, cashMinor: 10000 - credit, currency: 'GBP',
          monthlySnapshot, paymentMode: mode, allocations: [{ voucherId: v, amountMinor: credit }] }]);
      const reserved = (await db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5) AS result',
        [tenant, t, q, 'monthly', { ...snapshot, membership_year: year, __accounting: { vatRate: null } }])).rows[0].result;
      const prepared = (await db.query('SELECT membership_voucher_prepare_monthly($1,$2) AS result', [tenant, t])).rows[0].result;
      assert.equal(prepared.history_record_id != null, true);
      assert.equal(prepared.monthly_snapshot.invoicing_mode, invoicingMode);
      assert.equal((await db.query('SELECT status FROM membership_fee_token WHERE id=$1', [t])).rows[0].status, 'pending');
      await assert.rejects(db.query("SELECT membership_payment_term_guard($1,$2,NULL,$3,'another-entrypoint','create_payment')",
        [tenant, member, year]), /Another|another|different/);
      if (credit === 10000) {
        await db.query("SELECT membership_voucher_complete($1,$2,NULL,0,'GBP')", [tenant, t]);
        for (let ordinal = 1; ordinal <= 4; ordinal++) {
          const receipt = (await db.query("SELECT membership_voucher_claim_collection($1,$2,'voucher',$3,0,$4) AS result",
            [tenant, reserved.id, `voucher-only:${reserved.id}:${ordinal}`, `2098-0${ordinal}-28`])).rows[0].result;
          assert.equal(receipt.accounting_status, 'scheduled');
          assert.equal(receipt.ordinal, ordinal);
        }
      } else {
        await assert.rejects(db.query("SELECT membership_voucher_claim_collection($1,$2,'stripe','in_early',1500)",
          [tenant, reserved.id]), /not committed/);
        const namespace = mode === 'stripe_monthly' ? 'card' : 'dd';
        await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,metadata)
          VALUES($1,$2,$3,'active',$4)`, [a, tenant, member, { [namespace]: {
          ...monthlySnapshot, monthly_amount_minor: 1500, voucher_funding: { settlement_id: reserved.id },
        } }]);
        await db.query('SELECT membership_voucher_commit_monthly($1,$2,$3)', [tenant, reserved.id, a]);
        assert.equal((await db.query('SELECT payment_status FROM member_membership_history WHERE id=$1', [prepared.history_record_id])).rows[0].payment_status, 'unpaid');
        const provider = mode === 'stripe_monthly' ? 'stripe' : 'gocardless';
        const collect = (client, ordinal, amount = 1500) => client.query('SELECT membership_voucher_claim_collection($1,$2,$3,$4,$5) AS result',
          [tenant, reserved.id, provider, `provider-${index}-${ordinal}`, amount]);
        await assert.rejects(collect(db, 1, 2500), /does not match/);
        const [first, duplicate] = await Promise.all([collect(db, 1), collect(second, 1)]);
        assert.equal(first.rows[0].result.id, duplicate.rows[0].result.id);
        for (let ordinal = 2; ordinal <= 4; ordinal++) assert.equal((await collect(db, ordinal)).rows[0].result.ordinal, ordinal);
        await assert.rejects(collect(db, 5), /already have cash evidence/);
        await db.query('SELECT membership_voucher_commit_monthly($1,$2,$3)', [tenant, reserved.id, a]);
      }
      assert.equal((await db.query('SELECT status FROM membership_fee_token WHERE id=$1', [t])).rows[0].status, 'paid');
      assert.equal(Number((await db.query('SELECT total_with_vat FROM member_membership_history WHERE id=$1', [prepared.history_record_id])).rows[0].total_with_vat), 100);
      assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1', [v])).rows[0].value), 0);
      await assert.rejects(db.query('SELECT membership_voucher_release_monthly($1,$2,NULL,NULL)', [tenant, reserved.id]), /cancellation policy/);
    }
    await db.query('CREATE TABLE organisation_membership_history(LIKE member_membership_history INCLUDING DEFAULTS,organization_id uuid)');
    const org = id(200), role = id(201), orgVoucher = id(202), orgToken = id(203), orgQuote = id(204);
    await db.query('INSERT INTO organization(id,tenant_id,voucher_allowed_role_ids) VALUES($1,$2,$3)', [org, tenant, JSON.stringify([role])]);
    await db.query('UPDATE member SET organization_id=$1,role_id=$2 WHERE id=$3', [org, role, member]);
    await db.query(`INSERT INTO voucher(id,tenant_id,organization_id,code,value,status,expires_at,issued_at)
      VALUES($1,$2,$3,'org-membership',80,'active','2099-01-01',now())`, [orgVoucher, tenant, org]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,organization_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year)
      VALUES($1,$2,$3,'pending','2099-01-01',80,'GBP','{}','2040')`, [orgToken, tenant, org]);
    await db.query(`INSERT INTO membership_voucher_quote(id,tenant_id,fee_token_id,organization_id,authenticated_member_id,fingerprint,quote,expires_at)
      VALUES($1,$2,$3,$4,$5,'org',$6,'2099-01-01')`, [orgQuote, tenant, orgToken, org, member,
      { grossMinor: 8000, creditMinor: 8000, cashMinor: 0, currency: 'GBP', authenticatedMemberId: member,
        allocations: [{ voucherId: orgVoucher, amountMinor: 8000 }] }]);
    const orgSnapshot = { tenant_id: tenant, organization_id: org, membership_year: '2040', final_cost: 80, total_with_vat: 80 };
    await assert.rejects(db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5)',
      [tenant, orgToken, orgQuote, 'org', orgSnapshot]), /authority|authenticated/i);
    await db.query('SELECT membership_voucher_reserve($1,$2,$3,$4,$5,$6)', [tenant, orgToken, orgQuote, 'org', orgSnapshot, member]);
    await db.query("SELECT membership_voucher_complete($1,$2,NULL,0,'GBP')", [tenant, orgToken]);
    const orgPaid = (await db.query('SELECT * FROM organisation_membership_history WHERE organization_id=$1', [org])).rows[0];
    assert.equal(orgPaid.payment_status, 'paid');
    assert.equal(orgPaid.stripe_payment_intent_id, null);
    assert.equal(Number(orgPaid.total_with_vat), 80);
    const orgAllocation = (await db.query('SELECT id FROM voucher_credit_allocation WHERE voucher_id=$1',[orgVoucher])).rows[0].id;
    const refund = (amount) => db.query("SELECT voucher_credit_refund_allocation($1,$2,'approved-refund',$3,'{}') AS result",
      [tenant,orgAllocation,amount]);
    await refund(2000); await refund(2000);
    assert.equal(Number((await db.query('SELECT value FROM voucher WHERE id=$1',[orgVoucher])).rows[0].value),20);
    await assert.rejects(refund(9000),/exceeds/);
    const individualAllocation = (await db.query('SELECT id FROM voucher_credit_allocation WHERE voucher_id=$1',[id(100)])).rows[0].id;
    await db.query("UPDATE system_settings SET setting_value='false' WHERE setting_key='individual_vouchers_enabled'");
    await db.query("UPDATE voucher SET expires_at='2020-01-01' WHERE id=$1",[id(100)]);
    await assert.rejects(db.query("SELECT voucher_credit_refund_allocation($1,$2,'expired-refund',1000,'{}')",
      [tenant,individualAllocation]),/replacement expiry/);
    const options = { voucherReplacements: [{ voucherId:id(100),newExpiryDate:'2099-01-01' }] };
    const restored = (await db.query("SELECT voucher_credit_refund_allocation($1,$2,'expired-refund',1000,$3) AS result",
      [tenant,individualAllocation,options])).rows[0].result;
    const replacement = (await db.query('SELECT * FROM voucher WHERE id=$1',[restored.replacementVoucherId])).rows[0];
    assert.equal(replacement.member_id,member);
    assert.equal(replacement.organization_id,null);
    assert.equal(Number(replacement.value),10);
    await db.query("SELECT voucher_credit_refund_allocation($1,$2,'expired-refund',1000,$3)",[tenant,individualAllocation,options]);
    assert.equal((await db.query("SELECT count(*) FROM voucher WHERE code LIKE 'REFUND-%'")).rows[0].count,'1');
    const unattemptedPurchase = (await db.query('SELECT id FROM membership_voucher_settlement WHERE fee_token_id=$1',[orgToken])).rows[0].id;
    const binding = { provider:'xero',connectionId:'connection',companyId:'company',environment:null };
    await db.query('SELECT membership_voucher_pin_accounting($1,$2,$3)',[tenant,unattemptedPurchase,binding]);
    await assert.rejects(db.query('SELECT membership_voucher_pin_accounting($1,$2,$3)',
      [tenant,unattemptedPurchase,{ ...binding,companyId:'changed' }]),/company changed/);
    const oldQuoteToken=id(210), oldQuoteHistory=id(211);
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,membership_year,final_cost,total_with_vat,payment_status)
      VALUES($1,$2,$3,'2042',100,100,'unpaid')`,[oldQuoteHistory,tenant,member]);
    await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,expires_at,final_cost,currency,cost_breakdown,membership_year,history_record_id)
      VALUES($1,$2,$3,'pending','2099-01-01',100,'GBP','{}','2042',$4)`,[oldQuoteToken,tenant,member,oldQuoteHistory]);
    const replacementBreakdown = { totalWithVat:120, membershipVoucherRequote:{ predecessorTokenId:oldQuoteToken,paymentMode:'stripe_monthly' } };
    const regenerate = () => db.query('SELECT membership_fee_regenerate_quote($1,$2,NULL,$3,120,$4) AS result',
      [tenant,oldQuoteToken,'a'.repeat(64),replacementBreakdown]);
    const generated=(await regenerate()).rows[0].result;
    assert.equal((await regenerate()).rows[0].result.id,generated.id);
    assert.equal(Number(generated.final_cost),120);
    assert.equal((await db.query('SELECT status FROM membership_fee_token WHERE id=$1',[oldQuoteToken])).rows[0].status,'cancelled');
    const audit = (await db.query('SELECT * FROM membership_fee_requote WHERE predecessor_token_id=$1',[oldQuoteToken])).rows[0];
    assert.equal(Number(audit.original_token.final_cost),100);
    assert.equal(Number(audit.original_history.total_with_vat),100);
    assert.equal(Number((await db.query('SELECT total_with_vat FROM member_membership_history WHERE id=$1',[oldQuoteHistory])).rows[0].total_with_vat),120);
    await db.query("SELECT membership_payment_term_guard($1,$2,NULL,'2041','portal:test','create_payment')", [tenant, member]);
    await db.query("SELECT membership_payment_start_provider($1,'portal:test',$2)", [tenant, { amount: 10000, currency: 'gbp' }]);
    await assert.rejects(db.query("SELECT membership_payment_start_provider($1,'portal:test',$2)", [tenant, { amount: 9000, currency: 'gbp' }]), /price changed/);
    await db.query("UPDATE membership_payment_term_claim SET provider_attempted_at=now()-interval '25 hours' WHERE source_key='portal:test'");
    await assert.rejects(db.query("SELECT membership_payment_start_provider($1,'portal:test',$2)", [tenant, { amount: 10000, currency: 'gbp' }]), /Uncertain provider/);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query("SELECT voucher_credit_refund_allocation($1,$2,'forged',1,'{}')",[tenant,orgAllocation]),/permission denied/);
    await assert.rejects(db.query('SELECT membership_fee_regenerate_quote($1,$2,NULL,$3,120,$4)',
      [tenant,oldQuoteToken,'a'.repeat(64),replacementBreakdown]),/permission denied/);
    await assert.rejects(db.query('SELECT membership_voucher_complete($1,$2,NULL,0,$3)', [tenant, token, 'GBP']), /permission denied/);
    await db.query('RESET ROLE');
  } finally {
    await Promise.all(clients.map(client => client.end()));
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
