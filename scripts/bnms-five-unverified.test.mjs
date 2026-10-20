import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { TENANT, MEMBERS, TARGETS, hash, DISPLAY_FIELDS, buildUnverifiedRows, completeRows }
  from './prepare-bnms-five-unverified.mjs';
import { planIdempotentInserts } from './prepare-bnms-five-members.mjs';
import { assertThreePreserved, protectedTables, takeProtected, insertAndVerify, lockRepairScope } from './repair-bnms-five-unverified.mjs';
import { migrationSql, sqlHash, inspectSchema, assertInstalled, runMigration, historySnapshot, assertGuardPrivileges }
  from './prepare-member-history-unverified-migration.mjs';

// Synthetic evidence used ONLY in isolated tests; production requires exact hashes
// and original workbook bytes before it can even open a destination connection.
function fixture() {
  const terms = [
    [352,'Full Membership DD','2026-07-30',null],
    [3949,'Trainee Membership UK','2026-02-26','2027-01-31'],
    [1932,'LMIC Membership','2026-01-14','2027-01-12'],
    [175,'Junior Membership UK','2021-02-18','2026-08-25'],
    [3661,'Full Membership UK','2026-02-17','2027-02-17'],
  ];
  const evidence = MEMBERS.map(id => ({ member: { id,tenant_id: TENANT },
    prefs: [{ name: 'member_class',value: 'Fixture only' }], invoices: [],contacts: [] }));
  const source = terms.map(([row,membership,start,end], i) => ({
    row, sha256: 'eb6939e0e1d88357a54a988d9238f49ac1fb706d62643f8b61ea8f9d6560dc8c',
    file: 'attached_assets/fixture.xlsx',sheet: 'fixture',
    data: { 'iConnect UUID': MEMBERS[i],'Membership History - Membership': membership,
      'Membership History - Membership Start Date': `${start} 00:00:00`,
      ...(end ? { 'Membership History - Membership End Date': `${end} 00:00:00` } : {}) },
  }));
  source.push({ row:162,sha256:source[0].sha256,data: {
    'iConnect UUID':MEMBERS[3],'Membership History - Membership':'Guest',
    'Membership History - Membership Start Date':'2026-08-26 00:00:00',
  } });
  return { evidence,source };
}
test('only Lavinia and Aisha reconstructed, exact dates, no financial or renewal authority', () => {
  const f = fixture(), before = hash(f);
  const rows = buildUnverifiedRows(f.evidence, [], f.source);
  assert.deepEqual(rows.map(r => r.member_id), TARGETS);
  assert.deepEqual(rows.map(r => [r.term_start_date,r.term_end_date,r.status]),
    [['2026-02-26','2027-01-31','active'],['2021-02-18','2026-08-25','expired']]);
  for (const row of rows) {
    assert.equal(row.payment_status,'unverified');
    assert.ok(Object.keys(row).every(k => DISPLAY_FIELDS.includes(k)));
    const notes = JSON.parse(row.notes);
    assert.equal(notes.paymentAuthority,'unknown_not_inferred');
    assert.equal(notes.invoiceAuthority,'not_verified_not_linked');
    assert.equal(notes.renewalAuthority,false);
    assert.equal(notes.futureCollectionConsent,false);
    assert.equal(notes.purchasedRollingCommitment,false);
  }
  assert.equal(hash(f),before);
});
test('tampered source dates, former Guest transition, financial decision or scope fail closed', () => {
  for (const mutate of [
    f => { f.source[1].data['Membership History - Membership Start Date']='2026-01-31 00:00:00'; },
    f => { f.source[3].data['Membership History - Membership End Date']='2027-08-25 00:00:00'; },
    f => { f.source.pop(); },
    f => { f.evidence.pop(); },
  ]) {
    const f=fixture(); mutate(f);
    assert.throws(() => buildUnverifiedRows(f.evidence,[],f.source));
  }
  const f=fixture();
  assert.throws(() => buildUnverifiedRows(f.evidence,[{memberId:TARGETS[0]}],f.source),/financial evidence/);
});
test('explicit full NULL payload suppresses defaults; replay detects drift instead of ignoring conflict', () => {
  const f=fixture(), rows=buildUnverifiedRows(f.evidence,[],f.source);
  const columns=[...new Set([...DISPLAY_FIELDS,'annual_cost','currency','billing_period','free_period_discount'])]
    .map(column_name => ({column_name,is_nullable:column_name==='id'?'NO':'YES'}));
  const full=completeRows(rows,columns,'2026-10-20T12:00:00.000Z');
  for(const row of full) for(const key of ['annual_cost','currency','billing_period','free_period_discount']) assert.equal(row[key],null);
  assert.equal(planIdempotentInserts(full,[]).pending.length,2);
  assert.equal(planIdempotentInserts(full,full).replayed.length,2);
  assert.throws(() => planIdempotentInserts(full,[{...full[0],payment_status:'paid'}]),/changed/);
  assert.throws(() => planIdempotentInserts(full,[{...full[0],id:'other'}]),/Other history/);
});
test('all three approved paid histories must remain byte-for-byte unchanged', () => {
  const expected=MEMBERS.filter(id=>!TARGETS.includes(id)).map(id=>({id,member_id:id,payment_status:'paid',paid_at:'2026-01-01T00:00:00Z'}));
  assertThreePreserved(structuredClone(expected),expected);
  for(const index of [0,1,2]) {
    const changed=structuredClone(expected); changed[index].payment_status='unpaid';
    assert.throws(()=>assertThreePreserved(changed,expected),/changed/);
  }
});
test('migration exact-pin validation rejects before connecting; default mode is offline', async () => {
  const sql=await migrationSql(), pin=sqlHash(sql);
  const run=args=>spawnSync(process.execPath,['scripts/prepare-member-history-unverified-migration.mjs',...args],
    {encoding:'utf8',env:{...process.env,DEST_DATABASE_URL:'invalid',DEST_SUPABASE_URL:'invalid'}});
  const offline=run([]);
  assert.equal(offline.status,0,offline.stderr);
  assert.equal(JSON.parse(offline.stdout).sha256,pin);
  assert.equal(run(['--apply',`--review-sha256=${'0'.repeat(64)}`]).status,1);
  assert.equal(run(['--apply']).status,1);
});
test('migration schema drift rolls back without executing DDL', async () => {
  const queries=[];
  const fake={query:async sql=>{queries.push(sql);return {rows:[]};}};
  await assert.rejects(runMigration(fake,await migrationSql(),{apply:true}),/schema changed/);
  assert.equal(queries.at(-1),'ROLLBACK');
  assert.ok(!queries.some(q=>q.includes('ALTER TABLE')));
});

