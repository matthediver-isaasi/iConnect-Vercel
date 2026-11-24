import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('opportunity archive: atomic lifecycle, deletion guards, audit, permissions and FK races', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opportunity-archive-'));
  const data = path.join(dir, 'db'), socket = path.join(dir, 'sock');
  mkdirSync(socket);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  const port = 55479, clients = [];
  let started = false;
  try {
    run('initdb', ['-D',data,'-A','trust','-U','postgres','--no-locale']);
    run('pg_ctl', ['-D',data,'-l',path.join(dir,'log'),'-o',`-F -k ${socket} -p ${port} -c listen_addresses=''`,'-w','start']);
    started = true;
    const connect = async () => {
      const c = new pg.Client({ host:socket, port, user:'postgres', database:'postgres' });
      await c.connect(); clients.push(c); return c;
    };
    const db = await connect();
    const sql = async (s, args) => (await db.query(s,args)).rows;
    await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid);
      CREATE TABLE tenant_user(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid);`);
    await sql(readFileSync('supabase/migrations/20260908_opportunity_pipeline.sql','utf8'));
    await sql(`CREATE TABLE sales_quote(id uuid PRIMARY KEY,tenant_id uuid,opportunity_id uuid,
        FOREIGN KEY(tenant_id,opportunity_id) REFERENCES opportunity(tenant_id,id) ON DELETE RESTRICT);
      CREATE TABLE sales_commercial_sale(LIKE sales_quote INCLUDING ALL);
      ALTER TABLE sales_commercial_sale ADD FOREIGN KEY(tenant_id,opportunity_id)
        REFERENCES opportunity(tenant_id,id) ON DELETE RESTRICT;
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,
        entity_type text,entity_id text,before_data jsonb,after_data jsonb);
      GRANT ALL ON sales_quote,sales_commercial_sale TO service_role;`);
    const migration = readFileSync('supabase/migrations/202611240002_opportunity_archive.sql','utf8');
    await sql(migration); await sql(migration);
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const tenant=id(1), org=id(2), actor=id(3), stage=id(4), opp=id(5);
    await sql(`INSERT INTO tenant VALUES ($1);`,[tenant]);
    await sql(`INSERT INTO organization VALUES ($1,$2)`,[org,tenant]);
    await sql(`INSERT INTO member VALUES ($1,$2,$3)`,[actor,tenant,org]);
    await sql(`INSERT INTO opportunity_stage(id,tenant_id,name,position) VALUES($1,$2,'Open',0)`,[stage,tenant]);
    const create = async n => sql(`INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,
      name,created_by_kind,created_by_id) VALUES($1,$2,$3,$4,'member',$5,'Test','member',$5)`,[id(n),tenant,org,stage,actor]);
    const lifecycle = async (action, version, opportunity=opp, t=tenant, c=db) => (
      await c.query(`SELECT set_opportunity_archive($1,$2,$3,$4,'member',$5) AS result`,
        [t,opportunity,version,action,actor])).rows[0].result;
    await create(5);
    await assert.rejects(lifecycle('delete',1), e => e.code === 'PT409');
    await assert.rejects(lifecycle('archive',1,opp,id(99)), e => e.code === 'P0002');
    const archived = await lifecycle('archive',1);
    assert.ok(archived.archived_at); assert.equal(archived.version,2);
    await assert.rejects(lifecycle('restore',1), e => e.code === 'PT409');
    const restored = await lifecycle('restore',2);
    assert.equal(restored.archived_at,null); assert.equal(restored.version,3);
    await lifecycle('archive',3);
    for (const table of ['sales_quote','sales_commercial_sale']) {
      await sql(`INSERT INTO ${table}(id,tenant_id,opportunity_id) VALUES($1,$2,$3)`,[id(20),tenant,opp]);
      await assert.rejects(lifecycle('delete',4), e => e.code === 'PT409' && /linked proposals/.test(e.message));
      await sql(`DELETE FROM ${table}`);
    }
    await sql(`INSERT INTO opportunity_document(tenant_id,opportunity_id,name,bucket,storage_path,uploaded_by_kind,uploaded_by_id)
      VALUES($1,$2,'doc','private-uploads',$3,'member',$4)`,[tenant,opp,`${tenant}/opportunities/${opp}/doc`,actor]);
    await assert.rejects(lifecycle('delete',4), e => e.code === 'PT409' && /documents/.test(e.message));
    await sql('DELETE FROM opportunity_document');
    assert.equal((await lifecycle('delete',4)).deleted,true);
    assert.equal((await sql('SELECT count(*)::int AS n FROM opportunity'))[0].n,0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM opportunity_activity'))[0].n,0);
    assert.equal((await sql("SELECT count(*)::int AS n FROM sales_audit_event WHERE action='opportunity.deleted'"))[0].n,1);
    for (const role of ['anon','authenticated']) {
      assert.equal((await sql(`SELECT has_function_privilege($1,
        'set_opportunity_archive(uuid,uuid,integer,text,text,uuid)','EXECUTE') AS allowed`,[role]))[0].allowed,false);
    }
    const service = await connect();
    await service.query('SET ROLE service_role');
    await create(6);
    assert.ok((await lifecycle('archive',1,id(6),tenant,service)).archived_at);
    // A concurrent new proposal cannot sneak past the delete check: the parent
    // lock makes its FK insert wait, then fail once deletion commits.
    const other = await connect();
    await db.query('BEGIN');
    await lifecycle('delete',2,id(6));
    let finished = false;
    const insert = other.query('INSERT INTO sales_quote VALUES($1,$2,$3)',[id(30),tenant,id(6)])
      .then(() => { finished=true; return null; }, error => { finished=true; return error; });
    // Wait for PostgreSQL to confirm the FK writer is actually blocked.
    for (let attempt=0; attempt<100; attempt++) {
      const waiting = await sql("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[other.processID]);
      if (waiting[0].n) break;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.equal(finished,false);
    await db.query('COMMIT');
    assert.equal((await insert).code,'23503');
  } finally {
    for (const c of clients) await c.end().catch(() => {});
    if (started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(dir,{recursive:true,force:true});
  }
});
