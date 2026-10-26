import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('fixed monthly application is atomic with hold release and survives replay', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('monthly-finalization-');
  const clients = []; let started = false;
  const command = (name, args) => {
    const r = spawnSync(name, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  };
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    for (let n = 0; n < 3; n++) {
      const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c);
    }
    const [admin, a, b] = clients;
    await admin.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        billing_agreement_id uuid,status text,term_start_date date,membership_renewal_date date,
        commitment_snapshot jsonb);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,billing_agreement_id uuid);
      CREATE TABLE gocardless_collection_reservations(plan_id uuid,status text);
      CREATE TABLE gocardless_payments(plan_id uuid,status text);
      CREATE TABLE gocardless_payment_retry_attempts(plan_id uuid);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text);
      CREATE TABLE membership_tier_band(id uuid PRIMARY KEY,tenant_id uuid,config_id uuid);
      CREATE TABLE member_change_authority(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        source_record_id uuid,actor_kind text,authority jsonb);
      GRANT SELECT,UPDATE ON membership_payment_plans TO service_role;
    `);
    for (const file of ['202612310022_member_amendment_provider_operations.sql',
      '202612310025_member_monthly_finalization.sql']) {
      await admin.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    }
    await admin.query('INSERT INTO tenant VALUES($1)', [id(1)]);
    await admin.query('INSERT INTO member VALUES($1,$2)', [id(2), id(1)]);
    await admin.query('INSERT INTO membership_billing_agreements VALUES($1,$2,$3)', [id(4), id(1), id(2)]);
    await admin.query('INSERT INTO membership_payment_plans VALUES($1,$2,$3,$4)', [id(5), id(1), id(2), id(4)]);
    const source = (await admin.query(`INSERT INTO member_membership_history
      VALUES($1,$2,$3,$4,'active',CURRENT_DATE,CURRENT_DATE+365,'{"payment_frequency":"monthly"}')
      RETURNING to_jsonb(member_membership_history) v`, [id(3), id(1), id(2), id(4)])).rows[0].v;
    const target = (await admin.query(`INSERT INTO membership_tier_config
      VALUES($1,$2,'member') RETURNING to_jsonb(membership_tier_config) v`, [id(6), id(1)])).rows[0].v;
    const authority = {
      action: 'change', sourceSnapshot: source, targetSnapshot: target, targetBandSnapshot: null,
      fundingEvidence: { complete: true },
      calculation: { behaviour: 'retain_term', effectiveDate: source.term_start_date,
        surplusMinor: 0, finance: { blockers: [], available: { netMinor: 0, vatMinor: 0, grossMinor: 0 } },
        blockers: ['provider_schedule_coordination_required'],
        futureObligationMinor: 1000,
        newTerm: { startDate: source.term_start_date, renewalDate: source.membership_renewal_date } },
    };
    await admin.query('INSERT INTO member_change_authority VALUES($1,$2,$3,$4,$5,$6)',
      [id(7), id(1), id(2), id(3), 'admin', authority]);
    const prepared = { input: { changeAuthorityId: id(7), purchase: source,
      agreement: { id: id(4) }, plan: { id: id(5) }, effectiveDate: source.term_start_date },
      mutation: { kind: 'gc_amount' }, quote: { amountMinor: 1000, collectionDates: [source.term_start_date] } };
    const evidence = { status: 'provider_applied', fingerprint: 'a'.repeat(64) };
    await admin.query(`INSERT INTO member_amendment_provider_operation
      (id,tenant_id,member_id,source_record_id,plan_id,actor_id,operation_key,prepared,fingerprint,state,claim_token,evidence)
      VALUES($1,$2,$3,$4,$5,$6,'monthly-test',$7,$8,'provider_applied',$9,$10)`,
    [id(8), id(1), id(2), id(3), id(5), id(9), prepared, 'a'.repeat(64), id(10), evidence]);
    for (const c of [a, b]) await c.query('SET ROLE service_role');
    const finish = c => c.query('SELECT finalize_member_monthly_amendment($1,$2,$3,$4) v',
      [id(1), id(8), id(9), 'Approved retained-term change']);
    await assert.rejects(finish(a), /Durable finalization approval/);
    await a.query('SELECT approve_member_monthly_finalization($1,$2,$3,$4)',
      [id(1), id(8), id(9), 'Approved retained-term change']);
    await assert.rejects(a.query('SELECT approve_member_monthly_finalization($1,$2,$3,$4)',
      [id(1), id(8), id(9), 'Different approval']), /immutable/);
    assert.equal((await a.query('SELECT * FROM pending_member_monthly_finalizations(30)')).rows.length, 1);
    await admin.query("UPDATE member_amendment_provider_operation SET updated_at=now()-interval '2 minutes'");
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query('UPDATE member_amendment_provider_operation SET updated_at=now()');
    await admin.query("UPDATE membership_tier_config SET structure_scope_type='organization'");
    await assert.rejects(finish(a), /authority changed/);
    await admin.query("UPDATE membership_tier_config SET structure_scope_type='member'");
    const bad = structuredClone(authority);
    bad.calculation.futureObligationMinor = 999;
    await admin.query('UPDATE member_change_authority SET authority=$1', [bad]);
    await assert.rejects(finish(a), /differs from provider/);
    bad.calculation.futureObligationMinor = 1000;
    bad.calculation.surplusMinor = 1;
    await admin.query('UPDATE member_change_authority SET authority=$1', [bad]);
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query('UPDATE member_change_authority SET authority=$1', [authority]);
    await assert.rejects(a.query('UPDATE membership_payment_plans SET member_id=member_id'), /collection hold/);
    await admin.query(`CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected audit failure'; END $$;
      CREATE TRIGGER injected BEFORE INSERT ON member_amendment_provider_event
      FOR EACH ROW EXECUTE FUNCTION injected_failure()`);
    await assert.rejects(finish(a), /Injected/);
    assert.equal((await admin.query('SELECT state FROM member_amendment_provider_operation')).rows[0].state, 'provider_applied');
    await assert.rejects(a.query('UPDATE membership_payment_plans SET member_id=member_id'), /collection hold/);
    await admin.query('DROP TRIGGER injected ON member_amendment_provider_event');
    await admin.query("UPDATE member_amendment_provider_operation SET state='uncertain'");
    await assert.rejects(finish(a), /Verified monthly/);
    await admin.query("UPDATE member_amendment_provider_operation SET state='provider_applied'");
    const applications = await Promise.all([finish(a), finish(b)]);
    assert.deepEqual(applications[0].rows[0].v, applications[1].rows[0].v);
    assert.equal(applications[0].rows[0].v.targetSnapshot.config.id, id(6));
    await a.query('UPDATE membership_payment_plans SET member_id=member_id');
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_amendment_provider_event')).rows[0].n, 1);
    assert.equal((await a.query('SELECT * FROM pending_member_monthly_finalizations(30)')).rows.length, 0);
    assert.deepEqual((await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h')).rows[0].v, source);
    for (const role of ['anon', 'authenticated']) {
      await b.query(`SET ROLE ${role}`); await assert.rejects(finish(b), { code: '42501' });
    }
    // Dynamic changes have no provider subscription mutation: application and
    // future collection scope must commit in the same local transaction.
    await admin.query(`
      TRUNCATE member_amendment_provider_operation CASCADE;
      ALTER TABLE membership_payment_plans ADD COLUMN status text DEFAULT 'active',
        ADD COLUMN metadata jsonb DEFAULT '{"collection_mode":"dynamic"}', ADD COLUMN amount_minor integer DEFAULT 900;
      ALTER TABLE membership_billing_agreements ADD COLUMN metadata jsonb DEFAULT '{}';
      ALTER TABLE membership_tier_config ADD COLUMN dd_enabled boolean DEFAULT true,
        ADD COLUMN currency text DEFAULT 'GBP', ADD COLUMN dd_monthly_amount numeric DEFAULT 9;
      ALTER TABLE gocardless_collection_reservations ADD COLUMN due_date date, ADD COLUMN price_snapshot jsonb;
      ALTER TABLE gocardless_payments ADD COLUMN charge_date date;
    `);
    await admin.query(readFileSync('supabase/migrations/202612310026_member_dynamic_monthly_application.sql','utf8'));
    const dynamicTarget=(await admin.query('SELECT to_jsonb(c) v FROM membership_tier_config c')).rows[0].v;
    const dynamicPlan=(await admin.query('SELECT to_jsonb(p) v FROM membership_payment_plans p')).rows[0].v;
    const dynamicAgreement=(await admin.query('SELECT to_jsonb(g) v FROM membership_billing_agreements g')).rows[0].v;
    const dynamicInput={
      tenantId:id(1),memberId:id(2),amendmentId:`monthly-change:${id(7)}`,changeAuthorityId:id(7),
      purchase:source,plan:dynamicPlan,agreement:dynamicAgreement,effectiveDate:source.term_start_date,
      target:{amountMinor:900,currency:'GBP'},
      authority:{provider:'gocardless',pricingBasis:'monthly_price',currency:'GBP'},
    };
    const dynamicAuthority={
      ...authority,targetSnapshot:dynamicTarget,
      monthlyExecution:{version:1,providerAuthority:dynamicInput.authority,providerTarget:dynamicInput.target,
        providerFunding:{settledGrossMinor:0,pendingGrossMinor:0,payments:[]}},
      calculation:{...authority.calculation,version:3,currentMonthlyPriceMinor:900,futureObligationMinor:null},
    };
    await admin.query('UPDATE member_change_authority SET authority=$1',[dynamicAuthority]);
    const dynamicPrepared={input:dynamicInput,verifiedAt:new Date().toISOString(),fingerprint:'b'.repeat(64),
      mutation:{kind:'dynamic_revision_required'},quote:{amountMinor:900,collectionDates:[source.term_start_date]},
      funding:dynamicAuthority.monthlyExecution.providerFunding};
    const applyDynamic=(client,p=dynamicPrepared)=>client.query(
      'SELECT apply_member_dynamic_monthly_change($1,$2,$3,$4,$5,$6) v',
      [id(1),id(2),id(9),dynamicInput.amendmentId,'Approved dynamic change',p]);
    for(const role of ['anon','authenticated']){
      await b.query(`SET ROLE ${role}`);
      await assert.rejects(applyDynamic(b),{code:'42501'});
    }
    await b.query('SET ROLE service_role');
    await assert.rejects(applyDynamic(a,{...dynamicPrepared,verifiedAt:'2020-01-01T00:00:00Z'}),/Fresh approved/);
    await admin.query('UPDATE membership_tier_config SET dd_monthly_amount=10');
    await assert.rejects(applyDynamic(a),/Target monthly structure changed/);
    await admin.query('UPDATE membership_tier_config SET dd_monthly_amount=9');
    await admin.query(`CREATE FUNCTION fail_dynamic_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected dynamic audit failure'; END $$;
      CREATE TRIGGER fail_dynamic_audit BEFORE INSERT ON member_amendment_provider_event
        FOR EACH ROW EXECUTE FUNCTION fail_dynamic_audit()`);
    await assert.rejects(applyDynamic(a),/injected dynamic audit failure/);
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_amendment_provider_operation')).rows[0].n,0);
    await admin.query('DROP TRIGGER fail_dynamic_audit ON member_amendment_provider_event');
    const dynamics=await Promise.all([applyDynamic(a),applyDynamic(b)]);
    assert.equal(dynamics[0].rows[0].v.id,dynamics[1].rows[0].v.id);
    const revisionId=dynamics[0].rows[0].v.id;
    assert.equal(dynamics[0].rows[0].v.state,'finalized');
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_amendment_provider_event')).rows[0].n,1);
    await assert.rejects(admin.query(`INSERT INTO gocardless_collection_reservations
      (plan_id,status,due_date,price_snapshot) VALUES($1,'reserved',CURRENT_DATE,'{}')`,[id(5)]),/scope changed/);
    await admin.query(`INSERT INTO gocardless_collection_reservations
      (plan_id,status,due_date,price_snapshot) VALUES($1,'reserved',CURRENT_DATE,$2)`,
      [id(5),{membership_revision_id:revisionId,config_id:dynamicTarget.id,config:dynamicTarget,
        band:null,band_id:null,monthly_amount_minor:900}]);
    assert.deepEqual((await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h')).rows[0].v,source);
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_monthly_change_notification')).rows[0].n,1);
    const claims=await Promise.all([a,b].map(c=>c.query('SELECT claim_monthly_change_notification($1,$2) v',[id(1),revisionId])));
    assert.equal(claims.filter(c=>c.rows[0].v!==null).length,1);
    await admin.query(`UPDATE member_monthly_change_notification SET claimed_at=now()-interval '11 minutes'`);
    assert.equal((await a.query('SELECT * FROM pending_monthly_change_notifications(10)')).rows.length,0);
    assert.equal((await admin.query('SELECT state FROM member_monthly_change_notification')).rows[0].state,'uncertain');
    for(const role of ['anon','authenticated']){
      await b.query(`SET ROLE ${role}`);
      await assert.rejects(b.query('SELECT * FROM pending_monthly_change_notifications(10)'),{code:'42501'});
      await assert.rejects(b.query(`UPDATE member_monthly_change_notification SET state='pending'`),{code:'42501'});
    }
    await b.query('SET ROLE service_role');
    await admin.query('TRUNCATE member_amendment_provider_operation CASCADE; DELETE FROM gocardless_collection_reservations');
    const fixedFunding={payments:[],settledGrossMinor:0,pendingGrossMinor:0};
    const fixedAuthority={...authority,targetSnapshot:dynamicTarget,monthlyExecution:{providerFunding:fixedFunding}};
    await admin.query('UPDATE member_change_authority SET authority=$1',[fixedAuthority]);
    const fixedPrepared={...prepared,funding:fixedFunding};
    await admin.query(`INSERT INTO member_amendment_provider_operation
      (id,tenant_id,member_id,source_record_id,plan_id,actor_id,operation_key,prepared,fingerprint,state,claim_token,evidence)
      VALUES($1,$2,$3,$4,$5,$6,'monthly-test',$7,$8,'provider_applied',$9,$10)`,
      [id(8),id(1),id(2),id(3),id(5),id(9),fixedPrepared,'a'.repeat(64),id(10),
        {...evidence,evidence:{funding:fixedFunding}}]);
    await a.query('SELECT approve_member_monthly_finalization($1,$2,$3,$4)',[id(1),id(8),id(9),'Approved retained-term change']);
    await admin.query(`CREATE FUNCTION fail_future_amount_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected operational amount failure'; END $$;
      CREATE TRIGGER fail_future_amount_update BEFORE UPDATE OF amount_minor ON membership_payment_plans
        FOR EACH ROW EXECUTE FUNCTION fail_future_amount_update()`);
    await assert.rejects(finish(a),/injected operational amount failure/);
    assert.equal((await admin.query('SELECT state FROM member_amendment_provider_operation')).rows[0].state,'provider_applied');
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_monthly_change_notification')).rows[0].n,0);
    await admin.query('DROP TRIGGER fail_future_amount_update ON membership_payment_plans');
    await finish(a);
    assert.equal((await admin.query('SELECT amount_minor FROM membership_payment_plans')).rows[0].amount_minor,1000);
    assert.equal((await admin.query('SELECT count(*)::int n FROM member_monthly_change_notification')).rows[0].n,1);
  } finally {
    for (const c of clients) await c.end();
    if (started) command('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
