import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { buildStartQuote } from './memberStartQuote.js';
import { simulationFromMemberStart } from './memberStartPayment.js';
import { buildCardAgreementSnapshot, resolveCardMonthlyOffer } from './stripeMonthlyCard.js';
import { buildAgreementSnapshot, resolveDdOffer } from './gocardlessDirectDebit.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
for (const hasDdApproval of [false, true]) test(`isolated PostgreSQL start (DD approval initially ${hasDdApproval ? 'installed' : 'absent'}): atomic purchase, replay, stale quotes, creator fencing, immutable terms, paid activation and tenant permissions`, { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('member-start-');
  const clients = [];
  let started = false;
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let i = 0; i < 3; i++) {
      const client = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await client.connect(); clients.push(client);
    }
    const [db, a, b] = clients;
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,first_name text,last_name text,email text);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text,is_active boolean,
        billing_period text,start_mode text,effective_from date,effective_to date,currency text,pricing_model text,flat_cost numeric,
        prorata_enabled boolean,membership_start_month int,membership_start_day int,
        online_card_payment boolean,card_monthly_enabled boolean,dd_enabled boolean,dd_auto_renew boolean,
        dd_monthly_amount numeric,dd_instalment_count int,dd_activation_rule text,
        dd_policy_version int,dd_collection_end_policy text,dd_pricing_policy text,dd_invoicing_mode text);
      CREATE TABLE membership_tier_band(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid,annual_cost numeric,label text);
      CREATE TABLE membership_tier_discount(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid);
      CREATE TABLE membership_tier_vat_override(LIKE membership_tier_discount);
      CREATE TABLE member_membership_override(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid);
      CREATE TABLE system_settings(id uuid PRIMARY KEY,tenant_id uuid,setting_key text,setting_value text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        membership_year text,config_id uuid,band_id uuid,tier_label text,annual_cost numeric,prorata_cost numeric,final_cost numeric,
        currency text,billing_period text,vat_rate_percent numeric,vat_amount numeric,total_with_vat numeric,
        term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months int,term_anchor_date date,term_key text,
        previous_term_id uuid,commitment_snapshot jsonb,billing_agreement_id uuid,status text,payment_status text,
        payment_method text,paid_at timestamptz,scheduled_activation_date date,notes text,stripe_payment_intent_id text,
        accounting_provider text,accounting_invoice_id text);
      CREATE TABLE organisation_membership_history(LIKE member_membership_history INCLUDING DEFAULTS);
      ALTER TABLE organisation_membership_history DROP COLUMN member_id, ADD COLUMN organization_id uuid;
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,
        term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months int,term_anchor_date date,term_key text,
        previous_term_id uuid,commitment_snapshot jsonb,status text,metadata jsonb,provider text,agreement_type text DEFAULT 'member',
        idempotency_key text,environment text,gocardless_mandate_id text,stripe_subscription_id text);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,status text,
        billing_agreement_id uuid,provider text,amount_minor int,instalments_total int,instalments_paid int,currency text,membership_year text,
        last_payment_status text);
      CREATE TABLE membership_dd_admin_actions(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,plan_id uuid,billing_agreement_id uuid,action text,actor_email text,details jsonb);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,stripe_payment_intent_id text,
        term_key text,quote jsonb);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,status text,
        token text UNIQUE,membership_year text,final_cost numeric,currency text,tier_label text,cost_breakdown jsonb,history_record_id uuid,recipient_email text,
        expires_at timestamptz,stripe_payment_intent_id text,stripe_payment_attempted_at timestamptz);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,status text,term_end_date date);
    `);
    // Real deployed completeness constraint, including the dated-DD exception:
    // fixed upfront snapshots must not be slipped past it.
    await db.query(readFileSync(new URL('../../supabase/migrations/20261108_direct_debit_dated_commitments.sql', import.meta.url), 'utf8').split('END $$;')[0] + 'END $$;');
    await db.query(readFileSync(new URL('../../supabase/migrations/202612310022_member_membership_start.sql', import.meta.url), 'utf8'));
    const rollingSql = readFileSync(new URL('../../supabase/migrations/20260920_rolling_membership_commitments.sql', import.meta.url), 'utf8');
    await db.query(rollingSql.slice(rollingSql.indexOf('CREATE OR REPLACE FUNCTION rolling_commitment_fields'), rollingSql.indexOf('\nDO $$', rollingSql.indexOf('CREATE OR REPLACE FUNCTION enforce_rolling'))));
    const datedSql = readFileSync(new URL('../../supabase/migrations/20261108_direct_debit_dated_commitments.sql', import.meta.url), 'utf8');
    await db.query(datedSql.slice(datedSql.indexOf('DO $migration$'), datedSql.indexOf('-- The form binding RPC')));
    if (hasDdApproval) await db.query(readFileSync(new URL('../../supabase/migrations/20260902_atomic_manual_dd_activation.sql', import.meta.url), 'utf8'));
    await db.query(readFileSync(new URL('../../supabase/migrations/20261014_manual_card_membership_activation.sql', import.meta.url), 'utf8'));
    const completeness = async table => (await db.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid=$1::regclass AND conname=$2`, [table, `${table}_rolling_complete_check`])).rows[0].d;
    const orgCompletenessBefore = await completeness('organisation_membership_history');
    const paymentAuthoritySql = readFileSync(new URL('../../supabase/migrations/202612310023_member_start_payment_authority.sql', import.meta.url), 'utf8');
    const prerequisiteSql = readFileSync(new URL('../../supabase/migrations/20260902_atomic_manual_dd_activation.sql', import.meta.url), 'utf8');
    assert.equal(paymentAuthoritySql.split('EXECUTE $definition$')[1].split('$definition$;')[0]
      .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').trim(),
    prerequisiteSql.slice(prerequisiteSql.indexOf('CREATE OR REPLACE FUNCTION'), prerequisiteSql.indexOf('REVOKE ALL')).trim(),
    'Missing-DD prerequisite must be the unchanged reviewed canonical definition');
    await db.query(paymentAuthoritySql);
    await db.query(readFileSync(new URL('../../supabase/migrations/202612310024_member_start_member_choice.sql', import.meta.url), 'utf8'));
    assert.equal((await db.query(`SELECT to_regprocedure('public.approve_manual_dd_membership_activation(uuid,uuid,text)')::text signature`)).rows[0].signature,
      'approve_manual_dd_membership_activation(uuid,uuid,text)');
    assert.equal((await db.query(`SELECT has_function_privilege('service_role','public.approve_manual_dd_membership_activation(uuid,uuid,text)','EXECUTE') allowed`)).rows[0].allowed, true);
    assert.equal((await db.query(`SELECT has_function_privilege('authenticated','public.approve_manual_dd_membership_activation(uuid,uuid,text)','EXECUTE') allowed`)).rows[0].allowed, false);
    assert.equal(await completeness('organisation_membership_history'), orgCompletenessBefore,
      'Organisation completeness must remain fixed-DD-only, with no Start card exception');
    assert.doesNotMatch(await completeness('member_membership_history'), /organization_id/);
    assert.match(await completeness('member_membership_history'), /member_id IS NOT NULL/);
    assert.match(await completeness('membership_billing_agreements'), /organization_id IS NULL/);
    const historyOwnerColumns = (await db.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_name IN ('member_membership_history','organisation_membership_history') AND column_name IN ('member_id','organization_id')
      ORDER BY table_name,column_name`)).rows;
    assert.deepEqual(historyOwnerColumns, [
      { table_name: 'member_membership_history', column_name: 'member_id' },
      { table_name: 'organisation_membership_history', column_name: 'organization_id' },
    ]);
    for (const table of ['member_membership_history', 'organisation_membership_history', 'membership_billing_agreements']) {
      await db.query(`CREATE TRIGGER rolling_commitment_guard BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment()`);
    }
    await db.query('INSERT INTO tenant VALUES($1),($2)', [id(1), id(2)]);
    for (let n = 10; n < 40; n++) await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [id(n), id(1)]);
    await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,is_active,billing_period,start_mode,effective_from,currency,pricing_model,flat_cost)
      VALUES($1,$2,'member',true,'annual','immediate','2020-01-01','GBP','flat',100)`, [id(3), id(1)]);
    const cfg = (await db.query('SELECT to_jsonb(t) AS value FROM membership_tier_config t')).rows[0].value;
    const today = new Date().toISOString().slice(0, 10);
    const state = async member => (await db.query('SELECT member_start_state($1,$2) s', [id(1), id(member)])).rows[0].s;
    const request = member => ({ memberId: id(member), configId: id(3), bandId: null, startDate: today,
      paymentMode: 'invoice', reason: 'Explicit purchase, no paid history asserted', expectedQuote: 'a'.repeat(64) });
    const quote = async member => ({ ...buildStartQuote({ request: request(member), config: cfg, today }), ownerState: (await state(member)).fingerprint });
    const invoke = (client, member, key, q, r = request(member)) => client.query('SELECT create_member_start($1,$2,$3,$4,$5,$6) result',
      [id(1), id(member), id(4), key, r, q]).then(result => result.rows[0].result);
    await a.query('SET ROLE service_role'); await b.query('SET ROLE service_role');
    assert.equal((await a.query('SELECT member_start_payment_capabilities() c')).rows[0].c.version, 2);
    const q = await quote(10);
    const concurrent = await Promise.all([invoke(a, 10, 'same-key-0001', q), invoke(b, 10, 'same-key-0001', q)]);
    assert.equal(concurrent.filter(r => r.replayed).length, 1);
    assert.equal(concurrent[0].request.record_id, concurrent[1].request.record_id);
    const recordId = concurrent[0].request.record_id;
    const record = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [recordId])).rows[0];
    assert.equal(record.payment_status, 'unpaid');
    assert.equal(record.status, 'pending_payment_setup');
    assert.equal(record.paid_at, null);
    await assert.rejects(invoke(a, 10, 'same-key-0001', q, { ...request(10), reason: 'different' }), /Idempotency/);
    await assert.rejects(invoke(a, 10, 'different-key', q), /obligations changed/);
    await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1", [recordId]), /before settlement/);
    await assert.rejects(db.query("UPDATE member_membership_history SET config_id=$1 WHERE id=$2", [id(99), recordId]), /immutable/);
    await assert.rejects(db.query("UPDATE member_membership_history SET member_id=$1 WHERE id=$2", [id(19), recordId]), /ownership is immutable/);
    await db.query("UPDATE member_membership_history SET accounting_provider='xero',accounting_invoice_id='invoice-1' WHERE id=$1", [recordId]);
    await db.query("UPDATE member_membership_history SET payment_status='paid',status='active',paid_at=now() WHERE id=$1", [recordId]);
    await assert.rejects(db.query("UPDATE member_membership_history SET billing_agreement_id=$1 WHERE id=$2", [id(99), recordId]), /attachments are immutable/);
    await assert.rejects(db.query('INSERT INTO membership_billing_agreements(tenant_id,member_id,status) VALUES($1,$2,$3)', [id(1), id(10), 'active']), /already owns/);
    // An evidenced, non-overlapping successor is still allowed through normal
    // renewal paths; the fence does not prohibit all future annual purchases.
    await db.query(`INSERT INTO member_membership_history(tenant_id,member_id,term_start_date,term_end_date,payment_status,status)
      SELECT tenant_id,member_id,term_end_date+1,term_end_date+365,'unpaid','pending_payment_setup'
      FROM member_membership_history WHERE id=$1`, [recordId]);
    await db.query("UPDATE member_membership_history SET status='expired' WHERE id=$1", [recordId]);
    // Separate-key and competing creator serialize at the member row.
    const q11 = await quote(11);
    await a.query('BEGIN');
    await invoke(a, 11, 'concurrent-start', q11);
    const racing = db.query("INSERT INTO membership_payment_quote(tenant_id,member_id) VALUES($1,$2)", [id(1), id(11)]);
    const rejected = assert.rejects(racing, /already owns/);
    await a.query('COMMIT'); await rejected;
    // Failed-provider authority is not consent to revive after another purchase.
    const failed = (await db.query("INSERT INTO membership_billing_agreements(tenant_id,member_id,status) VALUES($1,$2,'failed') RETURNING id", [id(1), id(17)])).rows[0].id;
    await invoke(a, 17, 'late-provider-001', await quote(17));
    await assert.rejects(db.query("UPDATE membership_billing_agreements SET status='active' WHERE id=$1", [failed]), /already owns/);
    // A creator that wins first invalidates the quoted state.
    const q12 = await quote(12);
    await db.query("INSERT INTO membership_fee_token(tenant_id,member_id,status) VALUES($1,$2,'pending')", [id(1), id(12)]);
    await assert.rejects(invoke(a, 12, 'stale-member', q12), /obligations changed/);
    assert.ok((await state(12)).blockers.length);
    const q13 = await quote(13);
    await db.query('UPDATE membership_tier_config SET flat_cost=101 WHERE id=$1', [id(3)]);
    await assert.rejects(invoke(a, 13, 'stale-price', q13), /Structure changed/);
    await db.query('UPDATE membership_tier_config SET flat_cost=100 WHERE id=$1', [id(3)]);
    // Free fixed-date starts work under the untouched legacy constraint.
    await db.query("UPDATE membership_tier_config SET flat_cost=0,start_mode='fixed_date' WHERE id=$1", [id(3)]);
    const freeConfig = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
    const freeRequest = { ...request(14), paymentMode: 'free' };
    const freeQuote = { ...buildStartQuote({ request: freeRequest, config: freeConfig, today }), ownerState: (await state(14)).fingerprint };
    const free = await invoke(a, 14, 'free-start-001', freeQuote, freeRequest);
    const freeRow = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [free.request.record_id])).rows[0];
    assert.equal(freeRow.payment_status, 'paid'); assert.equal(freeRow.payment_method, null);
    assert.equal(freeRow.commitment_snapshot, null);
    assert.equal(free.request.quote.targetSnapshot.config.start_mode, 'fixed_date');
    let member = 20;
    for (const startMode of ['immediate', 'fixed_date']) for (const rail of ['stripe_upfront', 'stripe_monthly', 'direct_debit', 'dynamic_direct_debit']) {
      const dynamic = rail === 'dynamic_direct_debit';
      const paymentMode = dynamic ? 'direct_debit' : rail;
      await db.query(`UPDATE membership_tier_config SET flat_cost=100,start_mode=$1,online_card_payment=true,
        card_monthly_enabled=true,dd_enabled=true,dd_auto_renew=false,dd_monthly_amount=12,dd_instalment_count=10,dd_activation_rule='first_payment',
        dd_policy_version=1,dd_collection_end_policy='stop',dd_pricing_policy=$2,dd_invoicing_mode=$3`,
      [startMode, dynamic ? 'dynamic' : 'fixed', dynamic ? 'per_instalment' : 'annual']);
      const selected = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
      const r = { ...request(member), paymentMode };
      const q = { ...buildStartQuote({ request: r, config: selected, today }), ownerState: (await state(member)).fingerprint };
      const saved = await invoke(a, member, `provider-start-${member}`, q, r);
      const replay = await invoke(b, member, `provider-start-${member}`, q, r);
      assert.equal(saved.request.id, replay.request.id);
      const tokens = (await db.query('SELECT * FROM membership_fee_token WHERE history_record_id=$1', [saved.request.record_id])).rows;
      assert.equal(tokens.length, 1);
      const token = tokens[0];
      assert.equal(token.token.length, 64);
      const sim = simulationFromMemberStart(token);
      assert.equal(sim.memberStart.paymentMode, paymentMode);
      await assert.rejects(db.query("UPDATE membership_fee_token SET member_id=$1 WHERE id=$2", [id(30), token.id]), /ownership is immutable/);
      await assert.rejects(db.query("UPDATE membership_fee_token SET member_id=NULL WHERE id=$1", [token.id]), /ownership is immutable/);
      await assert.rejects(db.query("UPDATE membership_fee_token SET tenant_id=$1 WHERE id=$2", [id(2), token.id]), /ownership is immutable/);
      await assert.rejects(db.query("UPDATE membership_fee_token SET cost_breakdown='{}' WHERE id=$1", [token.id]), /immutable/);
      await assert.rejects(db.query("INSERT INTO membership_fee_token(tenant_id,member_id,status) VALUES($1,$2,'pending')", [id(1), id(member)]), /already owns/);
      await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1", [saved.request.record_id]), /before settlement/);
      if (paymentMode === 'stripe_upfront') {
        await db.query("UPDATE member_membership_history SET stripe_payment_intent_id=$1,payment_status='paid',status='active',paid_at=now() WHERE id=$2", [`pi-start-${member}`, saved.request.record_id]);
      } else {
        const card = paymentMode === 'stripe_monthly';
        const offer = card ? resolveCardMonthlyOffer(sim) : resolveDdOffer(sim);
        const snapshot = card ? buildCardAgreementSnapshot({ offer, simResult: sim }) : buildAgreementSnapshot({ offer, simResult: sim });
        const agreementId = id(100 + member);
        const agreement = { id: agreementId, ...q.commitment, tenant_id: id(1), member_id: id(member), agreement_type: 'member',
          provider: card ? 'stripe' : 'gocardless', status: 'payment_setup_required', environment: 'live',
          metadata: { [card ? 'card' : 'dd']: snapshot, commitment: q.commitment, member_start: sim.memberStart } };
        await db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)', [agreement]);
        const attached = (await a.query('SELECT attach_member_start_agreement($1,$2) h', [saved.request.id, agreementId])).rows[0].h;
        assert.equal(attached.id, saved.request.record_id);
        assert.equal(attached.billing_agreement_id, agreementId);
        await assert.rejects(db.query("UPDATE membership_billing_agreements SET member_id=$1 WHERE id=$2", [id(30), agreementId]), /ownership is immutable/);
        await assert.rejects(db.query("UPDATE member_membership_history SET billing_agreement_id=$1 WHERE id=$2", [id(999), saved.request.record_id]), /identity is immutable/);
        await assert.rejects(db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)',
          [{ ...agreement, id: id(200 + member) }]), /purchased payment authority/);
        const planId = id(300 + member);
        const plan = { id: planId, tenant_id: id(1), member_id: id(member), billing_agreement_id: agreementId, provider: card ? 'stripe' : 'gocardless',
          amount_minor: offer.monthlyAmountMinor, instalments_total: offer.instalmentCount, instalments_paid: 0,
          currency: offer.currency, membership_year: q.membershipYear, status: 'first_payment_pending' };
        await db.query('INSERT INTO membership_payment_plans SELECT * FROM jsonb_populate_record(NULL::membership_payment_plans,$1)', [plan]);
        await assert.rejects(db.query('UPDATE membership_payment_plans SET amount_minor=999 WHERE id=$1', [planId]), /purchased payment authority/);
        await assert.rejects(db.query('UPDATE member_membership_history SET status=$1 WHERE id=$2', ['active', saved.request.record_id]), /before settlement/);
        await db.query('UPDATE membership_payment_plans SET instalments_paid=1 WHERE id=$1', [planId]);
        await db.query("UPDATE member_membership_history SET payment_status='partial',status='active' WHERE id=$1", [saved.request.record_id]);
        const histories = (await db.query('SELECT * FROM member_membership_history WHERE member_id=$1', [id(member)])).rows;
        assert.equal(histories.length, 1);
        assert.equal(histories[0].term_start_date.toISOString().slice(0, 10), q.termStart);
        assert.equal(histories[0].term_end_date.toISOString().slice(0, 10), q.termEnd);
        assert.equal(histories[0].total_with_vat, dynamic ? null : String(q.totalWithVat));
        await db.query("UPDATE member_membership_history SET payment_status='paid',status='expired' WHERE id=$1", [saved.request.record_id]);
        // Even after settlement/expiry the exact token, agreement and plan
        // identities and purchased economics remain fenced.
        await assert.rejects(db.query("UPDATE membership_billing_agreements SET member_id=NULL WHERE id=$1", [agreementId]), /ownership is immutable/);
        await assert.rejects(db.query("UPDATE membership_billing_agreements SET tenant_id=$1 WHERE id=$2", [id(2), agreementId]), /ownership is immutable/);
        await assert.rejects(db.query("UPDATE membership_payment_plans SET amount_minor=999 WHERE id=$1", [planId]), /purchased payment authority/);
        await assert.rejects(db.query("UPDATE membership_payment_plans SET member_id=NULL WHERE id=$1", [planId]), /ownership is immutable/);
        await assert.rejects(db.query("UPDATE membership_payment_plans SET tenant_id=$1 WHERE id=$2", [id(2), planId]), /ownership is immutable/);
        await assert.rejects(db.query("UPDATE member_membership_history SET billing_agreement_id=NULL WHERE id=$1", [saved.request.record_id]), /identity is immutable/);
        await assert.rejects(db.query("UPDATE membership_fee_token SET cost_breakdown='{}' WHERE id=$1", [token.id]), /immutable/);
      }
      member++;
    }
    await db.query("UPDATE membership_tier_config SET start_mode='immediate',dd_activation_rule='manual'");
    const manualConfig = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
    const manualRequest = { ...request(29), paymentMode: 'direct_debit' };
    const manualQuote = { ...buildStartQuote({ request: manualRequest, config: manualConfig, today }), ownerState: (await state(29)).fingerprint };
    const manualSaved = await invoke(a, 29, 'manual-dd-start', manualQuote, manualRequest);
    const manualRecordId = manualSaved.request.record_id;
    const manualToken = (await db.query('SELECT * FROM membership_fee_token WHERE history_record_id=$1', [manualRecordId])).rows[0];
    const manualSim = simulationFromMemberStart(manualToken);
    const manualSnapshot = buildAgreementSnapshot({ offer: resolveDdOffer(manualSim), simResult: manualSim });
    await db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)',
      [{ id: id(600), ...manualQuote.commitment, tenant_id: id(1), member_id: id(29), agreement_type: 'member',
        provider: 'gocardless', status: 'active', gocardless_mandate_id: 'MD_manual_fixture',
        metadata: { dd: manualSnapshot, commitment: manualQuote.commitment, member_start: manualSim.memberStart } }]);
    await a.query('SELECT attach_member_start_agreement($1,$2)', [manualSaved.request.id, id(600)]);
    await db.query(`INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,amount_minor,
      instalments_total,instalments_paid,currency,membership_year,status) VALUES($1,$2,$3,$4,'gocardless',1200,10,0,'GBP',$5,'active')`,
    [id(601), id(1), id(29), id(600), manualQuote.membershipYear]);
    await db.query("UPDATE member_membership_history SET status='pending_activation' WHERE id=$1", [manualRecordId]);
    await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1", [manualRecordId]), /before settlement/);
    const approveManual = async tenant => (await a.query('SELECT approve_manual_dd_membership_activation($1,$2,$3) r',
      [id(tenant), id(601), 'finance@example.test'])).rows[0].r;
    assert.equal((await approveManual(2)).reason, 'not_found');
    assert.equal((await approveManual(1)).activated, true);
    assert.equal((await approveManual(1)).already_active, true);
    assert.equal((await db.query('SELECT status FROM member_membership_history WHERE id=$1', [manualRecordId])).rows[0].status, 'active');
    assert.equal((await db.query('SELECT count(*)::int n FROM membership_dd_admin_actions WHERE plan_id=$1', [id(601)])).rows[0].n, 1);
    // Synthetic historical fixture: a truly ended, settled Start must retain
    // its attachment fences even though it no longer blocks a new term.
    const historicConfig = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
    historicConfig.start_mode = 'immediate';
    const historicRequest = { ...request(28), startDate: '2020-01-01', paymentMode: 'stripe_monthly' };
    const historicQuote = buildStartQuote({ request: historicRequest, config: historicConfig, today: '2020-01-01' });
    const historicRecord = { id: id(500), ...historicQuote.commitment, tenant_id: id(1), member_id: id(28),
      membership_year: historicQuote.membershipYear, config_id: historicConfig.id, annual_cost: historicQuote.annualCost,
      final_cost: historicQuote.finalCost, vat_amount: historicQuote.vatAmount, total_with_vat: historicQuote.totalWithVat,
      currency: 'GBP', billing_period: 'monthly_card', payment_method: 'card_monthly', payment_status: 'paid', status: 'expired' };
    await db.query('INSERT INTO member_membership_history SELECT * FROM jsonb_populate_record(NULL::member_membership_history,$1)', [historicRecord]);
    await db.query(`INSERT INTO member_membership_start(id,tenant_id,member_id,actor_id,record_id,idempotency_key,request,quote)
      VALUES($1,$2,$3,$4,$5,'historical-fixture',$6,$7)`, [id(501), id(1), id(28), id(4), id(500), historicRequest, historicQuote]);
    await db.query('INSERT INTO member_start_payment_attachment(start_id,token_id) VALUES($1,$2)', [id(501), id(502)]);
    const historicToken = { id: id(502), token: 'expired-historical-start', tenant_id: id(1), member_id: id(28), history_record_id: id(500),
      membership_year: historicQuote.membershipYear, final_cost: historicQuote.finalCost, currency: 'GBP', status: 'paid', expires_at: '2021-01-01',
      cost_breakdown: { memberStart: { version: 1, requestId: id(501), recordId: id(500), tenantId: id(1), memberId: id(28), quote: historicQuote } } };
    await db.query('INSERT INTO membership_fee_token SELECT * FROM jsonb_populate_record(NULL::membership_fee_token,$1)', [historicToken]);
    const historicSim = simulationFromMemberStart(historicToken);
    const historicSnapshot = buildCardAgreementSnapshot({ offer: resolveCardMonthlyOffer(historicSim), simResult: historicSim });
    await db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)',
      [{ id: id(503), ...historicQuote.commitment, tenant_id: id(1), member_id: id(28), agreement_type: 'member', provider: 'stripe', status: 'expired',
        metadata: { card: historicSnapshot, commitment: historicQuote.commitment, member_start: historicSim.memberStart } }]);
    await a.query('SELECT attach_member_start_agreement($1,$2)', [id(501), id(503)]);
    await db.query(`INSERT INTO membership_payment_plans(id,tenant_id,member_id,billing_agreement_id,provider,amount_minor,instalments_total,
      instalments_paid,currency,membership_year,status) VALUES($1,$2,$3,$4,'stripe',1200,10,10,'GBP',$5,'expired')`,
    [id(504), id(1), id(28), id(503), historicQuote.membershipYear]);
    await assert.rejects(db.query("UPDATE membership_fee_token SET member_id=NULL WHERE id=$1", [id(502)]), /ownership is immutable/);
    await assert.rejects(db.query("UPDATE membership_fee_token SET cost_breakdown='{}' WHERE id=$1", [id(502)]), /immutable/);
    await assert.rejects(db.query("UPDATE membership_billing_agreements SET member_id=NULL WHERE id=$1", [id(503)]), /ownership is immutable/);
    await assert.rejects(db.query("UPDATE membership_payment_plans SET amount_minor=999 WHERE id=$1", [id(504)]), /purchased payment authority/);
    for (const [table, key] of [['membership_fee_token', 502], ['membership_billing_agreements', 503], ['membership_payment_plans', 504]]) {
      await assert.rejects(db.query(`DELETE FROM ${table} WHERE id=$1`, [id(key)]), /cannot be deleted/);
    }
    // Member choice freezes multiple real quotes, then binds one under the same
    // member lock. No payment or recurring authority is possible beforehand.
    await db.query(`UPDATE membership_tier_config SET start_mode='immediate',flat_cost=100,
      dd_activation_rule='first_payment',dd_pricing_policy='fixed',dd_invoicing_mode='annual'`);
    for (const [member, chosen] of [[30, 'stripe_upfront'], [31, 'stripe_monthly'], [32, 'direct_debit']]) {
      const config = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
      const r = { ...request(member), paymentMode: 'member_choice' };
      const ownerState = (await state(member)).fingerprint;
      const paymentChoices = ['stripe_upfront', 'stripe_monthly', 'direct_debit'].map(mode => ({
        mode, quote: { ...buildStartQuote({ request: { ...r, paymentMode: mode }, config, today }), ownerState },
      }));
      const q = { ...paymentChoices[0].quote, paymentMode: 'member_choice', paymentChoices };
      const saved = await invoke(a, member, `choice-${member}`, q, r);
      const original = structuredClone(saved.request);
      const readToken = async () => (await db.query('SELECT to_jsonb(t) v FROM membership_fee_token t WHERE history_record_id=$1', [saved.request.record_id])).rows[0].v;
      let token = await readToken();
      assert.equal(simulationFromMemberStart(token).memberStart.paymentMode, 'member_choice');
      await assert.rejects(db.query("UPDATE membership_fee_token SET stripe_payment_intent_id='pi-before-choice' WHERE id=$1", [token.id]), /Select one/);
      await assert.rejects(db.query("UPDATE member_membership_history SET payment_status='paid' WHERE id=$1", [saved.request.record_id]), /Select one/);
      await assert.rejects(db.query("INSERT INTO membership_billing_agreements(tenant_id,member_id,status) VALUES($1,$2,'payment_setup_required')",
        [id(1), id(member)]), /Select one/);
      const choose = (client, mode) => client.query('SELECT select_member_start_payment_method($1,$2) v', [token.id, mode]).then(r => r.rows[0].v);
      await assert.rejects(choose(a, 'invoice'), /self-service/);
      const parallel = await Promise.allSettled([choose(a, chosen), choose(b, chosen === 'stripe_upfront' ? 'stripe_monthly' : 'stripe_upfront')]);
      assert.equal(parallel.filter(p => p.status === 'fulfilled').length, 1);
      const winner = parallel.find(p => p.status === 'fulfilled').value.paymentMode;
      assert.equal((await choose(a, winner)).replayed, true);
      token = await readToken();
      const sim = simulationFromMemberStart(token);
      assert.equal(sim.memberStart.paymentMode, winner);
      const selected = paymentChoices.find(p => p.mode === winner).quote;
      assert.deepEqual(token.cost_breakdown.memberStart.quote, selected);
      assert.deepEqual((await db.query('SELECT to_jsonb(s) v FROM member_membership_start s WHERE id=$1', [saved.request.id])).rows[0].v, original);
      await assert.rejects(db.query("UPDATE member_membership_history SET final_cost=999 WHERE id=$1", [saved.request.record_id]), /immutable/);
      await assert.rejects(db.query("UPDATE membership_fee_token SET cost_breakdown=jsonb_set(cost_breakdown,'{memberStart,quote}', $1) WHERE id=$2", [q, token.id]), /immutable/);
      await assert.rejects(db.query('DELETE FROM member_start_payment_selection WHERE start_id=$1', [saved.request.id]), /immutable/);
      assert.equal((await invoke(a, member, `choice-${member}`, q, r)).request.id, saved.request.id);
      // Current pricing changes are irrelevant after admin confirmation.
      await db.query('UPDATE membership_tier_config SET flat_cost=777');
      assert.equal((await choose(b, winner)).paymentMode, winner);
      if (winner === 'stripe_upfront') {
        await db.query("UPDATE member_membership_history SET stripe_payment_intent_id='pi-selected',payment_status='paid',status='active' WHERE id=$1", [saved.request.record_id]);
      } else {
        const card = winner === 'stripe_monthly';
        const offer = card ? resolveCardMonthlyOffer(sim) : resolveDdOffer(sim);
        const snapshot = card ? buildCardAgreementSnapshot({ offer, simResult: sim }) : buildAgreementSnapshot({ offer, simResult: sim });
        const agreementId = id(800 + member);
        const agreement = { id: agreementId, ...selected.commitment, tenant_id: id(1), member_id: id(member), agreement_type: 'member',
          provider: card ? 'stripe' : 'gocardless', status: 'payment_setup_required',
          metadata: { [card ? 'card' : 'dd']: snapshot, commitment: selected.commitment, member_start: sim.memberStart } };
        await db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)', [agreement]);
        await a.query('SELECT attach_member_start_agreement($1,$2)', [saved.request.id, agreementId]);
        await assert.rejects(db.query('INSERT INTO membership_billing_agreements SELECT * FROM jsonb_populate_record(NULL::membership_billing_agreements,$1)',
          [{ ...agreement, id: id(900 + member) }]), /purchased payment authority/);
      }
      await db.query('UPDATE membership_tier_config SET flat_cost=100');
    }
    // Fixed-date and dynamic choices use the selected immutable commitment,
    // including null (not invented fixed) dynamic term totals.
    for (const [member, mode, dynamic] of [[33, 'direct_debit', true], [34, 'stripe_monthly', false], [35, 'stripe_upfront', false]]) {
      await db.query(`UPDATE membership_tier_config SET start_mode='fixed_date',dd_pricing_policy=$1,dd_invoicing_mode=$2`,
        [dynamic ? 'dynamic' : 'fixed', dynamic ? 'per_instalment' : 'annual']);
      const config = (await db.query('SELECT to_jsonb(t) v FROM membership_tier_config t')).rows[0].v;
      const startDate = `${Number(today.slice(0, 4)) + 1}-01-01`;
      const r = { ...request(member), startDate, paymentMode: 'member_choice' };
      const ownerState = (await state(member)).fingerprint;
      const paymentChoices = ['stripe_upfront', 'stripe_monthly', 'direct_debit'].map(mode => ({
        mode, quote: { ...buildStartQuote({ request: { ...r, paymentMode: mode }, config, today }), ownerState },
      }));
      const q = { ...paymentChoices[0].quote, paymentMode: 'member_choice', paymentChoices };
      const saved = await invoke(a, member, `fixed-choice-${member}`, q, r);
      const token = (await db.query('SELECT to_jsonb(t) v FROM membership_fee_token t WHERE history_record_id=$1', [saved.request.record_id])).rows[0].v;
      if (member === 33) {
        // A failure of either write rolls back the witness AND history change.
        await db.query(`CREATE FUNCTION fail_choice_token_update() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Injected token persistence failure'; END $$;
          CREATE TRIGGER aaa_fail_choice BEFORE UPDATE ON membership_fee_token FOR EACH ROW EXECUTE FUNCTION fail_choice_token_update()`);
        await assert.rejects(a.query('SELECT select_member_start_payment_method($1,$2)', [token.id, mode]), /Injected/);
        assert.equal((await db.query('SELECT count(*)::int n FROM member_start_payment_selection WHERE start_id=$1', [saved.request.id])).rows[0].n, 0);
        assert.equal((await db.query('SELECT final_cost FROM member_membership_history WHERE id=$1', [saved.request.record_id])).rows[0].final_cost, '100');
        await db.query('DROP TRIGGER aaa_fail_choice ON membership_fee_token; DROP FUNCTION fail_choice_token_update()');
      }
      await a.query('SELECT select_member_start_payment_method($1,$2)', [token.id, mode]);
      const selected = paymentChoices.find(p => p.mode === mode).quote;
      const read = (await db.query('SELECT to_jsonb(t) v FROM membership_fee_token t WHERE id=$1', [token.id])).rows[0].v;
      assert.deepEqual(read.cost_breakdown.memberStart.quote, selected);
      assert.equal(simulationFromMemberStart(read).memberStart.paymentMode, mode);
      const history = (await db.query('SELECT to_jsonb(t) v FROM member_membership_history t WHERE id=$1', [saved.request.record_id])).rows[0].v;
      assert.equal(history.final_cost, selected.finalCost);
      assert.equal(history.total_with_vat, selected.totalWithVat);
      assert.equal(history.term_start_date, startDate);
      assert.equal(history.term_end_date, selected.termEnd);
      assert.equal(history.payment_status, 'unpaid');
      if (mode === 'stripe_upfront') {
        await db.query("UPDATE membership_fee_token SET stripe_payment_attempted_at=now() WHERE id=$1", [token.id]);
      } else {
        await assert.rejects(db.query("UPDATE membership_fee_token SET stripe_payment_attempted_at=now() WHERE id=$1", [token.id]), /upfront card/);
      }
    }
    // Legacy expiry-only/unverified evidence is never converted to paid history.
    await db.query("INSERT INTO member_membership_history(tenant_id,member_id,payment_status) VALUES($1,$2,'unverified')", [id(1), id(15)]);
    assert.ok((await state(15)).blockers.length);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT member_start_payment_capabilities()'), /permission denied/);
    await assert.rejects(db.query('SELECT member_start_state($1,$2)', [id(1), id(16)]), /permission denied/);
    await assert.rejects(db.query("SELECT select_member_start_payment_method($1,'stripe_upfront')", [id(999)]), /permission denied/);
    assert.equal((await db.query("SELECT member_start_selection_transition('member_membership_history','{}','{}') v")).rows[0].v, false);
    await db.query('RESET ROLE');
    await assert.rejects(a.query('DELETE FROM member_membership_start'), /permission denied/);
    await assert.rejects(a.query('SELECT create_member_start($1,$2,$3,$4,$5,$6)', [id(2), id(16), id(4), 'wrong-tenant', request(16), q13]), /not found in tenant/);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
