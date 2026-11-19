import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { correctUniversity, gfi, verifyUniversity } from './apply-membership-structure-handover.mjs';
import { calculateMembershipYearWindow } from '../api/_lib/membershipYear.js';
import { createMembershipConfigResolver } from '../api/_lib/membershipConfigResolverCore.js';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
test('atomic structure timelines, concurrent saves, failure rollback and exact GFI repair (disposable PostgreSQL)', async t => {
  const h = await createLocalPostgresHarness('membership-handover-');
  const run = (cmd,args) => { const r = spawnSync(cmd,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  let db, started = false;
  const connection = { host:h.socket, port:h.port, user:'postgres', database:'postgres' };
  const config = (start, extra = {}) => ({ name:'University', structure_scope_type:'organization',
    structure_field_id:id(8), structure_match_value:'University', effective_from:start,
    membership_start_month:8, membership_start_day:1, start_mode:'fixed_date', flat_cost:100, ...extra });
  const save = async (start, { configId=null, tenant=id(1), extra={}, children={} } = {}, client=db) =>
    (await client.query('SELECT save_membership_structure($1,$2,$3,$4) row',
      [tenant,configId,config(start,extra),children])).rows[0].row;
  const timeline = async (tenant=id(1)) => (await db.query(`SELECT to_jsonb(c) row FROM membership_tier_config c
    WHERE tenant_id=$1 ORDER BY effective_from NULLS FIRST,id`,[tenant])).rows.map(r=>r.row);
  const clear = async () => db.query('TRUNCATE membership_tier_config, membership_structure_schedule_audit, membership_tier_band, membership_tier_discount, membership_tier_vat_override, membership_tier_reminder');
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started = true;
    db = new pg.Client(connection); await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE membership_tier_config(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text,
        effective_from date, effective_to date, structure_scope_type text DEFAULT 'organization',
        structure_field_id uuid, structure_match_value text, flat_cost numeric,
        membership_start_month int DEFAULT 1,membership_start_day int DEFAULT 1,
        start_mode text DEFAULT 'fixed_date',is_active boolean DEFAULT true,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE membership_tier_band(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,config_id uuid,
        label text CHECK(label <> 'FAIL'),annual_cost numeric,min_value numeric,max_value numeric,display_order int,
        vat_rate text,match_value text,dd_monthly_amount numeric,nominal_code text);
      CREATE TABLE membership_tier_discount(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,config_id uuid,
        field_id uuid,field_label text,match_value text,match_condition text,discount_type text,discount_value numeric,label text,sort_order int);
      CREATE TABLE membership_tier_vat_override(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,config_id uuid,
        field_id uuid,field_label text,match_value text,match_condition text,vat_rate text,label text,sort_order int);
      CREATE TABLE membership_tier_reminder(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,config_id uuid,
        label text CHECK(label <> 'FAIL'),offset_value int,offset_unit text,direction text,email_template_id uuid,recipient_role_ids uuid[],is_active boolean,sort_order int);
      CREATE TABLE purchased_evidence(id uuid,commitment_snapshot jsonb,invoice jsonb,mandate jsonb);
      INSERT INTO purchased_evidence VALUES('${id(99)}','{"cost":75,"term_end":"2027-07-31"}','{"total":75}','{"monthly_amount":6.25}');`);
    const evidence = (await db.query('SELECT * FROM purchased_evidence')).rows;
    const sql = readFileSync('supabase/migrations/202701220001_membership_structure_handover.sql','utf8');
    await db.query(sql); await db.query(sql); // idempotent installation
    await t.test('immediate and future replacement cap finite predecessors inclusively', async () => {
      const a = await save('2025-08-01');
      await db.query('UPDATE membership_tier_config SET effective_to=$1 WHERE id=$2',['2027-07-31',a.id]);
      const b = await save('2026-11-19',{children:{bands:[{label:'New',annual_cost:125}]}});
      const rows = await timeline();
      assert.equal(rows[0].effective_to,'2026-11-18'); assert.equal(rows[1].effective_to,null);
      const before = rows.filter(r=>r.effective_from<='2026-11-18' && (!r.effective_to || r.effective_to>='2026-11-18'));
      const after = rows.filter(r=>r.effective_from<='2026-11-19' && (!r.effective_to || r.effective_to>='2026-11-19'));
      assert.deepEqual(before.map(r=>r.id),[a.id]); assert.deepEqual(after.map(r=>r.id),[b.id]);
      // Real resolver, with a controlled query adapter reading disposable rows.
      const resolver = createMembershipConfigResolver({from(table) {
        assert.equal(table,'membership_tier_config');
        const filters=[];const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},
          or(expr){ const m=expr.match(/(effective_from|effective_to)\.is\.null,\1\.(lte|gte)\.(.*)/);
            assert.ok(m,expr);filters.push(r=>!r[m[1]] || (m[2]==='lte'?r[m[1]]<=m[3]:r[m[1]]>=m[3]));return q; },
          order(){return q;},async then(resolve,reject){try{return resolve({data:(await timeline()).filter(r=>filters.every(f=>f(r))).reverse()});}catch(e){return reject(e);}}};return q;
      }});
      assert.equal((await resolver.getConfigForOrganisation(id(1),id(2),{[id(8)]:'University'},'2026-11-18')).id,a.id);
      assert.equal((await resolver.getConfigForOrganisation(id(1),id(2),{[id(8)]:'University'},'2026-11-19')).id,b.id);
      for(const r of rows) {
        const year=calculateMembershipYearWindow(r,new Date('2026-11-19T12:00:00Z'));
        assert.equal(year.start.getMonth(),7);assert.equal(year.start.getDate(),1);
        assert.equal(year.end.getMonth(),6);assert.equal(year.end.getDate(),31);
      }
    });
    await clear();
    await t.test('scheduled finite neighbours are retained and new versions fit between them', async () => {
      const a=await save('2026-01-01');const c=await save('2027-01-01');await save('2028-01-01');
      const b=await save('2026-11-19');
      const rows=await timeline();
      assert.equal(rows.length,4);
      assert.equal(rows.find(r=>r.id===a.id).effective_to,'2026-11-18');
      assert.equal(rows.find(r=>r.id===b.id).effective_to,'2026-12-31');
      assert.equal(rows.find(r=>r.id===c.id).effective_to,'2027-12-31');
    });
    await clear();
    await t.test('duplication, editable start moves, immutable retained rows and same-day conflicts', async () => {
      const a=await save('2026-01-01');
      const b=await save('2027-01-01',{extra:{name:'Duplicate',flat_cost:a.flat_cost}});
      await save('2027-02-01',{configId:b.id});
      assert.equal((await timeline())[0].effective_to,'2027-01-31');
      await save('2026-11-19',{configId:b.id});
      assert.equal((await timeline())[0].effective_to,'2026-11-18');
      await assert.rejects(save('2026-11-19'),e=>e.code==='PT409');
      await assert.rejects(save('2026-01-01',{configId:b.id}),e=>e.code==='PT409');
      await assert.rejects(save('2025-01-01',{configId:a.id}),e=>e.code==='PT409');
      await assert.rejects(save('2027-03-01',{configId:b.id,extra:{structure_scope_type:'member'}}),e=>e.code==='PT409');
      await assert.rejects(save('2027-03-01',{configId:b.id,tenant:id(3)}),e=>e.code==='PT409');
    });
    await clear();
    await t.test('tenant, entity type, field and normalized value scopes remain independent', async () => {
      await save('2026-01-01');await save('2026-01-01',{tenant:id(3)});
      await save('2026-01-01',{extra:{structure_scope_type:'member'}});
      await save('2026-01-01',{extra:{structure_field_id:id(9)}});
      await save('2026-01-01',{extra:{structure_match_value:'Partner'}});
      await save('2026-11-19',{extra:{structure_match_value:' university '}});
      const all=(await timeline()).concat(await timeline(id(3)));
      assert.equal(all.filter(r=>r.effective_to!==null).length,1);
      assert.equal(all.find(r=>r.effective_to!==null).structure_match_value,'University');
      await save('2026-01-01',{extra:{structure_field_id:null,structure_match_value:null}});
      await save('2026-01-01',{extra:{structure_scope_type:'member',structure_field_id:null,structure_match_value:null}});
    });
    await clear();
    await t.test('existing older overlaps reproduce first-current-only bug and are capped without deletions', async () => {
      await db.query('ALTER TABLE membership_tier_config DISABLE TRIGGER membership_structure_schedule_check');
      await db.query(`INSERT INTO membership_tier_config(tenant_id,effective_from,effective_to,structure_field_id,structure_match_value)
        VALUES($1,'2025-08-01','2027-07-31',$2,'University'),($1,'2026-08-01',NULL,$2,'University')`,[id(1),id(8)]);
      await db.query('ALTER TABLE membership_tier_config ENABLE TRIGGER membership_structure_schedule_check');
      await save('2026-11-19');
      assert.deepEqual((await timeline()).map(r=>[r.effective_from,r.effective_to]),
        [['2025-08-01','2026-07-31'],['2026-08-01','2026-11-18'],['2026-11-19',null]]);
    });
    await clear();
    await t.test('config and all child writes roll back with predecessor and audit on failure', async () => {
      const a=await save('2026-01-01',{children:{bands:[{label:'Original',annual_cost:75}]}});
      const before=await timeline();const audit=(await db.query('SELECT * FROM membership_structure_schedule_audit')).rows;
      await assert.rejects(save('2026-11-19',{children:{bands:[{label:'FAIL',annual_cost:125}]}}),e=>e.code==='23514');
      await assert.rejects(save('2026-11-19',{configId:a.id,children:{bands:[{label:'FAIL'}]}}),e=>e.code==='23514');
      await assert.rejects(save('2026-11-19',{children:{
        bands:[{label:'New',annual_cost:125}],
        discounts:[{label:'New discount',discount_value:10}],
        vatOverrides:[{label:'New VAT',vat_rate:'20'}],
        reminders:[{label:'FAIL'}],
      }}),e=>e.code==='23514');
      assert.deepEqual(await timeline(),before);
      assert.deepEqual((await db.query('SELECT * FROM membership_structure_schedule_audit')).rows,audit);
      assert.equal((await db.query('SELECT label FROM membership_tier_band')).rows[0].label,'Original');
      for(const table of ['membership_tier_discount','membership_tier_vat_override','membership_tier_reminder']) {
        assert.equal((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count,'0');
      }
    });
    await clear();
    await t.test('concurrent creates serialize including empty scopes and same-day collisions', async () => {
      const second=new pg.Client(connection);await second.connect();
      try {
        await Promise.all([save('2026-11-19'),save('2027-01-01',{},second)]);
        assert.deepEqual((await timeline()).map(r=>r.effective_to),['2026-12-31',null]);
        const results=await Promise.allSettled([save('2027-02-01'),save('2027-02-01',{},second)]);
        assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
        assert.equal(results.find(r=>r.status==='rejected').reason.code,'PT409');
        const latest=(await timeline()).at(-1);
        await Promise.all([save('2027-03-01',{configId:latest.id}),save('2027-04-01',{configId:latest.id},second)]);
        const rows=await timeline();
        assert.equal(rows.length,3);
        assert.equal(rows[1].effective_to, rows[2].effective_from==='2027-03-01'?'2027-02-28':'2027-03-31');
      } finally {await second.end();}
    });
    await clear();
    await t.test('legacy direct writes cannot commit an overlapping schedule', async () => {
      await save('2026-01-01');
      await assert.rejects(db.query(`INSERT INTO membership_tier_config(tenant_id,structure_field_id,structure_match_value,effective_from)
        VALUES($1,$2,'University','2026-11-19')`,[id(1),id(8)]),e=>e.code==='PT409');
      assert.equal((await timeline()).length,1);
    });
    await clear();
    await t.test('exact approved GFI correction is narrow, rejects drift and replays with no writes', async () => {
      const rows=[
        { ...config('2025-08-01'),id:gfi.ids[0],effective_to:'2027-07-31' },
        { ...config('2026-08-01'),id:gfi.ids[1],effective_to:'2026-11-18' },
        { ...config('2026-11-19'),id:gfi.ids[2],effective_to:null },
      ];
      await db.query('ALTER TABLE membership_tier_config DISABLE TRIGGER membership_structure_schedule_check');
      for(const r of rows) await db.query(`INSERT INTO membership_tier_config SELECT * FROM
        jsonb_populate_record(NULL::membership_tier_config,$1)`,[{...r,tenant_id:gfi.tenant,structure_field_id:gfi.field,is_active:true}]);
      await db.query('ALTER TABLE membership_tier_config ENABLE TRIGGER membership_structure_schedule_check');
      const drift=await timeline(gfi.tenant);drift[1].effective_from='2026-08-02';
      assert.throws(()=>verifyUniversity(drift),/differs/);
      await db.query('BEGIN');assert.equal((await correctUniversity(db)).changed,true);await db.query('COMMIT');
      await db.query('BEGIN');assert.equal((await correctUniversity(db)).changed,false);await db.query('COMMIT');
      verifyUniversity(await timeline(gfi.tenant),true);
      assert.equal((await db.query('SELECT count(*) FROM membership_structure_schedule_audit')).rows[0].count,'1');
    });
    await t.test('browser roles cannot save and purchased financial evidence stays unchanged', async () => {
      await db.query('SET ROLE service_role');
      await save('2026-11-19');
      await db.query('RESET ROLE');
      await db.query('SET ROLE authenticated');
      await assert.rejects(save('2026-11-19'),/permission denied/);
      await db.query('RESET ROLE');
      assert.deepEqual((await db.query('SELECT * FROM purchased_evidence')).rows,evidence);
    });
  } finally {
    await db?.end();
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{stdio:'ignore'});
    await h.cleanup();
  }
});