test('isolated PostgreSQL: DB boundary blocks every financial field, transition, replacement and trigger-injected authority', async t => {
  const root=mkdtempSync(path.join(os.tmpdir(),'bnms-unverified-pg-')), data=path.join(root,'data'),socket=path.join(root,'socket');
  mkdirSync(socket);
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  const db=new pg.Client({host:socket,port:55479,user:'postgres',database:'postgres'});
  let started=false;
  // All 66 reviewed destination columns, with representative existing defaults.
  const groups={
    uuid:['id','tenant_id','member_id','config_id','band_id','billing_agreement_id','previous_term_id','membership_payment_quote_id','membership_successor_election_id'],
    numeric:['annual_cost','prorata_cost','free_period_discount','rollover_discount','final_cost','custom_discount_total','vat_rate_percent','vat_amount','total_with_vat'],
    integer:['year_number','prorata_days','free_period_days_applied','term_duration_months'],
    boolean:['override_applied'],
    jsonb:['custom_discount_details','commitment_snapshot','incentive_snapshot','renewal_policy_snapshot'],
    date:['term_start_date','term_end_date','scheduled_activation_date','membership_renewal_date','term_anchor_date'],
    timestamptz:['created_at','updated_at','paid_at','annual_renewal_processed_at','expiry_enforced_at','cancelled_for_switch_at'],
    text:['membership_year','tier_label','field_value','currency','billing_period','status','notes','xero_invoice_id','xero_invoice_number',
      'purchase_order_number','payment_method','stripe_payment_intent_id','vat_rate','override_type','accounting_provider',
      'accounting_invoice_id','accounting_invoice_number','accounting_credit_note_id','accounting_credit_note_number',
      'accounting_sync_status','accounting_sync_error','payment_status','annual_renewal_state','annual_renewal_idempotency_key',
      'expiry_enforcement_key','term_key','accounting_online_invoice_url','xero_online_invoice_url'],
  };
  const types=Object.fromEntries(Object.entries(groups).flatMap(([type,names])=>names.map(name=>[name,type])));
  const defaults={id:'gen_random_uuid()',payment_status:"'unpaid'",status:"'active'",currency:"'GBP'",billing_period:"'annual'",
    free_period_discount:'0',rollover_discount:'0',custom_discount_total:'0',override_applied:'false',created_at:'now()',updated_at:'now()'};
  const required=['id','tenant_id','member_id','membership_year','payment_status'];
  let next=100;
  const fresh=()=>({
    ...Object.fromEntries(Object.keys(types).map(k=>[k,null])),
    id:`00000000-0000-4000-8000-${String(next++).padStart(12,'0')}`,
    tenant_id:TENANT,member_id:TARGETS[0],membership_year:'Fixture only',tier_label:'Source tier',
    payment_status:'unverified',status:'active',term_start_date:'2026-02-26',term_end_date:'2027-01-31',
    notes:'{"source":"bnms_five_member_reconstruction_v1","paymentAuthority":"unknown_not_inferred","approvalScope":"two_unverified_display_only_histories"}',
  });
  const insert=async row=>{
    const keys=Object.keys(row);
    return db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,
      keys.map(k=>row[k]));
  };
  const invalid=async row=>assert.rejects(insert(row),e=>e.code==='23514');
  try {
    run('initdb',['-D',data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'pg.log'),'-o',`-F -k ${socket} -c listen_addresses= -p 55479`,'-w','start']);started=true;
    await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE fixture_member(id uuid PRIMARY KEY,email text,login_enabled boolean);
      CREATE TABLE tenant(id uuid PRIMARY KEY,slug text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY,member_id uuid,field_id uuid,value text);
      CREATE TABLE member_membership_history (
      ${Object.entries(types).map(([name,type])=>`${name} ${type}${required.includes(name)?' NOT NULL':''}${defaults[name]?` DEFAULT ${defaults[name]}`:''}`).join(',')},
      CONSTRAINT member_membership_history_payment_status_chk CHECK(payment_status IN ('unpaid','paid','partial','voided')),
      PRIMARY KEY(id), FOREIGN KEY(member_id) REFERENCES fixture_member(id) ON DELETE CASCADE);
      CREATE TABLE fixture_protected (id int PRIMARY KEY,payload jsonb);
      INSERT INTO fixture_protected VALUES (1,'{"must":"preserve"}');
      CREATE FUNCTION protect_membership_incentive_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.incentive_snapshot IS DISTINCT FROM OLD.incentive_snapshot THEN
      RAISE EXCEPTION 'Original membership incentive evidence is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER protect_membership_incentive_snapshot BEFORE UPDATE ON member_membership_history
      FOR EACH ROW EXECUTE FUNCTION protect_membership_incentive_snapshot();`);
    for(const id of MEMBERS) await db.query("INSERT INTO fixture_member VALUES($1,'fixture@example.invalid',true)",[id]);
    await db.query("INSERT INTO tenant VALUES($1,'bnms')",[TENANT]);
    for(const id of MEMBERS) await db.query('INSERT INTO member VALUES($1,$2)',[id,TENANT]);
    const fieldId='00000000-0000-4000-8000-000000000050';
    await db.query('INSERT INTO preference_field VALUES($1,$2)',[fieldId,TENANT]);
    for(const [index,id] of TARGETS.entries()) await db.query('INSERT INTO member_preference_value VALUES($1,$2,$3,$4)',
      [`00000000-0000-4000-8000-${String(60+index).padStart(12,'0')}`,id,fieldId,'retained source fixture']);
    const paid=[];
    for(const member_id of MEMBERS.filter(id=>!TARGETS.includes(id))) {
      const row={...fresh(),member_id,payment_status:'paid',total_with_vat:156,accounting_invoice_id:`fixture-${member_id}`,notes:'verified fixture'};
      await insert(row);paid.push(row.id);
    }
    const before=await inspectSchema(db);
    const paidBefore=(await db.query('SELECT to_jsonb(h) data FROM member_membership_history h ORDER BY id')).rows;
    const sql=await migrationSql();
    await db.query('BEGIN');await db.query(sql);await db.query('ROLLBACK');
    assert.deepEqual(await inspectSchema(db),before,'Rolled-back schema rehearsal changed schema');
    await db.query(sql);
    await assertGuardPrivileges(db);
    const after=await inspectSchema(db);
    // Production baseline pin intentionally differs from this isolated fixture.
    // Reaching the FINAL baseline comparison proves real PostgreSQL rendered the
    // exact expected constraint, both triggers, search path and function body.
    assert.throws(()=>assertInstalled(after,sql),/Pre-existing columns\/defaults\/constraints\/triggers\/indexes changed/);
    assert.deepEqual(after.columns,before.columns,'NOT NULL/defaults changed');
    assert.deepEqual(after.indexes,before.indexes);
    for(const trigger of before.triggers) assert.deepEqual(after.triggers.find(x=>x.tgname===trigger.tgname),trigger);
    assert.deepEqual((await db.query('SELECT to_jsonb(h) data FROM member_membership_history h ORDER BY id')).rows,paidBefore);
    const valid=fresh();await insert(valid);
    const expired={...fresh(),member_id:MEMBERS[3],status:'expired'};await insert(expired);
    await t.test('every non-display destination column rejects non-NULL, even zero and false',async()=>{
      const sample={uuid:'00000000-0000-4000-8000-000000000099',numeric:0,integer:0,boolean:false,jsonb:{},
        date:'2026-01-01',timestamptz:'2026-01-01T00:00:00Z',text:'malicious'};
      for(const [column,type] of Object.entries(types)) if(!DISPLAY_FIELDS.includes(column)) await invalid({...fresh(),[column]:sample[type]});
    });
    await t.test('defaults remain unchanged and therefore cannot silently imply free/unpaid financial data',async()=>{
      await assert.rejects(db.query(`INSERT INTO member_membership_history(tenant_id,member_id,membership_year,payment_status)
        VALUES($1,$2,'default trap','unverified')`,[TENANT,TARGETS[0]]),e=>e.code==='23514');
      await assert.rejects(insert({...fresh(),payment_status:null,notes:null}),e=>e.code==='23502');
      await invalid({...fresh(),payment_status:'unknown'});
      await invalid({...fresh(),notes:'{invalid source JSON'});
      await invalid({...fresh(),payment_status:'paid'});
      const existing=paid[0];
      await db.query('UPDATE member_membership_history SET notes=notes WHERE id=$1',[existing]);
    });
    await t.test('all payment-status transitions out, and transitions in, are blocked',async()=>{
      for(const status of ['paid','unpaid','partial','voided',null]) {
        await assert.rejects(db.query('UPDATE member_membership_history SET payment_status=$1 WHERE id=$2',[status,valid.id]),e=>e.code==='23514');
      }
      await assert.rejects(db.query("UPDATE member_membership_history SET payment_status='unverified' WHERE id=$1",[paid[0]]),e=>e.code==='23514');
      for(const status of ['unpaid','partial','voided']) {
        const old={...fresh(),payment_status:status,notes:'old financial fixture'};await insert(old);
        await assert.rejects(db.query("UPDATE member_membership_history SET payment_status='unverified' WHERE id=$1",[old.id]),e=>e.code==='23514');
      }
    });
    await t.test('financial mutation, source tampering, reassignment, date change and replacement fail',async()=>{
      for(const [field,value] of Object.entries({annual_cost:0,paid_at:'2026-01-01',accounting_invoice_id:'fake',notes:'{}',
        tenant_id:'00000000-0000-4000-8000-000000000099',term_start_date:'2026-01-01'})) {
        await assert.rejects(db.query(`UPDATE member_membership_history SET ${field}=$1 WHERE id=$2`,[value,valid.id]),e=>e.code==='23514');
      }
      await assert.rejects(db.query('DELETE FROM member_membership_history WHERE id=$1',[valid.id]),e=>e.code==='23514');
      await assert.rejects(db.query(`INSERT INTO member_membership_history SELECT * FROM member_membership_history WHERE id=$1
        ON CONFLICT(id) DO UPDATE SET payment_status='paid'`,[valid.id]),e=>e.code==='23514');
    });
    await t.test('Aisha cannot activate; ordinary expiry and source-preserving timestamp updates work',async()=>{
      await assert.rejects(db.query("UPDATE member_membership_history SET status='active' WHERE id=$1",[expired.id]),e=>e.code==='23514');
      await db.query("UPDATE member_membership_history SET status='expired',updated_at=now() WHERE id=$1",[valid.id]);
      await db.query('UPDATE member_membership_history SET updated_at=now() WHERE id=$1',[expired.id]);
    });
    await t.test('AFTER boundary also rejects authority injected by a later existing/source trigger',async()=>{
      await db.query(`CREATE FUNCTION fixture_late_injection() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.payment_status='unverified' THEN NEW.accounting_invoice_id='injected'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER zzz_fixture_late BEFORE INSERT OR UPDATE ON member_membership_history
        FOR EACH ROW EXECUTE FUNCTION fixture_late_injection()`);
      await invalid(fresh());
      await assert.rejects(db.query('UPDATE member_membership_history SET updated_at=now() WHERE id=$1',[expired.id]),e=>e.code==='23514');
      await db.query('DROP TRIGGER zzz_fixture_late ON member_membership_history');
    });
    await t.test('source guard covers INSERT and UPDATE after earlier/later status-relabeling triggers',async()=>{
      for(const name of ['aaa_fixture_status','zzz_fixture_status']) {
        await db.query(`CREATE OR REPLACE FUNCTION fixture_status_injection() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.payment_status='unverified' THEN NEW.payment_status='paid'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON member_membership_history
          FOR EACH ROW EXECUTE FUNCTION fixture_status_injection()`);
        await invalid(fresh());
        await assert.rejects(db.query('UPDATE member_membership_history SET updated_at=now() WHERE id=$1',[expired.id]),e=>e.code==='23514');
        await db.query(`DROP TRIGGER ${name} ON member_membership_history`);
      }
    });
    await t.test('ordinary member anonymisation retains history; hard cascade cannot erase the guard',async()=>{
      await db.query("UPDATE fixture_member SET email='deleted@deleted.local',login_enabled=false WHERE id=$1",[expired.member_id]);
      assert.equal((await db.query('SELECT count(*)::int n FROM member_membership_history WHERE id=$1',[expired.id])).rows[0].n,1);
      await assert.rejects(db.query('DELETE FROM fixture_member WHERE id=$1',[expired.member_id]),e=>e.code==='23514');
      assert.equal((await db.query('SELECT count(*)::int n FROM fixture_member WHERE id=$1',[expired.member_id])).rows[0].n,1);
    });
    await t.test('future authority columns fail closed; existing paid rows and tables remain unchanged',async()=>{
      await db.query('ALTER TABLE member_membership_history ADD COLUMN future_billing_authority text');
      await invalid({...fresh(),future_billing_authority:'forged'});
      await db.query('ALTER TABLE member_membership_history DROP COLUMN future_billing_authority');
      const paidAfter=(await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=ANY($1::uuid[]) ORDER BY id',[paid])).rows;
      assert.deepEqual(paidAfter,paidBefore);
      assert.deepEqual((await db.query('SELECT * FROM fixture_protected')).rows,[{id:1,payload:{must:'preserve'}}]);
    });
    await t.test('real repair mutation core: rollback, commit, no-op replay, complete-table fingerprints and trigger side-effect rollback',async()=>{
      const rows=[fresh(),fresh()].map((row,index)=>({...row,
        member_id:`00000000-0000-4000-8000-${String(900+index).padStart(12,'0')}`}));
      for(const row of rows)await db.query("INSERT INTO fixture_member VALUES($1,'repair@example.invalid',true)",[row.member_id]);
      const tables=await protectedTables(db);
      assert.ok(tables.includes('fixture_protected')&&tables.includes('fixture_member'),'Non-regex tables excluded');
      const plan={rows,tables,historyBefore:await historySnapshot(db),protectedBefore:await takeProtected(db,tables)};
      await db.query('BEGIN');
      await lockRepairScope(db);
      const locks=(await db.query(`SELECT c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE l.pid=pg_backend_pid() AND n.nspname='public'`)).rows;
      assert.deepEqual(locks.filter(l=>['ShareRowExclusiveLock','ShareLock','ExclusiveLock','AccessExclusiveLock'].includes(l.mode)),
        [{relname:'member_membership_history',mode:'ShareRowExclusiveLock'}],
        'Repair must not broadly write-lock protected tables');
      assert.ok(locks.some(l=>l.relname==='member'&&l.mode==='RowShareLock'));
      assert.ok(locks.some(l=>l.relname==='member_preference_value'&&l.mode==='RowShareLock'));
      assert.equal((await insertAndVerify(db,plan)).pending,2);
      await db.query('ROLLBACK');
      assert.deepEqual(await historySnapshot(db),plan.historyBefore);
      await db.query(`CREATE FUNCTION fixture_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE fixture_protected SET payload='{"changed":true}'; RETURN NEW; END $$;
        CREATE TRIGGER fixture_side_effect AFTER INSERT ON member_membership_history
        FOR EACH ROW EXECUTE FUNCTION fixture_side_effect()`);
      await db.query('BEGIN');
      await assert.rejects(insertAndVerify(db,plan),/Protected whole rows changed/);
      await db.query('ROLLBACK');
      assert.deepEqual(await takeProtected(db,tables),plan.protectedBefore);
      assert.deepEqual(await historySnapshot(db),plan.historyBefore);
      await db.query('DROP TRIGGER fixture_side_effect ON member_membership_history');
      await db.query('BEGIN');
      assert.equal((await insertAndVerify(db,plan)).pending,2);
      await db.query('COMMIT');
      await db.query('BEGIN');
      const replay=await insertAndVerify(db,plan,{replay:true});
      assert.equal(replay.pending,0);assert.equal(replay.replayed,2);
      await db.query('ROLLBACK');
      await db.query("UPDATE fixture_protected SET payload='{\"stale\":true}'");
      await db.query('BEGIN');
      await assert.rejects(insertAndVerify(db,plan,{replay:true}),/Protected tables changed after review/);
      await db.query('ROLLBACK');
      await db.query('BEGIN');
      const refreshJournal=[];
      const refreshed=await insertAndVerify(db,plan,{replay:true,refreshUnrelated:true,journal:async entry=>refreshJournal.push(entry)});
      assert.equal(refreshed.pending,0);
      assert.equal(refreshed.replayed,2);
      assert.equal(refreshJournal[0].phase,'unrelated_baseline_refreshed');
      assert.deepEqual(refreshJournal[0].changedTables,['fixture_protected']);
      assert.equal(refreshJournal[0].exactHistoryAndTargetContextRevalidated,true);
      await db.query('ROLLBACK');
    });
  } finally {
    await db.end().catch(()=>{});
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(root,{recursive:true,force:true});
  }
});
