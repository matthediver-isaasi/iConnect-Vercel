import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm, readdir, access } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const migration = await readFile(new URL('./202612310007_iedit_member_content.sql', import.meta.url), 'utf8');
const repair = await readFile(new URL('../../scripts/sql/member-content-repair/004-knowledge.sql', import.meta.url), 'utf8');
const eligibility = await readFile(new URL('../../scripts/sql/member-content-repair/005-microsite-knowledge-eligibility.sql', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('./20261031_member_content_generation_lifecycle.sql', import.meta.url), 'utf8');
const lockdown = await readFile(new URL('./20261101_member_content_security_lockdown.sql', import.meta.url), 'utf8');

test('additive anchors match latest authored knowledge + live microsite contracts', async () => {
  // No foundational replay, matcher replacement or new public execution grants.
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/);
  assert.doesNotMatch(migration, /CREATE TABLE|DROP FUNCTION|GRANT .*authenticated/i);
  assert.match(repair, /WHEN 'canvas_page' THEN 'i_edit_page' END/);
  assert.match(repair, /canonical->>'builder_type'<>'canvas'/);
  assert.match(repair, /'resource_pdf','canvas_page','authored_repair'/);
  assert.match(eligibility, /c.content_type <> 'canvas_page' OR EXISTS/);
  assert.match(lockdown, /c.content_type = 'canvas_page' AND c.status = 'published'/);
  assert.match(migration, /Unexpected destination contract/);
  assert.match(migration, /parent resolver required/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.iedit_member_content_change\(\)/);
  for (const table of ['wall_of_fame_section', 'wall_of_fame_category', 'wall_of_fame_person',
    'resource', 'news_post', 'blog_post', 'event', 'complex_event', 'job_posting',
    'gallery', 'gallery_photo', 'organization', 'organization_group', 'form', 'microsite']) {
    assert.ok(migration.includes(`'${table}'`), table);
  }
  const dynamic = await readFile(new URL('../../api/_lib/memberContentIEditDynamic.js',import.meta.url),'utf8');
  for(const match of dynamic.matchAll(/\bread\('([a-z_]+)'/g)) {
    assert.ok(migration.includes(`'${match[1]}'`),`Dynamic read ${match[1]} needs an invalidation hook`);
  }
  for(const table of ['member','guest_writer']) assert.ok(migration.includes(`'${table}'`));
});

test('full isolated PostgreSQL + PostgREST: exact migration, publication and live matcher', { timeout: 90000 }, async t => {
  // Real pgvector and PostgREST, never a vector stub or HTTP emulation.
  // Portable CI may supply these paths; the workspace has both in Nix.
  const store = await readdir('/nix/store').catch(() => []);
  const restCandidates = [process.env.IEDIT_TEST_POSTGREST,
    ...store.filter(n => /-postgrest-.*-bin$/.test(n)).map(n => `/nix/store/${n}/bin/postgrest`)].filter(Boolean);
  let restBinary;
  for (const name of restCandidates) { try { await access(name); restBinary=name; break; } catch {} }
  const vectorRoots = [process.env.IEDIT_TEST_PGVECTOR_ROOT,
    ...store.filter(n => n.endsWith('-pgvector-0.8.0')).map(n => `/nix/store/${n}`)].filter(Boolean);
  if (!restBinary || !vectorRoots.length) { t.skip('Real PostgREST/pgvector unavailable; set IEDIT_TEST_POSTGREST and IEDIT_TEST_PGVECTOR_ROOT'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'iedit-real-rest-'));
  const data = path.join(root,'data'), socket = path.join(root,'socket');
  await mkdir(socket);
  const port = String(56000 + process.pid % 100), restPort = 56100 + process.pid % 100;
  const args = ['-h',socket,'-p',port,'-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'];
  let started=false, server, client;
  try {
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-F -k ${socket} -c listen_addresses= -p ${port}`,'-w','start']);
    started=true;
    let vectorRoot;
    for (const candidate of vectorRoots) {
      const result=spawnSync('psql',args,{input:`LOAD '${candidate}/lib/vector.so';`,encoding:'utf8'});
      if(result.status===0) { vectorRoot=candidate; break; }
    }
    assert.ok(vectorRoot,'pgvector library matching local PostgreSQL ABI required');
    const vectorSql=await readFile(`${vectorRoot}/share/postgresql/extension/vector--0.8.0.sql`,'utf8');
    run('psql',args,vectorSql.replace(/^\\echo.*$/m,'').replaceAll('MODULE_PATHNAME',`${vectorRoot}/lib/vector.so`));
    // The fixture DDL is from the current repaired publisher's isolated schema.
    // Only definitions needed for this test are installed in this temporary DB.
    const fixture=await readFile(new URL('../../scripts/sql/member-content-repair/003-microsite-fence.test.mjs',import.meta.url),'utf8');
    const ddl=fixture.slice(fixture.indexOf('const baseline = `')+'const baseline = `'.length,
      fixture.indexOf('  CREATE OR REPLACE FUNCTION invalidate_member_content_source('))
      .replace('embedding text,','embedding vector(1536),');
    const invalidator=lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION invalidate_member_content_source('),
      lifecycle.indexOf('CREATE OR REPLACE FUNCTION member_content_source_change_trigger()'));
    const claim=lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION claim_member_content_generation('),
      lifecycle.indexOf('-- Activation is a transaction boundary.'));
    run('psql',args,`${ddl}
      CREATE TABLE member_ai_settings(id int PRIMARY KEY, allowed_content_types text[] DEFAULT
        ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]);
      INSERT INTO member_ai_settings VALUES(1,ARRAY['resource']);
      ALTER TABLE i_edit_page ADD COLUMN status text DEFAULT 'published';
      CREATE TABLE i_edit_page_element(id uuid PRIMARY KEY,page_id uuid,position int);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE organization_preference_value(id uuid PRIMARY KEY,organization_id uuid,field_id uuid,value text);
      CREATE TABLE member_resource_category(id uuid PRIMARY KEY,member_id uuid,resource_category_id uuid);
      CREATE TABLE blog_post_author(id uuid PRIMARY KEY,tenant_id uuid,blog_post_id uuid,display_order int);
      CREATE TABLE speaker(id uuid PRIMARY KEY,tenant_id uuid,full_name text);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE card_deck(id uuid PRIMARY KEY,tenant_id uuid,title text);
      CREATE TABLE survey_version(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,fields jsonb);
      CREATE TABLE event_survey_assignment(id uuid PRIMARY KEY,tenant_id uuid,form_id uuid,status text);
      ALTER TABLE member_content_reindex_job ADD COLUMN attempts int, ADD COLUMN available_at timestamp,
        ADD COLUMN last_error text, ADD COLUMN updated_at timestamp;
      ${invalidator}
      ${claim}
      ${repair}
      ${lockdown.slice(lockdown.indexOf('CREATE FUNCTION public.match_member_content_chunks('))}
      CREATE FUNCTION public.microsite_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER microsite_member_content_change BEFORE UPDATE ON microsite
        FOR EACH ROW EXECUTE FUNCTION public.microsite_fixture_trigger();
      ${eligibility}
      REVOKE ALL ON FUNCTION invalidate_member_content_source(uuid,text,uuid),claim_member_content_generation(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION invalidate_member_content_source(uuid,text,uuid),claim_member_content_generation(uuid,text,uuid) TO service_role;
      GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    // Executes every guard and every patch, then verifies standalone repeat.
    run('psql',args,migration);
    run('psql',args,migration);
    run('psql',args,'INSERT INTO member_ai_settings(id) VALUES(2)');
    assert.equal(run('psql',args,"SELECT allowed_content_types::text FROM member_ai_settings WHERE id=1"),'{resource}');
    assert.equal(run('psql',args,"SELECT 'iedit_page'=ANY(allowed_content_types) FROM member_ai_settings WHERE id=2"),'t');
    client=new pg.Client({host:socket,port:Number(port),user:'postgres',database:'postgres'});
    await client.connect();
    const secret='isolated-iedit-fixture-jwt-secret-not-a-production-key';
    server=spawn(restBinary,[],{env:{...process.env,
      PGRST_DB_URI:`postgresql://postgres@/postgres?host=${encodeURIComponent(socket)}&port=${port}`,
      PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',
      PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(restPort),
      PGRST_JWT_SECRET:secret},stdio:['ignore','ignore','pipe']});
    let restErrors='';
    server.stderr.on('data',value=>{ restErrors+=value.toString(); });
    const base=`http://127.0.0.1:${restPort}`;
    for(let i=0;i<100;i++) {
      if(server.exitCode!==null) throw new Error(`Local PostgREST exited ${server.exitCode}`);
      try { const response=await fetch(base); if(response.ok) break; } catch {}
      await new Promise(r=>setTimeout(r,100));
      if(i===99) assert.fail(`PostgREST fixture readiness failed: ${restErrors}`);
    }
    const jwt=role=>{
      const value=[{alg:'HS256',typ:'JWT'},{role,exp:Math.floor(Date.now()/1000)+300}]
        .map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
      return `${value}.${createHmac('sha256',secret).update(value).digest('base64url')}`;
    };
    const rpc=async(name,payload,role='service_role')=>{
      const response=await fetch(`${base}/rpc/${name}`,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${jwt(role)}`},
        body:JSON.stringify(payload)});
      const result=await response.json();
      assert.equal(response.ok,true,JSON.stringify(result));
      return result;
    };
    const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002';
    const p='10000000-0000-4000-8000-000000000001', q='10000000-0000-4000-8000-000000000002';
    const site='20000000-0000-4000-8000-000000000001';
    await client.query(`INSERT INTO microsite VALUES($1,$2,'members',true);
    `,[site,a]);
    await client.query(`INSERT INTO i_edit_page(id,tenant_id,slug,microsite_id,builder_type)
      VALUES($1,$2,'board',$3,'iedit'),($4,$5,'other',NULL,'iedit')`,[p,a,site,q,b]);
    const identity={p_tenant_id:a,p_content_type:'iedit_page',p_source_id:p};
    const claimRpc=async()=> (await rpc('claim_member_content_generation',identity))[0];
    const embedding=`[1,${Array(1535).fill(0).join(',')}]`;
    const makeRows=claim=>['public','authenticated'].map((scope,index)=>({
      tenant_id:a,content_type:'iedit_page',source_id:p,source_generation:claim.generation,
      chunk_index:index,title:'Board',content:`Board fixture ${scope}`,link:'/members/board',status:'published',
      access_scope:scope,embedding,content_hash:`fixture-${index}`,embedding_model:'text-embedding-3-small',
      microsite_id:site,provenance:{kind:'iedit_page',dependencies:[]},
    }));
    const publish=(claim,rows=makeRows(claim))=>rpc('publish_member_content_knowledge',
      {...identity,p_generation:claim.generation,p_claim_token:claim.claim_token,p_rows:rows});
    const match=auth=>rpc('match_member_content_chunks',{query_embedding:embedding,p_tenant_id:a,
      match_count:10,p_is_authenticated:auth,p_is_admin:false,p_role_id:null,p_group_ids:[],
      p_accessible_event_ids:[],p_accessible_session_ids:[],p_hidden_subcategories:[],p_allowed_feature_keys:[],
      p_eligible_pdf_chunk_ids:[],p_query_text:'Board',p_allowed_content_types:['iedit_page']});
    const first=await claimRpc();
    assert.equal(await publish(first),true);
    assert.equal(await publish(first),false,'consumed REST claim cannot republish');
    assert.equal((await match(false)).length,1);
    assert.equal((await match(true)).length,2);
    const stableIds=(await match(true)).map(r=>r.id).sort();
    const repeat=await claimRpc();
    assert.equal(await publish(repeat),true);
    assert.deepEqual((await match(true)).map(r=>r.id).sort(),stableIds);
    const invalid=await claimRpc();
    const invalidRows=makeRows(invalid);
    invalidRows[1].content=null;
    const failed=await fetch(`${base}/rpc/publish_member_content_knowledge`,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${jwt('service_role')}`},
      body:JSON.stringify({...identity,p_generation:invalid.generation,p_claim_token:invalid.claim_token,p_rows:invalidRows})});
    assert.equal(failed.status,400);
    assert.deepEqual((await match(true)).map(r=>r.id).sort(),stableIds,'invalid snapshot cannot partially replace active chunks');
    assert.equal(await publish(invalid),true,'validation failure preserves the pending claim');
    const stale=await claimRpc();
    await client.query('INSERT INTO i_edit_page_element VALUES($1,$2,0)',[site,p]);
    assert.equal(await publish(stale),false);
    assert.equal((await match(true)).length,0,'invalidated generation immediately hidden');
    assert.equal((await client.query('SELECT count(*)::int n FROM member_content_reindex_job WHERE tenant_id=$1',[a])).rows[0].n,1);
    const fresh=await claimRpc();
    assert.equal(await publish(fresh),true);
    const siteClaim=await claimRpc();
    await client.query('UPDATE microsite SET is_active=false WHERE id=$1',[site]);
    assert.equal(await publish(siteClaim),false);
    assert.equal((await match(true)).length,0);
    // Even if registry state is externally corrupted, live microsite predicate
    // independently hides already-published chunks.
    await client.query('UPDATE member_content_source SET active_generation=$1 WHERE tenant_id=$2',[fresh.generation,a]);
    assert.equal((await match(true)).length,0);
    await client.query('UPDATE microsite SET is_active=true WHERE id=$1',[site]);
    const restored=await claimRpc(); assert.equal(await publish(restored),true);
    assert.equal(await rpc('publish_member_content_knowledge',{...identity,p_tenant_id:b,
      p_generation:restored.generation,p_claim_token:restored.claim_token,p_rows:makeRows(restored)}),false);
    // Parent-scoped old/new ownership, plus every newly audited dependency.
    await client.query('INSERT INTO organization VALUES($1,$2,$3),($4,$5,$6)',[p,a,'A',q,b,'B']);
    const gen=async tenant=>Number((await client.query('SELECT generation FROM member_content_source WHERE tenant_id=$1 AND content_type=$2',[tenant,'iedit_page'])).rows[0].generation);
    let ga=await gen(a),gb=await gen(b);
    await client.query('INSERT INTO organization_preference_value VALUES($1,$2,$3,$4)',[site,p,site,'visible']);
    assert.equal(await gen(a),++ga); assert.equal(await gen(b),gb);
    await client.query('UPDATE organization_preference_value SET organization_id=$1',[q]);
    assert.equal(await gen(a),++ga); assert.equal(await gen(b),++gb);
    await client.query('DELETE FROM organization_preference_value');
    assert.equal(await gen(b),++gb);
    await client.query('INSERT INTO member VALUES($1,$2),($3,$4)',[p,a,q,b]);
    ga=await gen(a); gb=await gen(b);
    await client.query('INSERT INTO member_resource_category VALUES($1,$2,$3)',[site,p,site]);
    assert.equal(await gen(a),++ga); assert.equal(await gen(b),gb);
    await client.query('UPDATE member_resource_category SET member_id=$1',[q]);
    assert.equal(await gen(a),++ga); assert.equal(await gen(b),++gb);
    await client.query('DELETE FROM member_resource_category');
    assert.equal(await gen(b),++gb);
    for(const table of ['card_deck','speaker','role','blog_post_author','survey_version','event_survey_assignment']) {
      await client.query(`INSERT INTO ${table}(id,tenant_id) VALUES($1,$2)`,[site,a]);
      assert.equal(await gen(a),++ga,`${table} inserts include newly eligible rows`);
      await client.query(`UPDATE ${table} SET tenant_id=$1`,[b]);
      assert.equal(await gen(a),++ga); assert.equal(await gen(b),++gb);
      await client.query(`DELETE FROM ${table}`);
      assert.equal(await gen(b),++gb);
    }
    for(const role of ['anon','authenticated']) {
      const response=await fetch(`${base}/rpc/claim_member_content_generation`,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${jwt(role)}`},body:JSON.stringify(identity)});
      assert.ok([401,403].includes(response.status),`${role} must not claim`);
    }
    // Exact definition drift must abort, never silently retain altered behavior.
    await client.query(`CREATE OR REPLACE FUNCTION claim_member_content_generation(p_tenant_id uuid,p_content_type text,p_source_id uuid)
      RETURNS TABLE(generation bigint,claim_token uuid,already_active boolean) LANGUAGE sql AS $$
      SELECT 1::bigint,NULL::uuid,false $$`);
    const rejected=spawnSync('psql',args,{input:migration,encoding:'utf8'});
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/Exact iEdit function guard failed/);
  } finally {
    if(server) { server.kill('SIGTERM'); await new Promise(r=>server.exitCode!==null?r():server.once('exit',r)); }
    if(client) await client.end();
    if(started) spawnSync('pg_ctl',['-D',data,'-m','immediate','stop']);
    await rm(root,{recursive:true,force:true});
  }
});

function run(command, args, input = '') {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('isolated PostgreSQL lifecycle: moves, switches, all dynamic writes, CAS claim cancellation', { timeout: 60000 }, async t => {
  if (spawnSync('sh', ['-c', 'command -v initdb && command -v pg_ctl && command -v psql']).status !== 0) {
    t.skip('PostgreSQL binaries unavailable'); return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'iedit-lifecycle-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const port = String(55800 + process.pid % 100);
  const args = ['-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    // Only fixture DDL and the real invalidation function, never deploy scripts.
    const invalidator = lifecycle.slice(lifecycle.indexOf('CREATE OR REPLACE FUNCTION invalidate_member_content_source('),
      lifecycle.indexOf('CREATE OR REPLACE FUNCTION member_content_source_change_trigger()'))
      .replace("'blog_post', 'canvas_page'", "'blog_post', 'canvas_page', 'iedit_page'");
    run('psql', args, `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member_content_source (
        tenant_id uuid, content_type text, source_id uuid, generation bigint, active_generation bigint,
        claim_token uuid, claim_started_at timestamp, PRIMARY KEY(tenant_id,content_type,source_id));
      CREATE TABLE member_content_reindex_job (
        tenant_id uuid, content_type text, source_id uuid, attempts int, available_at timestamp,
        last_error text, updated_at timestamp, PRIMARY KEY(tenant_id,content_type,source_id));
      CREATE TABLE i_edit_page(id uuid PRIMARY KEY,tenant_id uuid,builder_type text,status text);
      CREATE TABLE i_edit_page_element(id uuid PRIMARY KEY,page_id uuid,position int);
      CREATE TABLE wall_of_fame_person(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE microsite(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean);
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member_ai_settings(id int PRIMARY KEY, allowed_content_types text[] DEFAULT
        ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]);
      INSERT INTO member_ai_settings VALUES(1,ARRAY['resource']);
      ${invalidator}
      ${migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.iedit_member_content_change()'), migration.indexOf("NOTIFY pgrst"))}
    `);
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const p = '10000000-0000-4000-8000-000000000001';
    const q = '10000000-0000-4000-8000-000000000002';
    const e = '20000000-0000-4000-8000-000000000001';
    const sql = s => run('psql', args, s);
    sql('INSERT INTO member_ai_settings(id) VALUES(2)');
    assert.equal(sql("SELECT allowed_content_types::text FROM member_ai_settings WHERE id=1"),'{resource}');
    assert.equal(sql("SELECT 'iedit_page'=ANY(allowed_content_types) FROM member_ai_settings WHERE id=2"),'t');
    const generation = (tenant, page, type = 'iedit_page') => Number(sql(`SELECT generation FROM member_content_source WHERE tenant_id='${tenant}' AND source_id='${page}' AND content_type='${type}'`));
    sql(`INSERT INTO i_edit_page VALUES('${p}','${a}','iedit','published'),('${q}','${b}','iedit','published')`);
    assert.equal(generation(a,p), 1);
    sql(`INSERT INTO i_edit_page_element VALUES('${e}','${p}',0)`);
    assert.equal(generation(a,p), 2);
    sql(`UPDATE i_edit_page_element SET position=1`);
    assert.equal(generation(a,p), 3);
    sql(`UPDATE i_edit_page_element SET page_id='${q}'`);
    assert.equal(generation(a,p), 4); assert.equal(generation(b,q), 2);
    sql(`DELETE FROM i_edit_page_element`);
    assert.equal(generation(b,q), 3);
    sql(`UPDATE member_content_source SET claim_token='${e}',active_generation=generation,claim_started_at=now();
      INSERT INTO wall_of_fame_person VALUES('${e}','${a}','Newly eligible board member')`);
    assert.equal(generation(a,p), 5); assert.equal(generation(b,q), 3);
    assert.equal(sql(`SELECT count(*) FROM member_content_source WHERE tenant_id='${a}' AND (claim_token IS NOT NULL OR active_generation IS NOT NULL)`), '0');
    sql(`UPDATE wall_of_fame_person SET tenant_id='${b}'`);
    assert.equal(generation(a,p), 6); assert.equal(generation(b,q), 4);
    sql(`DELETE FROM wall_of_fame_person`);
    assert.equal(generation(b,q), 5);
    sql(`INSERT INTO microsite VALUES('${e}','${b}',true); UPDATE microsite SET is_active=false`);
    assert.equal(generation(b,q), 7);
    sql(`UPDATE i_edit_page SET builder_type='canvas' WHERE id='${p}'`);
    assert.equal(generation(a,p), 7); assert.equal(generation(a,p,'canvas_page'), 1);
    sql(`UPDATE i_edit_page SET tenant_id='${a}' WHERE id='${q}'`);
    assert.equal(generation(b,q), 8); assert.equal(generation(a,q), 1);
    sql(`INSERT INTO tenant VALUES('${a}')`);
    assert.equal(generation(a,q), 2);
    sql(`DELETE FROM i_edit_page WHERE id='${q}'`);
    assert.equal(generation(a,q), 3);
    assert.equal(sql(`SELECT count(*) FROM member_content_reindex_job WHERE content_type='iedit_page'`), '3');
    assert.equal(sql(`SELECT has_function_privilege('authenticated','public.iedit_member_content_change()','EXECUTE')`), 'f');
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
