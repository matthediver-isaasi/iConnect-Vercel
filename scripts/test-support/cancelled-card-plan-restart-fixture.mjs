import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runs after exerciseCancelledDirectDebitRestart in the real post-grace harness.
// Installs the card-plan extension over the Direct Debit restart chain and
// exercises a Stripe-cancelled monthly card plan end to end.
export async function exerciseCancelledCardPlanRestart(db) {
  await db.query(`
    ALTER TABLE membership_payment_plans ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
    ALTER TABLE membership_payment_plans ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    CREATE TABLE IF NOT EXISTS membership_payment_status_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,entity_type text NOT NULL,entity_id uuid,from_status text,to_status text NOT NULL,
      reason text,source text NOT NULL DEFAULT 'system',event_id text,created_at timestamptz NOT NULL DEFAULT now());
  `);
  const sql = readFileSync(new URL('../../supabase/migrations/202701290001_cancelled_card_plan_restart.sql', import.meta.url), 'utf8');
  await db.query(sql);
  await db.query(sql); // Re-runnable: the finalizer patch is skipped once installed.

  // The already-restarted Direct Debit keeps its evidence and receipt identity.
  const ddReceipt = (await db.query('SELECT * FROM membership_dd_restart_supersession')).rows;
  assert.equal(ddReceipt.length, 1);
  assert.equal(ddReceipt[0].provider, 'gocardless');
  const ddEvidence = (await db.query('SELECT membership_cancelled_dd_restart_evidence($1,$2,$3) e',
    [ddReceipt[0].tenant_id, ddReceipt[0].member_id, ddReceipt[0].history_id])).rows[0].e;
  assert.equal(ddEvidence.provider, 'gocardless');
  assert.ok(ddEvidence.supersession.superseded_at);

  const id = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [tenant, member, prior, agreement, plan, config, other] = [1, 2, 3, 4, 5, 6, 7].map(id);
  await db.query('INSERT INTO tenant VALUES($1)', [tenant]);
  await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [member, tenant]);
  await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,billing_period,is_active,start_mode)
    VALUES($1,$2,'member','annual',true,'immediate')`, [config, tenant]);
  await db.query('INSERT INTO membership_post_grace_policy(tenant_id,enabled) VALUES($1,true)', [tenant]);
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,config_id,billing_agreement_id,status,payment_status,term_start_date,term_end_date,
     membership_renewal_date,commitment_snapshot)
    VALUES($1,$2,$3,$4,$5,'active','partial',current_date-40,current_date+324,current_date+325,
      '{"payment_frequency":"monthly","config":{"renewal_grace_days":0}}')`,
  [prior, tenant, member, config, agreement]);
  await db.query(`INSERT INTO membership_billing_agreements
    (id,tenant_id,member_id,status,provider,environment,term_start_date,term_end_date,membership_renewal_date,metadata)
    VALUES($1,$2,$3,'payment_overdue','stripe','live',current_date-40,current_date+324,current_date+325,
      '{"card":{"kind":"monthly_card"}}')`, [agreement, tenant, member]);
  await db.query(`INSERT INTO membership_payment_plans
    (id,tenant_id,member_id,billing_agreement_id,status,provider,environment,amount_minor,stripe_subscription_id)
    VALUES($1,$2,$3,$4,'active','stripe','live',1300,'sub_restart')`, [plan, tenant, member, agreement]);

  const dates = (await db.query(`SELECT current_date::text start,
    ((current_date+interval '1 year')::date-1)::text finish`)).rows[0];
  const quote = { payerMemberId: member, simulation: { config: { id: config }, formRenewal: {
    commencementBasis: 'confirmed_payment', predecessorId: prior },
  paymentSchedule: { term_start_date: dates.start, term_end_date: dates.finish } } };
  const reserve = () => db.query(`SELECT reserve_post_grace_renewal($1,$2,$3,$4,'upfront',12800,'GBP',$5) data`,
    [tenant, member, prior, config, quote]);
  const evidence = async () => (await db.query(
    'SELECT membership_cancelled_dd_restart_evidence($1,$2,$3) e', [tenant, member, prior])).rows[0].e;
  const audit = source => db.query(`INSERT INTO membership_payment_status_history
    (tenant_id,entity_type,entity_id,from_status,to_status,source) VALUES($1,'payment_plan',$2,'active','payment_plan_cancelled',$3)`,
  [tenant, plan, source]);

  await assert.rejects(reserve(), /requires review/, 'an active card plan does not qualify');
  await db.query("UPDATE membership_payment_plans SET status='payment_plan_cancelled' WHERE id=$1", [plan]);
  assert.equal(await evidence(), null, 'a cancelled status without Stripe confirmation is not evidence');
  await audit('admin');
  assert.equal(await evidence(), null, 'a local/admin cancellation is not Stripe confirmation');
  await assert.rejects(reserve(), /requires review/);
  await audit('webhook');
  const confirmed = await evidence();
  assert.equal(confirmed.provider, 'stripe');
  assert.equal(confirmed.agreement_id, agreement);
  assert.equal(confirmed.plan_id, plan);
  assert.equal(confirmed.agreement_status, 'payment_overdue');
  assert.equal(confirmed.stripe_subscription_id, 'sub_restart');
  assert.equal(confirmed.mandate_status, undefined);
  assert.ok(confirmed.cancellation_confirmed_at);

  for (const [label, change, undo] of [
    ['a completed plan', `UPDATE membership_payment_plans SET completed_at=now() WHERE id='${plan}'`,
      `UPDATE membership_payment_plans SET completed_at=NULL WHERE id='${plan}'`],
    ['a completed agreement', `UPDATE membership_billing_agreements SET status='completed' WHERE id='${agreement}'`,
      `UPDATE membership_billing_agreements SET status='payment_overdue' WHERE id='${agreement}'`],
    ['a duplicate-checkout conflict', `UPDATE membership_billing_agreements SET metadata=metadata||'{"form_conflict_resolution":{}}' WHERE id='${agreement}'`,
      `UPDATE membership_billing_agreements SET metadata=metadata-'form_conflict_resolution' WHERE id='${agreement}'`],
    ['a switch cancellation', `UPDATE membership_billing_agreements SET cancelled_for_switch_at=now() WHERE id='${agreement}'`,
      `UPDATE membership_billing_agreements SET cancelled_for_switch_at=NULL WHERE id='${agreement}'`],
    ['a non-card agreement', `UPDATE membership_billing_agreements SET metadata='{}' WHERE id='${agreement}'`,
      `UPDATE membership_billing_agreements SET metadata='{"card":{"kind":"monthly_card"}}' WHERE id='${agreement}'`],
  ]) {
    await db.query(change);
    assert.equal(await evidence(), null, `${label} is not a confirmed cancellation`);
    await db.query(undo);
  }
  assert.ok(await evidence());

  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider,metadata)
    VALUES($1,$2,$3,'active','stripe','{"card":{"kind":"monthly_card"}}')`, [other, tenant, member]);
  await assert.rejects(reserve(), /Another membership or payment/, 'any other open card agreement still blocks');
  await db.query('DELETE FROM membership_billing_agreements WHERE id=$1', [other]);

  const strip = row => { const { restart_supersession_id: _ignored, ...rest } = row; return rest; };
  const readRow = async (table, rowId) => (await db.query(
    `SELECT to_jsonb(x) data FROM ${table} x WHERE id=$1`, [rowId])).rows[0].data;
  const original = await readRow('member_membership_history', prior);
  const originalAgreement = await readRow('membership_billing_agreements', agreement);
  const originalPlan = await readRow('membership_payment_plans', plan);

  const election = (await reserve()).rows[0].data;
  assert.equal(election.previous_term_id, prior);
  assert.equal((await reserve()).rows[0].data.id, election.id, 'replay returns the same checkout');
  const journal = (await db.query('SELECT *,grace_end_date::text grace FROM membership_post_grace_renewal WHERE election_id=$1',
    [election.id])).rows[0];
  assert.equal(journal.grace, (await db.query("SELECT (current_date-1)::text d")).rows[0].d);
  const linked = await readRow('member_membership_history', prior);
  assert.ok(linked.restart_supersession_id, 'reservation links the shared supersession receipt');
  assert.deepEqual(strip(linked), strip(original), 'reservation changes nothing else on the cancelled term');
  const reserved = (await db.query('SELECT * FROM membership_dd_restart_supersession WHERE history_id=$1', [prior])).rows[0];
  assert.equal(reserved.provider, 'stripe');
  assert.equal(reserved.stripe_subscription_id, 'sub_restart');
  assert.equal(reserved.mandate_status, null);
  assert.equal(reserved.plan_id, plan);

  // The upfront quote may overlap only the bound card agreement.
  const renewalDate = (await db.query("SELECT ((current_date+interval '1 year')::date)::text d")).rows[0].d;
  const paymentQuote = { simResult: { formRenewalElectionId: election.id, config: { start_mode: 'immediate' },
    paymentSchedule: { term_start_date: dates.start, term_end_date: dates.finish },
    commitment: { term_key: `rolling:${dates.start}`, term_start_date: dates.start, term_end_date: dates.finish,
      membership_renewal_date: renewalDate, commitment_snapshot: { start_mode: 'immediate', config_id: config } } } };
  const savedQuote = (await db.query('SELECT save_elected_form_membership_quote($1,$2,$3,$4) q',
    [election.id, tenant, member, paymentQuote])).rows[0].q;
  assert.equal(savedQuote.term_key, `rolling:${dates.start}`);
  const outsider = id(20);
  await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)', [outsider, tenant]);
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider,term_start_date,
    term_end_date,membership_renewal_date,metadata) VALUES($1,$2,$3,'payment_overdue','stripe',current_date-10,
    current_date+200,current_date+201,'{"card":{"kind":"monthly_card"}}')`, [id(21), tenant, outsider]);
  await assert.rejects(db.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,term_key,quote)
    VALUES($1,$2,$3,$4)`, [tenant, outsider, `rolling:${dates.start}`, paymentQuote]),
  /monthly payment agreement already reserves/, 'an unlinked open card agreement still blocks upfront quotes');

  const successor = id(8);
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,status,payment_status,previous_term_id,membership_successor_election_id,commitment_snapshot,
     term_start_date,term_end_date)
    VALUES($1,$2,$3,'pending','unpaid',$4,$5,'{"price":128}',$6,$7)`,
  [successor, tenant, member, prior, election.id, dates.start, dates.finish]);
  const expected = { history: await readRow('member_membership_history', successor), agreement: null, plan: null };
  const paidAt = (await db.query('SELECT now() t')).rows[0].t;
  const finalize = () => db.query(`SELECT apply_post_grace_record_dates(
    $1,$2,$3,'stripe','pi-card-restart','succeeded',$5,12800,'GBP',$4) receipt`,
  [tenant, member, journal.id, expected, paidAt]);
  const receipt = (await finalize()).rows[0].receipt;
  assert.equal(receipt.state, 'applied');
  assert.deepEqual((await finalize()).rows[0].receipt, receipt, 'finalization replay is idempotent');

  const ended = await readRow('member_membership_history', prior);
  assert.equal(ended.status, 'expired');
  assert.deepEqual({ ...strip(ended), status: original.status }, strip(original),
    'original dates, payment status and debt are kept as evidence');
  assert.deepEqual(await readRow('membership_billing_agreements', agreement), originalAgreement,
    'the card agreement is left exactly as Stripe cancellation left it');
  assert.deepEqual(await readRow('membership_payment_plans', plan), originalPlan,
    'the cancelled card plan and its unpaid instalments stay as recorded');
  const superseded = (await db.query('SELECT * FROM membership_dd_restart_supersession WHERE history_id=$1', [prior])).rows[0];
  assert.equal(superseded.successor_history_id, successor);
  assert.ok(superseded.superseded_at);
  await assert.rejects(db.query("UPDATE membership_dd_restart_supersession SET provider='gocardless' WHERE id=$1",
    [superseded.id]), /immutable/);
  await assert.rejects(reserve(), /already been restarted|already reserved|Another/, 'a restarted term cannot restart twice');

  // Provider identity is derived from the bound rows, never supplied freely.
  await assert.rejects(db.query(`INSERT INTO membership_dd_restart_supersession
    (tenant_id,member_id,history_id,agreement_id,plan_id,mandate_status,original_term_start_date,original_term_end_date)
    VALUES($1,$2,$3,$4,$5,'cancelled',current_date,current_date)`, [tenant, member, id(30), agreement, id(31)]),
  /one bound payment provider/);
}
