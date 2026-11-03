import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRollingCommitment } from '../../api/_lib/rollingMembershipCommitment.js';

// Installs only the ledger shapes required by the date-writer contract.
// Voucher debit/credit machinery has its own real-migration suite; these stubs
// must not be interpreted as tests of consuming or completing voucher funds.
export async function exerciseFundedDateContract(db, { tenant, member, election, reservation, history, agreement, expected, paid }) {
  await db.query(`
    CREATE TABLE membership_fee_token(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,
      status text,cost_breakdown jsonb,history_record_id uuid);
    CREATE TABLE membership_voucher_settlement(id uuid PRIMARY KEY,tenant_id uuid,fee_token_id uuid,state text,
      funding jsonb,monthly_snapshot jsonb,billing_agreement_id uuid,history_record_id uuid,
      provider_payment_id text,history_snapshot jsonb);
    CREATE TABLE form_membership_voucher_checkout(fee_token_id uuid,tenant_id uuid,member_id uuid,election_id uuid,released_at timestamptz);
    CREATE TABLE membership_variable_voucher_slice(id uuid,tenant_id uuid,settlement_id uuid,ordinal integer,
      reservation_id uuid,state text,gross_minor bigint,credit_minor bigint,cash_minor bigint,settled_at timestamptz);
    CREATE TABLE gocardless_collection_reservations(id uuid,tenant_id uuid,plan_id uuid,amount_minor bigint,gocardless_payment_id text);
    CREATE TABLE membership_voucher_collection(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE FUNCTION membership_voucher_complete(uuid,uuid,text,bigint,text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Completion is not exercised by the date contract fixture'; END $$;
    CREATE FUNCTION membership_variable_voucher_settle_collection(uuid,uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Collection consumption is not exercised by the date contract fixture'; END $$;
  `);
  try {
    await db.query(readFileSync(new URL('../../supabase/migrations/202611090001_form_voucher_payment_evidence.sql', import.meta.url), 'utf8'));
  } catch (error) {
    throw new Error(`${error.message}; position=${error.position}; internalPosition=${error.internalPosition}; where=${error.where}; internalQuery=${error.internalQuery}`);
  }
  // Compile the routing repair against the real function bodies too.
  const functionBody = (file, name) => {
    const sql = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
    const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
    assert.ok(start >= 0);
    const end = sql.indexOf('END $$;', start);
    assert.ok(end > start);
    return sql.slice(start, end + 'END $$;'.length);
  };
  await db.query(functionBody('202611080001_form_membership_voucher_checkout.sql', 'bind_form_membership_voucher_checkout'));
  await db.query(functionBody('202610230001_membership_variable_voucher.sql', 'membership_variable_voucher_bind'));
  await db.query(functionBody('202610230001_membership_variable_voucher.sql', 'membership_variable_voucher_settle_collection')
    .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
    .replace('public.membership_variable_voucher_settle_collection(', 'public.membership_variable_voucher_settle_before_restart_dates('));
  await db.query(readFileSync(new URL('../../supabase/migrations/202611090002_form_voucher_renewal_routing.sql', import.meta.url), 'utf8'));
  await db.query(readFileSync(new URL('../../supabase/migrations/202611090003_form_voucher_connected_readiness.sql', import.meta.url), 'utf8'));
  assert.equal((await db.query('SELECT form_membership_voucher_checkout_ready_v2() ready')).rows[0].ready, true);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await db.query("SELECT has_function_privilege($1,'form_membership_voucher_checkout_ready_v2()','EXECUTE') allowed", [role])).rows[0].allowed, role === 'service_role');
  }
  const token = '00000000-0000-4000-8000-000000000901';
  const settlement = '00000000-0000-4000-8000-000000000902';
  await db.query(`INSERT INTO membership_fee_token(id,tenant_id,member_id,status,cost_breakdown)
    VALUES($1,$2,$3,'pending','{}');
  `, [token, tenant, member]);
  await db.query(`INSERT INTO form_membership_voucher_checkout VALUES($1,$2,$3,$4,NULL)`,
    [token, tenant, member, election]);
  await assert.rejects(db.query("UPDATE membership_successor_election SET status='released' WHERE id=$1", [election]), /bound credit checkout/);
  await db.query(`INSERT INTO membership_voucher_settlement
    (id,tenant_id,fee_token_id,state,funding,monthly_snapshot,billing_agreement_id,history_record_id)
    VALUES($1,$2,$3,'plan_committed',
      '{"payableMinor":15600,"voucherMinor":3600,"remainingMinor":12000,"currency":"GBP"}',
      '{"instalment_count":12}',$4,$5)`, [settlement, tenant, token, agreement, history]);
  const call = (cash = 1000, before = expected, reference = 'PM-funded') =>
    db.query(`SELECT apply_post_grace_funded_dates($1,$2,$3,$4,'gocardless',$5,'confirmed',$6,$7,'GBP',$8) receipt`,
      [tenant, member, reservation, settlement, reference, paid, cash, before]);
  await assert.rejects(call(999), /Cash and credit do not reconcile/);
  await assert.rejects(call(1000, { ...expected, history: { ...expected.history, total_with_vat: 999 } }), /changed/);
  assert.equal((await db.query('SELECT count(*) n FROM membership_post_grace_funding_evidence')).rows[0].n, '0');
  assert.equal((await db.query('SELECT status FROM membership_post_grace_renewal WHERE id=$1', [reservation])).rows[0].status, 'reserved');
  await db.query('BEGIN');
  try {
    const first = (await call()).rows[0].receipt;
    assert.equal(first.state, 'applied');
    assert.deepEqual((await call()).rows[0].receipt, first);
    const proof = (await db.query('SELECT cash_minor,credit_minor,gross_minor FROM membership_post_grace_funding_evidence')).rows[0];
    assert.deepEqual(proof, { cash_minor: '1000', credit_minor: '300', gross_minor: '1300' });
    assert.equal(Number((await db.query('SELECT total_with_vat FROM member_membership_history WHERE id=$1', [history])).rows[0].total_with_vat), 156);
  } finally { await db.query('ROLLBACK'); }
  // A voucher-only first variable period is a genuine financial event, not a
  // fabricated GoCardless payment. It must retain the separate credit proof.
  await db.query('BEGIN');
  try {
    const collection = '00000000-0000-4000-8000-000000000903';
    await db.query(`UPDATE membership_voucher_settlement SET funding=
      '{"variableCredit":true,"payableMinor":null,"remainingMinor":null,"voucherMinor":15600,"currency":"GBP"}' WHERE id=$1`, [settlement]);
    await db.query(`INSERT INTO gocardless_collection_reservations VALUES($1,$2,$3,0,NULL)`,
      [collection, tenant, expected.plan.id]);
    await db.query(`INSERT INTO membership_variable_voucher_slice
      VALUES(gen_random_uuid(),$1,$2,1,$3,'settled',1300,1300,0,$4)`, [tenant, settlement, collection, paid]);
    const receipt = (await db.query(`SELECT apply_post_grace_funded_dates(
      $1,$2,$3,$4,'credit',$5,'fully_allocated',$6,0,'GBP',$7) receipt`,
    [tenant, member, reservation, settlement, `variable-voucher:${collection}`, paid, expected])).rows[0].receipt;
    assert.equal(receipt.state, 'applied');
    assert.equal((await db.query('SELECT payment_provider FROM membership_post_grace_renewal WHERE id=$1', [reservation])).rows[0].payment_provider, 'credit');
  } finally { await db.query('ROLLBACK'); }
  // Fully funded finite plans need no future provider arrangement.
  for (const cashMinor of [0, 12000]) {
  await db.query('BEGIN');
  try {
    // Exercise the actual legacy completion writer under the real immutable
    // and activation guards. Only its credit-ledger boundary is substituted;
    // real voucher-ledger arithmetic is tested in the settlement suite.
    await db.query(`
      ALTER TABLE member_membership_history ADD COLUMN final_cost numeric,
        ADD COLUMN config_id uuid, ADD COLUMN annual_cost numeric, ADD COLUMN vat_amount numeric, ADD COLUMN currency text,
        ADD COLUMN paid_at timestamptz, ADD COLUMN scheduled_activation_date date,
        ADD COLUMN stripe_payment_intent_id text, ADD COLUMN payment_method text,
        ADD COLUMN accounting_sync_status text, ADD COLUMN accounting_sync_error text;
      ALTER TABLE membership_fee_token ADD COLUMN paid_at timestamptz,
        ADD COLUMN stripe_payment_intent_id text, ADD COLUMN updated_at timestamptz;
      ALTER TABLE membership_voucher_settlement ADD COLUMN purchase_key text, ADD COLUMN updated_at timestamptz;
      ALTER TABLE membership_payment_quote ADD COLUMN IF NOT EXISTS term_key text,
        ADD COLUMN IF NOT EXISTS organization_id uuid, ADD COLUMN IF NOT EXISTS member_id uuid,
        ADD COLUMN IF NOT EXISTS quote jsonb, ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
      CREATE TABLE fixture_credit_commit(purchase_key text PRIMARY KEY, calls int);
      CREATE FUNCTION voucher_credit_transition(uuid,text,text,text) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
       INSERT INTO fixture_credit_commit VALUES($2,1)
        ON CONFLICT(purchase_key) DO UPDATE SET calls=fixture_credit_commit.calls+1;
       RETURN '{}'::jsonb;
      END $$;`);
    await db.query(functionBody('202610200003_membership_voucher_settlement.sql', 'membership_voucher_complete')
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
    await db.query('DELETE FROM membership_payment_plans WHERE billing_agreement_id=$1', [agreement]);
    await db.query('DELETE FROM membership_billing_agreements WHERE id=$1', [agreement]);
    const configId = (await db.query('SELECT config_id FROM membership_post_grace_renewal WHERE id=$1', [reservation])).rows[0].config_id;
    await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,billing_period,start_mode)
      VALUES($1,$2,'member','annual','immediate') ON CONFLICT(id) DO NOTHING`, [configId,tenant]);
    const amounts = { annual_cost: 156, final_cost: 156, vat_amount: 0, total_with_vat: 156, currency: 'GBP' };
    const commitment = buildRollingCommitment({
      config: { id: configId, tenant_id: tenant, structure_scope_type: 'member', billing_period: 'annual', start_mode: 'immediate' },
      startDate: paid.toISOString().slice(0,10), paymentMethod: cashMinor ? 'stripe' : 'direct_debit',
      paymentFrequency: cashMinor ? 'upfront' : 'monthly', amounts,
    });
    await db.query('DELETE FROM member_membership_history WHERE id=$1', [history]);
    await db.query(`INSERT INTO member_membership_history SELECT (jsonb_populate_record(NULL::member_membership_history,$1)).*`,
      [{ ...expected.history, ...commitment, ...amounts, config_id: configId, billing_agreement_id: null }]);
    await db.query(`UPDATE membership_voucher_settlement SET billing_agreement_id=NULL,state='reserved',purchase_key='complete-fixture',
      funding='{"payableMinor":15600,"voucherMinor":15600,"remainingMinor":0,"currency":"GBP"}' WHERE id=$1`, [settlement]);
    if (cashMinor) {
      await db.query('UPDATE form_membership_voucher_checkout SET released_at=now() WHERE fee_token_id=$1', [token]);
      await db.query(`UPDATE membership_successor_election SET payment_method='upfront',
        quote='{"simulation":{"totalWithVat":156,"currency":"GBP"}}' WHERE id=$1`, [election]);
      await db.query('UPDATE form_membership_voucher_checkout SET released_at=NULL WHERE fee_token_id=$1', [token]);
      const originalReservation = (await db.query('SELECT to_jsonb(r) row FROM membership_post_grace_renewal r WHERE id=$1', [reservation])).rows[0].row;
      // Reseed this independent cash-case fixture; restore every real guard
      // before invoking the completion transaction being tested.
      await db.query('ALTER TABLE membership_post_grace_renewal DISABLE TRIGGER USER');
      await db.query('DELETE FROM membership_post_grace_renewal WHERE id=$1', [reservation]);
      await db.query(`INSERT INTO membership_post_grace_renewal SELECT (jsonb_populate_record(NULL::membership_post_grace_renewal,$1)).*`,
        [{ ...originalReservation, payment_method: 'upfront', first_payment_minor: 15600 }]);
      await db.query('ALTER TABLE membership_post_grace_renewal ENABLE TRIGGER USER');
      await db.query(`UPDATE membership_voucher_settlement SET provider_payment_id='pi_funded',monthly_snapshot=NULL,
        funding='{"payableMinor":15600,"voucherMinor":3600,"remainingMinor":12000,"currency":"GBP"}' WHERE id=$1`, [settlement]);
    }
    await db.query(`UPDATE membership_fee_token SET cost_breakdown=jsonb_build_object('formVoucher',
      jsonb_build_object('electionId',$2::text)) WHERE id=$1`, [token,election]);
    const complete = () => db.query(`SELECT complete_post_grace_membership_voucher($1,$2,$3,$4,'GBP',$5) receipt`,
      [tenant,token,cashMinor ? 'pi_funded' : null,cashMinor,cashMinor ? paid : null]);
    const receipt = (await complete()).rows[0].receipt;
    assert.equal(receipt.state, 'committed');
    assert.equal((await complete()).rows[0].receipt.state, 'committed');
    assert.equal((await db.query('SELECT calls FROM fixture_credit_commit')).rows[0].calls, 1);
    assert.equal((await db.query('SELECT payment_status FROM member_membership_history WHERE id=$1', [history])).rows[0].payment_status, 'paid');
    assert.equal((await db.query('SELECT full_term_credit FROM membership_post_grace_funding_evidence')).rows[0].full_term_credit, !cashMinor);
  } finally { await db.query('ROLLBACK'); }
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const access = (await db.query(`SELECT
      has_function_privilege($1,'apply_post_grace_funded_dates(uuid,uuid,uuid,uuid,text,text,text,timestamptz,bigint,text,jsonb)','EXECUTE') apply,
      has_table_privilege($1,'membership_post_grace_funding_evidence','INSERT') insert,
      has_function_privilege($1,'membership_variable_voucher_settle_before_restart_dates(uuid,uuid)','EXECUTE') internal`,
    [role])).rows[0];
    assert.deepEqual(access, { apply: role === 'service_role', insert: false, internal: false });
  }
}
