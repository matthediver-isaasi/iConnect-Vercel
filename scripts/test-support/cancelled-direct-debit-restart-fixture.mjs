import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runs after exercisePaymentGraceRenewal in the real post-grace harness. It
// installs the confirmed-cancelled Direct Debit restart migration over the
// already patched reservation/journal/finalizer chain and exercises it.
export async function exerciseCancelledDirectDebitRestart(db) {
  await db.query(`
    ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_paused boolean;
    ALTER TABLE member ADD COLUMN IF NOT EXISTS membership_cancelled boolean;
    ALTER TABLE membership_billing_agreements ADD COLUMN IF NOT EXISTS gocardless_mandate_id text;
    ALTER TABLE membership_billing_agreements ADD COLUMN IF NOT EXISTS environment text;
    ALTER TABLE membership_billing_agreements ADD COLUMN IF NOT EXISTS cancelled_for_switch_at timestamptz;
    ALTER TABLE membership_payment_plans ADD COLUMN IF NOT EXISTS provider text;
    ALTER TABLE membership_payment_plans ADD COLUMN IF NOT EXISTS environment text;
    CREATE TABLE IF NOT EXISTS gocardless_mandates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid,gocardless_mandate_id text,status text,environment text);
  `);
  // Production upfront-quote guard and elected quote RPC, as the form uses them.
  await db.query(`
    ALTER TABLE membership_payment_quote ADD COLUMN IF NOT EXISTS organization_id uuid;
    ALTER TABLE membership_payment_quote ADD COLUMN IF NOT EXISTS term_key text;
    ALTER TABLE membership_payment_quote ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
    ALTER TABLE membership_payment_quote ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE membership_successor_election ADD COLUMN IF NOT EXISTS payment_quote_id uuid;
    CREATE TABLE IF NOT EXISTS organization(id uuid PRIMARY KEY,tenant_id uuid);
  `);
  const rolling = readFileSync(new URL('../../supabase/migrations/20260920_rolling_membership_commitments.sql', import.meta.url), 'utf8');
  await db.query(rolling.slice(rolling.indexOf('CREATE OR REPLACE FUNCTION enforce_rolling_payment_quote()'),
    rolling.indexOf('CREATE OR REPLACE FUNCTION insert_rolling_membership_commitment(')));
  const elected = readFileSync(new URL('../../supabase/migrations/20261201_membership_successor_election.sql', import.meta.url), 'utf8');
  await db.query(elected.slice(elected.indexOf('CREATE FUNCTION public.save_elected_form_membership_quote('),
    elected.indexOf('ALTER TABLE public.membership_billing_agreements ADD COLUMN membership_successor_election_id')));
  const sql = readFileSync(new URL('../../supabase/migrations/202701280001_cancelled_direct_debit_restart.sql', import.meta.url), 'utf8');
  await db.query(sql);
  await db.query(sql); // Re-runnable: every patch is skipped once installed.

  const id = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [tenant, member, prior, agreement, plan, config, other] = [1, 2, 3, 4, 5, 6, 7].map(id);
  await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
  await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [member, tenant]);
  await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,billing_period,is_active,start_mode)
    VALUES($1,$2,'member','annual',true,'immediate')`, [config, tenant]);
  await db.query('INSERT INTO membership_post_grace_policy(tenant_id,enabled) VALUES($1,true)', [tenant]);
  // Still-running monthly term, no failed payment, grace never started.
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,config_id,billing_agreement_id,status,payment_status,term_start_date,term_end_date,
     membership_renewal_date,commitment_snapshot)
    VALUES($1,$2,$3,$4,$5,'active','partial',current_date-55,current_date+309,current_date+310,
      '{"payment_frequency":"monthly","config":{"renewal_grace_days":0}}')`,
  [prior, tenant, member, config, agreement]);
  await db.query(`INSERT INTO membership_billing_agreements
    (id,tenant_id,member_id,status,provider,gocardless_mandate_id,environment,term_start_date,term_end_date,
     membership_renewal_date)
    VALUES($1,$2,$3,'active','gocardless','MD-RESTART','live',current_date-55,current_date+309,current_date+310)`,
  [agreement, tenant, member]);
  await db.query(`INSERT INTO membership_payment_plans
    (id,tenant_id,member_id,billing_agreement_id,status,provider,environment,amount_minor)
    VALUES($1,$2,$3,$4,'active','gocardless','live',1300)`, [plan, tenant, member, agreement]);
  await db.query(`INSERT INTO gocardless_mandates(tenant_id,gocardless_mandate_id,status,environment)
    VALUES($1,'MD-RESTART','active','live')`, [tenant]);

  const dates = (await db.query(`SELECT current_date::text start,
    ((current_date+interval '1 year')::date-1)::text finish`)).rows[0];
  const quote = { payerMemberId: member, simulation: { config: { id: config }, formRenewal: {
    commencementBasis: 'confirmed_payment', predecessorId: prior },
  paymentSchedule: { term_start_date: dates.start, term_end_date: dates.finish } } };
  const reserve = () => db.query(`SELECT reserve_post_grace_renewal($1,$2,$3,$4,'upfront',12800,'GBP',$5) data`,
    [tenant, member, prior, config, quote]);
  const evidence = async () => (await db.query(
    'SELECT membership_cancelled_dd_restart_evidence($1,$2,$3) e', [tenant, member, prior])).rows[0].e;

  await assert.rejects(reserve(), /requires review/, 'an active Direct Debit does not qualify');
  await db.query("UPDATE membership_payment_plans SET status='pending_payment_setup' WHERE id=$1", [plan]);
  await db.query("UPDATE membership_billing_agreements SET status='mandate_pending' WHERE id=$1", [agreement]);
  await assert.rejects(reserve(), /requires review/, 'a pending Direct Debit does not qualify');
  await db.query("UPDATE gocardless_mandates SET status='cancelled'");
  assert.equal(await evidence(), null, 'a cancelled mandate mirror alone is not confirmed cancellation');
  await db.query("UPDATE membership_payment_plans SET status='payment_plan_cancelled' WHERE id=$1", [plan]);
  await db.query("UPDATE membership_billing_agreements SET status='payment_plan_cancelled' WHERE id=$1", [agreement]);
  await db.query("UPDATE gocardless_mandates SET status='active'");
  assert.equal(await evidence(), null, 'cancelled records with a live mandate mirror are not confirmed');
  await db.query("UPDATE gocardless_mandates SET status='cancelled'");
  const confirmed = await evidence();
  assert.equal(confirmed.agreement_id, agreement);
  assert.equal(confirmed.plan_id, plan);
  assert.equal(confirmed.supersession, null);

  await db.query('UPDATE member SET membership_paused=true WHERE id=$1', [member]);
  await assert.rejects(reserve(), /requires review/, 'a paused member cannot restart');
  await db.query('UPDATE member SET membership_paused=false WHERE id=$1', [member]);
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider)
    VALUES($1,$2,$3,'active','gocardless')`, [other, tenant, member]);
  await assert.rejects(reserve(), /Another membership or payment/, 'any other open agreement still blocks');
  await db.query('DELETE FROM membership_billing_agreements WHERE id=$1', [other]);

  const strip = row => { const { restart_supersession_id: _ignored, ...rest } = row; return rest; };
  const readRow = async (table, rowId) => (await db.query(
    `SELECT to_jsonb(x) data FROM ${table} x WHERE id=$1`, [rowId])).rows[0].data;
  const original = await readRow('member_membership_history', prior);
  const originalAgreement = await readRow('membership_billing_agreements', agreement);
  const originalPlan = await readRow('membership_payment_plans', plan);

  // Cancelled with no failed payment, within the still-running term: allowed.
  const election = (await reserve()).rows[0].data;
  assert.equal(election.previous_term_id, prior);
  assert.equal((await reserve()).rows[0].data.id, election.id, 'replay returns the same checkout');
  await assert.rejects(db.query(`SELECT reserve_post_grace_renewal($1,$2,$3,$4,'direct_debit',1300,'GBP',$5)`,
    [tenant, member, prior, config, quote]), /already reserved/, 'a second reservation is still blocked');
  const journal = (await db.query('SELECT *,grace_end_date::text grace FROM membership_post_grace_renewal WHERE election_id=$1',
    [election.id])).rows[0];
  assert.equal(journal.grace, (await db.query("SELECT (current_date-1)::text d")).rows[0].d);
  const linked = await readRow('member_membership_history', prior);
  assert.ok(linked.restart_supersession_id, 'reservation links the supersession receipt');
  assert.deepEqual(strip(linked), strip(original), 'reservation changes nothing else on the cancelled term');
  await assert.rejects(db.query('UPDATE member_membership_history SET restart_supersession_id=NULL WHERE id=$1', [prior]),
    /bound immutable evidence/);

  // The real elected upfront quote save passes the production overlap guard.
  const renewalDate = (await db.query("SELECT ((current_date+interval '1 year')::date)::text d")).rows[0].d;
  const paymentQuote = { simResult: { formRenewalElectionId: election.id, config: { start_mode: 'immediate' },
    paymentSchedule: { term_start_date: dates.start, term_end_date: dates.finish },
    commitment: { term_key: `rolling:${dates.start}`, term_start_date: dates.start, term_end_date: dates.finish,
      membership_renewal_date: renewalDate, commitment_snapshot: { start_mode: 'immediate', config_id: config } } } };
  const saveQuote = () => db.query('SELECT save_elected_form_membership_quote($1,$2,$3,$4) q',
    [election.id, tenant, member, paymentQuote]);
  const savedQuote = (await saveQuote()).rows[0].q;
  assert.equal(savedQuote.term_key, `rolling:${dates.start}`);
  assert.equal((await saveQuote()).rows[0].q.id, savedQuote.id, 'quote save is idempotent');
  await assert.rejects(db.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,term_key,quote)
    VALUES($1,$2,$3,$4)`, [tenant, member, `rolling:${dates.start}`, paymentQuote]),
  /already reserves an overlapping membership term/, 'a second overlapping upfront quote is still blocked');
  const outsider = id(20);
  await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [outsider, tenant]);
  await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,status,payment_status,
    term_start_date,term_end_date,membership_renewal_date) VALUES($1,$2,$3,'active','paid',current_date-10,current_date+200,current_date+201)`,
  [id(21), tenant, outsider]);
  await assert.rejects(db.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,term_key,quote)
    VALUES($1,$2,$3,$4)`, [tenant, outsider, `rolling:${dates.start}`, paymentQuote]),
  /Membership term already recorded/, 'unlinked overlapping terms still block upfront quotes');
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider,term_start_date,
    term_end_date,membership_renewal_date) VALUES($1,$2,$3,'payment_plan_cancelled','gocardless',current_date+300,current_date+400,current_date+401)`,
  [id(22), tenant, outsider]);
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider,term_start_date,
    term_end_date,membership_renewal_date) VALUES($1,$2,$3,'payment_plan_cancelled','gocardless',current_date-10,current_date+200,current_date+201)`,
  [id(23), tenant, member]);
  await assert.rejects(db.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,term_key,quote)
    VALUES($1,$2,$3,$4)`, [tenant, member, `rolling:${dates.start}`, paymentQuote]),
  /monthly payment agreement already reserves/, 'an unlinked cancelled agreement still blocks upfront quotes');
  await db.query('DELETE FROM membership_billing_agreements WHERE id=$1', [id(23)]);

  const successor = id(8);
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,status,payment_status,previous_term_id,membership_successor_election_id,commitment_snapshot,
     term_start_date,term_end_date)
    VALUES($1,$2,$3,'pending','unpaid',$4,$5,'{"price":128}',$6,$7)`,
  [successor, tenant, member, prior, election.id, dates.start, dates.finish]);
  const expected = { history: await readRow('member_membership_history', successor), agreement: null, plan: null };
  const paidAt = (await db.query('SELECT now() t')).rows[0].t;
  const finalize = () => db.query(`SELECT apply_post_grace_record_dates(
    $1,$2,$3,'stripe','pi-dd-restart','succeeded',$5,12800,'GBP',$4) receipt`,
  [tenant, member, journal.id, expected, paidAt]);
  const receipt = (await finalize()).rows[0].receipt;
  assert.equal(receipt.state, 'applied');
  assert.deepEqual((await finalize()).rows[0].receipt, receipt, 'finalization replay is idempotent');
  const paidTerm = (await db.query(`SELECT term_start_date::text start,term_end_date::text finish
    FROM member_membership_history WHERE id=$1`, [successor])).rows[0];
  assert.deepEqual(paidTerm, { start: dates.start, finish: dates.finish });

  const ended = await readRow('member_membership_history', prior);
  assert.equal(ended.status, 'expired', 'the cancelled term no longer counts as a concurrent active membership');
  assert.deepEqual({ ...strip(ended), status: original.status }, strip(original),
    'original dates, payment status and debt are kept as evidence');
  assert.deepEqual(await readRow('membership_billing_agreements', agreement), originalAgreement,
    'the cancelled agreement stays cancelled and unchanged');
  assert.deepEqual(await readRow('membership_payment_plans', plan), originalPlan,
    'the cancelled plan and its unpaid instalments stay as recorded');
  const superseded = (await db.query('SELECT * FROM membership_dd_restart_supersession WHERE history_id=$1', [prior])).rows[0];
  assert.equal(superseded.successor_history_id, successor);
  assert.equal(superseded.reservation_id, journal.id);
  assert.ok(superseded.superseded_at);
  assert.equal(superseded.original_status, 'active');
  assert.equal(superseded.original_payment_status, 'partial');

  await assert.rejects(db.query('UPDATE member_membership_history SET payment_grace_exit_id=$1 WHERE id=$2',
    [id(9), prior]), /cannot receive a payment-grace exit/);
  await assert.rejects(db.query('DELETE FROM membership_dd_restart_supersession WHERE id=$1', [superseded.id]),
    /cannot be deleted/);
  await assert.rejects(db.query('UPDATE membership_dd_restart_supersession SET superseded_at=now() WHERE id=$1',
    [superseded.id]), /immutable/);
  await assert.rejects(reserve(), /already been restarted|already reserved|Another/, 'a restarted term cannot restart twice');
  for (const role of ['anon', 'authenticated']) {
    const access = (await db.query(`SELECT
      has_table_privilege($1,'membership_dd_restart_supersession','INSERT') ins,
      has_function_privilege($1,'membership_cancelled_dd_restart_evidence(uuid,uuid,uuid)','EXECUTE') ev`, [role])).rows[0];
    assert.deepEqual(access, { ins: false, ev: false });
  }
}
