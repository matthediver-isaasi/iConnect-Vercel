import assert from 'node:assert/strict';

export async function exerciseFunnelActivation({ db, sql }) {
  await db.query('RESET ROLE');
  // Minimal host membership schema; the actual unmodified follow-up migration
  // is installed below, rather than stubbing the readiness prerequisite.
  await db.query(`
    CREATE TABLE IF NOT EXISTS organisation_membership_history(id uuid PRIMARY KEY,tenant_id uuid);
    CREATE TABLE IF NOT EXISTS member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,amount numeric);
    CREATE TABLE IF NOT EXISTS membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,quote jsonb);
    CREATE TABLE IF NOT EXISTS form_submission(id uuid PRIMARY KEY,tenant_id uuid,payment_meta jsonb);
    CREATE TABLE IF NOT EXISTS membership_fee_token(id uuid PRIMARY KEY,tenant_id uuid);
    CREATE OR REPLACE FUNCTION create_member_start(p_tenant_id uuid,p_member_id uuid,p_config uuid,
      p_mode text,p_quote jsonb,p_options jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO member_membership_history (tenant_id,member_id,amount)
          VALUES (p_tenant_id,p_member_id,0);
        RETURN '{}';
      END $$;
  `);
  await db.query(await sql('202702040001_event_funnel_controlled_activation.sql'));
  let ready=(await db.query('SELECT event_funnel_readiness() r')).rows[0].r;
  assert.equal(ready.activationVersion,1);assert.equal(ready.purchasing,false);
  assert.equal(ready.schemaReady,false);
  await db.query(await sql('202701270001_event_funnel_membership_entitlements.sql'));
  // Exercise the real benefit-consumption trigger, including the immutable
  // non-payment receipt, rather than asserting only that its table exists.
  await db.query(`ALTER TABLE member_membership_history
    ADD COLUMN config_id uuid, ADD COLUMN membership_year text, ADD COLUMN total_with_vat numeric,
    ADD COLUMN payment_status text, ADD COLUMN payment_method text, ADD COLUMN paid_at timestamptz,
    ADD COLUMN stripe_payment_intent_id text, ADD COLUMN billing_agreement_id uuid,
    ADD COLUMN membership_payment_quote_id uuid, ADD COLUMN proposal_membership jsonb`);
  const order=(await db.query(`SELECT o.id,o.tenant_id,m.id member_id FROM event_funnel_order o
    JOIN member m ON m.tenant_id=o.tenant_id LIMIT 1`)).rows[0];
  assert.ok(order);
  const schedule='00000000-0000-4000-8000-000000099900';
  const entitlement=(await db.query(`INSERT INTO event_funnel_membership_entitlement
    (tenant_id,order_id,node_id,schedule_id,scope,member_id,benefit_snapshot)
    VALUES($1,$2,'activation-fixture-membership',$3,'member',$4,'{"scheduleName":"Fixture tier"}') RETURNING id`,
    [order.tenant_id,order.id,schedule,order.member_id])).rows[0].id;
  const benefit={entitlementId:entitlement,scheduleId:schedule,orderId:order.id,
    originalBaseNetMinor:10000,originalBaseVatMinor:2000};
  const insert=`INSERT INTO member_membership_history(id,tenant_id,member_id,config_id,membership_year,
    total_with_vat,funnel_membership,payment_status,payment_method)
    VALUES(gen_random_uuid(),$1,$2,$3,'fixture-year',0,$4,'unpaid','none') RETURNING *`;
  await assert.rejects(db.query(insert,[order.tenant_id,order.member_id,schedule,null]),{code:'PT409'});
  const history=(await db.query(insert,[order.tenant_id,order.member_id,schedule,benefit])).rows[0];
  assert.equal(history.payment_status,'paid');
  assert.equal(history.payment_method,'event_funnel_entitlement');
  assert.equal(history.paid_at,null);assert.equal(history.stripe_payment_intent_id,null);
  const consumption=(await db.query(`SELECT * FROM event_funnel_membership_consumption WHERE entitlement_id=$1`,[entitlement])).rows[0];
  assert.equal(consumption.history_id,history.id);
  assert.equal(String(consumption.original_base_net_minor),'10000');
  assert.equal(String(consumption.original_base_vat_minor),'2000');
  await assert.rejects(db.query(insert,[order.tenant_id,order.member_id,schedule,benefit]),{code:'PT409'});
  await assert.rejects(db.query(`UPDATE member_membership_history SET paid_at=now() WHERE id=$1`,[history.id]),{code:'23514'});
  ready=(await db.query('SELECT event_funnel_readiness() r')).rows[0].r;
  assert.equal(ready.schemaReady,true);assert.equal(ready.purchasing,false);
  assert.equal(ready.workersEnabled,false);
  await db.query('ALTER FUNCTION event_funnel_maintenance() RENAME TO fixture_maintenance_offline');
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.schemaReady,false);
  await db.query('ALTER FUNCTION fixture_maintenance_offline() RENAME TO event_funnel_maintenance');
  const sha='a'.repeat(40);
  await assert.rejects(db.query('UPDATE event_funnel_rollout SET workers_enabled=true'),{code:'23514'});
  await db.query(`UPDATE event_funnel_rollout SET reader_version=1,worker_version=1,verified_release=$1`,[sha]);
  // SQL CHECK NULL must not accidentally accept missing evidence.
  await assert.rejects(db.query('UPDATE event_funnel_rollout SET workers_enabled=true'),{code:'23514'});
  await db.query(`UPDATE event_funnel_rollout SET workers_enabled=true,
    verification_evidence='{"authenticatedCheckout":"isolated fixture evidence"}'`);
  await db.query('UPDATE event_funnel_rollout SET purchasing_enabled=true');
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.purchasing,false);
  assert.equal((await db.query(`SELECT event_funnel_worker_admission('recovery',1,$1) r`,['b'.repeat(40)])).rows[0].r.enabled,false);
  assert.equal((await db.query('SELECT count(*)::integer n FROM event_funnel_worker_health')).rows[0].n,0);
  for(const worker of ['recovery','reversals']) {
    assert.equal((await db.query('SELECT event_funnel_worker_admission($1,1,$2) r',[worker,sha])).rows[0].r.enabled,true);
  }
  ready=(await db.query('SELECT event_funnel_readiness() r')).rows[0].r;
  assert.equal(ready.purchasing,true);assert.equal(ready.workersHealthy,true);
  await db.query(`UPDATE event_funnel_worker_health SET seen_at=clock_timestamp()-interval '6 minutes' WHERE worker='reversals'`);
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.purchasing,false);
  await db.query('UPDATE event_funnel_rollout SET purchasing_enabled=false');
  assert.equal((await db.query(`SELECT event_funnel_worker_admission('recovery',1,$1) r`,[sha])).rows[0].r.enabled,true);
  await assert.rejects(db.query(`SELECT event_funnel_worker_admission('recovery',2,$1)`,[sha]),{code:'22023'});
  await assert.rejects(db.query(`SELECT event_funnel_worker_admission('unknown',1,$1)`,[sha]),{code:'22023'});
  // A newly reviewed deployment cannot adopt the preceding release's health.
  await db.query(`UPDATE event_funnel_rollout SET verified_release=$1,purchasing_enabled=true`,['c'.repeat(40)]);
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.purchasing,false);
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_readiness()'),{code:'42501'});
    await assert.rejects(db.query(`SELECT event_funnel_worker_admission('recovery',1,$1)`,[sha]),{code:'42501'});
    await assert.rejects(db.query('UPDATE event_funnel_rollout SET workers_enabled=true'),{code:'42501'});
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  assert.equal((await db.query('SELECT event_funnel_readiness() r')).rows[0].r.purchasing,false);
  await db.query('RESET ROLE');
  await db.query('UPDATE event_funnel_rollout SET purchasing_enabled=false,workers_enabled=false');
}
