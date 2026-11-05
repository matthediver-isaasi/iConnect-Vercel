import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { createAlphabetFilterRecorder } from '../api/_lib/crmAlphabetQuery.js';
import { memberAlphabetRecorder, organizationAlphabetRecorder } from '../api/_lib/crmAlphabet.js';
import { parseMemberListFilters, applyMemberListFilters } from '../api/_lib/memberListFilters.js';
import { applyPrefFilterEntry } from '../api/_lib/prefValueOptionFilter.js';
import { organizationListContract } from '../api/_lib/organizationListFilters.js';

test('database alphabet offsets, filters, runs, grants and bounded output over 1000 rows', async () => {
  const h = await createLocalPostgresHarness('crm-alphabet-');
  const run = (cmd, args) => { const r = spawnSync(cmd,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  let db, started = false;
  const tenant = '00000000-0000-4000-8000-000000000001';
  const foreign = '00000000-0000-4000-8000-000000000002';
  const field = '00000000-0000-4000-8000-000000000003';
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']); started=true;
    db = new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'}); await db.connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE organization(id uuid primary key,tenant_id uuid,name text,phone text,invoicing_email text,website_url text,invoicing_address text,organization_group_id uuid);
      CREATE TABLE member(id uuid primary key,tenant_id uuid,first_name text,last_name text,email text,mobile text,job_title text,organization_id uuid,role_id uuid,login_enabled boolean);
      CREATE TABLE organization_preference_value(organization_id uuid,field_id uuid,value text);
      CREATE TABLE member_preference_value(member_id uuid,field_id uuid,value text);
      CREATE TABLE custom_object_relationship(tenant_id uuid,relationship_definition_id uuid,source_record_id uuid,target_record_id uuid,archived_at timestamptz);
      CREATE INDEX ON organization(tenant_id,name,id); CREATE INDEX ON member(tenant_id,first_name,id);
      CREATE INDEX ON member_preference_value(member_id,field_id);
      CREATE INDEX ON organization_preference_value(organization_id,field_id);`);
    await db.query(readFileSync('supabase/migrations/202611050001_crm_alphabet_metadata.sql','utf8'));
    await db.query(`INSERT INTO organization(id,tenant_id,name)
      SELECT md5(n::text)::uuid,$1,CASE WHEN n<=1200 THEN 'A duplicate' WHEN n<=1240 THEN 'C'||n ELSE 'Z'||n END FROM generate_series(1,1300)n`,[tenant]);
    for (const [i,name] of [null,'','Éclair','école','Ångström','!symbol','2digit','alpha','Beta','  space'].entries()) {
      await db.query('INSERT INTO organization(id,tenant_id,name) VALUES(md5($1)::uuid,$2,$3)',[`special${i}`,tenant,name]);
    }
    await db.query('INSERT INTO organization VALUES($1,$1,$2,null,null,null,null,null)',[foreign,'Foreign']);
    await db.query(`INSERT INTO member SELECT id,tenant_id,name,reverse(name),'user@example.test',NULL,'Engineer',id,NULL,true FROM organization`);
    await db.query(`INSERT INTO organization_preference_value SELECT id,$1,CASE WHEN name LIKE 'A%' THEN '["A","B"]' ELSE 'No' END FROM organization;
      `,[field]);
    await db.query('INSERT INTO member_preference_value SELECT organization_id,field_id,value FROM organization_preference_value');
    const metadata = async (entity, sort, recorder, departments=null) =>
      (await db.query('SELECT crm_alphabet_metadata($1,$2,$3,$4,$5) AS result',[tenant,entity,sort,recorder.result(),departments])).rows[0].result;
    const compare = async (entity, sort, q, where='true', values=[]) => {
      const result = await metadata(entity,sort,q);
      const rows = (await db.query(`SELECT id,${sort} AS name FROM ${entity} WHERE tenant_id=$1 AND ${where} ORDER BY ${sort} ASC NULLS LAST,id`,[tenant,...values])).rows;
      assert.equal(result.total,rows.length);
      assert.equal(result.buckets.reduce((n,b)=>n+b.count,0),rows.length);
      for (const bucket of result.buckets) assert.equal(bucket.id, rows[bucket.offset].id);
      assert.ok(Buffer.byteLength(JSON.stringify(result))<16000);
      return result;
    };
    await db.query('SET ROLE service_role');
    const all=await metadata('organization','name',createAlphabetFilterRecorder());
    assert.equal(all.total,1310);
    assert.ok(all.buckets.some(b=>b.label==='É'));
    assert.ok(all.buckets.some(b=>b.label==='Symbols'));
    assert.ok(all.buckets.some(b=>b.label==='Unnamed'));
    await db.query('RESET ROLE');
    await compare('organization','name',createAlphabetFilterRecorder());
    for (const sort of ['first_name','last_name']) {
      const ctx=parseMemberListFilters({search:'duplicate',status:'active'});
      const q=memberAlphabetRecorder(ctx); applyMemberListFilters(q,ctx,{tenantId:tenant});
      await compare('member',sort,q,`first_name ILIKE '%duplicate%' AND login_enabled=true`);
    }
    for (const raw of [['A'],{op:'none_of',value:['A']},{op:'empty'},{op:'not_empty'},'__text__:dup','__bool__:No']) {
      const ctx=parseMemberListFilters({customFilters:JSON.stringify({[field]:raw})});
      const q=memberAlphabetRecorder(ctx); applyMemberListFilters(q,ctx);
      const result=await metadata('member','first_name',q);
      const expected=Array.isArray(raw)?1200:raw.op==='none_of'?110:raw.op==='empty'?0:raw.op==='not_empty'?1310:raw==='__bool__:No'?110:0;
      assert.equal(result.total,expected,JSON.stringify(raw));
    }
    const q=organizationAlphabetRecorder([[field,{op:'any_of',kind:'option',values:['A']}]]);
    applyPrefFilterEntry(q,'cf0',field,{op:'any_of',kind:'option',values:['A']});
    await compare('organization','name',q,`EXISTS(SELECT 1 FROM organization_preference_value v WHERE v.organization_id=organization.id AND v.value ILIKE '%"A"%')`);
    // Duplicate preference rows must not multiply either counts or offsets.
    await db.query('INSERT INTO organization_preference_value SELECT * FROM organization_preference_value LIMIT 5');
    assert.equal((await metadata('organization','name',q)).total,1200);
    const makeOrg = (params,ids=[]) => {
      const contract=organizationListContract(params,tenant,ids);
      const recorder=organizationAlphabetRecorder(contract.customFilterEntries);
      contract.applyFilters(recorder);
      return recorder;
    };
    const target=(await db.query("SELECT id FROM organization WHERE name='C1201'")).rows[0].id;
    const group='00000000-0000-4000-8000-000000000010';
    await db.query('UPDATE organization SET organization_group_id=$1,phone=$2,invoicing_address=$3 WHERE id=$4',[group,'100% office','Street',target]);
    await compare('organization','name',makeOrg({group}), 'organization_group_id=$2',[group]);
    await compare('organization','name',makeOrg({group:'none'}),'organization_group_id IS NULL');
    await compare('organization','name',makeOrg({search:'office',phone:'100',coreFilters:JSON.stringify({invoicing_address:{op:'equals',value:'street'}})},[target]),
      'id=$2',[target]);
    for (const op of ['contains','not_contains','equals','empty','not_empty']) {
      const params={coreFilters:JSON.stringify({phone:{op,value:'100%'}})};
      const expected={contains:1,not_contains:1309,equals:0,empty:1309,not_empty:1}[op];
      assert.equal((await metadata('organization','name',makeOrg(params))).total,expected,op);
    }
    await db.query('INSERT INTO organization_preference_value VALUES($1,$2,$3)',[target,field,'GB']);
    assert.equal((await metadata('organization','name',makeOrg({customFilters:JSON.stringify({[field]:'__country__:United Kingdom'})}))).total,1);
    await db.query("UPDATE member SET email='deleted_123@deleted.local' WHERE id=$1",[target]);
    const deleted=memberAlphabetRecorder(parseMemberListFilters());
    deleted.not('email','like','deleted_%@deleted.local');
    await compare('member','first_name',deleted,"email NOT LIKE 'deleted_%@deleted.local'");
    const role='00000000-0000-4000-8000-000000000011';
    await db.query('UPDATE member SET role_id=$1,login_enabled=false,mobile=$2 WHERE id=$3',[role,'0123',target]);
    const filtered=parseMemberListFilters({roleId:role,organizationId:target,status:'disabled',coreFilters:JSON.stringify({mobile:{op:'equals',value:'0123'}})});
    const filteredQ=memberAlphabetRecorder(filtered); applyMemberListFilters(filteredQ,filtered,{tenantId:tenant});
    assert.equal((await metadata('member','first_name',filteredQ)).total,1);
    const linked=parseMemberListFilters({organizationFilters:JSON.stringify({[field]:['GB']})});
    const linkedQ=memberAlphabetRecorder(linked); applyMemberListFilters(linkedQ,linked,{tenantId:tenant});
    assert.equal((await metadata('member','first_name',linkedQ)).total,1);
    const defaults=parseMemberListFilters({customFilters:JSON.stringify({[field]:'__bool__:No'})});
    defaults.customFilterEntries[0][1].includeUnset=true;
    const defaultQ=memberAlphabetRecorder(defaults); applyMemberListFilters(defaultQ,defaults);
    assert.equal((await metadata('member','first_name',defaultQ)).total,110);
    const dep='00000000-0000-4000-8000-000000000020';
    const def='00000000-0000-4000-8000-000000000021';
    const parentDef='00000000-0000-4000-8000-000000000022';
    await db.query('INSERT INTO custom_object_relationship VALUES($1,$2,$3,$4,null),($1,$5,$3,$4,null)',[tenant,def,dep,target,parentDef]);
    const departments={ids:[dep],definitionId:def,parentDefinitionId:parentDef};
    assert.equal((await metadata('member','first_name',createAlphabetFilterRecorder(),departments)).total,1);
    await db.query('INSERT INTO custom_object_relationship VALUES($1,$2,$3,$4,null)',[tenant,parentDef,dep,foreign]);
    assert.equal((await metadata('member','first_name',createAlphabetFilterRecorder(),departments)).total,0,'ambiguous parent excluded');
    const none=createAlphabetFilterRecorder(); none.eq('name','missing'); assert.equal((await metadata('organization','name',none)).buckets.length,0);
    await assert.rejects(db.query(`SELECT crm_alphabet_metadata($1,'organization','name; DROP TABLE member','{}',null)`,[tenant]),/Invalid/);
    await assert.rejects(db.query(`SELECT crm_alphabet_metadata($1,'organization','name','{"base":[{"column":"name","op":"raw","value":"true"}],"joins":{}}',null)`,[tenant]),/Invalid/);
    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(metadata('organization','name',createAlphabetFilterRecorder()),/permission denied/);
      await db.query('RESET ROLE');
    }
    const plan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT id,name FROM organization WHERE tenant_id=$1 ORDER BY name,id',[tenant])).rows[0]['QUERY PLAN'];
    assert.ok(plan[0]['Execution Time']<1000);
    console.log('Alphabet fixture: 1310 records; indexed tenant/order query plan verified; metadata below 16KB.');
  } finally {
    await db?.end();
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{stdio:'ignore'});
    await h.cleanup();
  }
});
