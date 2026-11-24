import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('proposal archive: real draft cascades, immutable history, protected deletion, grants and races', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proposal-archive-'));
  const data = path.join(dir, 'db'), socket = path.join(dir, 'sock'), port = 55481;
  mkdirSync(socket);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  const clients = [];
  let started = false;
  try {
    run('initdb', ['-D',data,'-A','trust','-U','postgres','--no-locale']);
    run('pg_ctl', ['-D',data,'-l',path.join(dir,'log'),'-o',`-F -k ${socket} -p ${port} -c listen_addresses=''`,'-w','start']);
    started = true;
    const connect = async () => {
      const c = new pg.Client({ host: socket, port, user: 'postgres', database: 'postgres' });
      await c.connect(); clients.push(c); return c;
    };
    const db = await connect();
    const sql = async (s,args) => (await db.query(s,args)).rows;
    await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE sales_settings(tenant_id uuid PRIMARY KEY,quote_prefix text,quote_padding integer);
      CREATE TABLE opportunity(tenant_id uuid,id uuid,PRIMARY KEY(tenant_id,id));
      CREATE TABLE sales_catalogue_product(tenant_id uuid,id uuid,PRIMARY KEY(tenant_id,id));
      CREATE TABLE sales_catalogue_bundle(tenant_id uuid,id uuid,PRIMARY KEY(tenant_id,id));`);
    // Use the actual version, line, component and immutable-history triggers.
    await sql(readFileSync('supabase/migrations/20260909_sales_quotes.sql','utf8'));
    await sql(`ALTER TABLE sales_quote ADD COLUMN exhibition_deleted_at timestamptz;
      CREATE FUNCTION sales_space_lock(uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(42) $$;
      CREATE TABLE sales_audit_event(tenant_id uuid,actor_id text,actor_type text,action text,
        entity_type text,entity_id text,before_data jsonb,after_data jsonb);
      CREATE TABLE sales_quote_delivery_token(tenant_id uuid,quote_id uuid,
        FOREIGN KEY(tenant_id,quote_id) REFERENCES sales_quote(tenant_id,id) ON DELETE CASCADE);
      CREATE TABLE sales_quote_delivery_audit(LIKE sales_quote_delivery_token);
      CREATE TABLE sales_agreement_envelope(LIKE sales_quote_delivery_token);
      CREATE TABLE sales_commercial_sale(LIKE sales_quote_delivery_token);
      CREATE TABLE sales_space_allocation(LIKE sales_quote_delivery_token);
      CREATE TABLE sales_stage_historical_invoice(tenant_id uuid,quote_version_id uuid,
        FOREIGN KEY(tenant_id,quote_version_id) REFERENCES sales_quote_version(tenant_id,id));
      CREATE TABLE future_fulfilment(tenant_id uuid,quote_id uuid,
        FOREIGN KEY(tenant_id,quote_id) REFERENCES sales_quote(tenant_id,id));`);
    const migration = readFileSync('supabase/migrations/202611240003_sales_quote_archive.sql','utf8');
    await sql(migration); await sql(migration);
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const tenant = id(1);
    await sql('INSERT INTO tenant VALUES($1)', [tenant]);
    const create = async n => {
      await sql(`INSERT INTO sales_quote(id,tenant_id,created_by,updated_by) VALUES($1,$2,'actor','actor');
        `, [id(n),tenant]);
      await sql(`INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,currency,created_by)
        VALUES($1,$2,$3,1,'GBP','actor')`,[id(n+1000),tenant,id(n)]);
      await sql(`INSERT INTO sales_quote_status_history(tenant_id,quote_id,quote_version_id,to_status,actor_id,actor_type)
        VALUES($1,$2,$3,'draft','actor','member')`,[tenant,id(n),id(n+1000)]);
    };
    const lifecycle = async (n, action, version=1, t=tenant, c=db) => (
      await c.query(`SELECT set_sales_quote_archive($1,$2,$3,$4,'actor','member') AS result`,
        [t,id(n),version,action])).rows[0].result;
    await create(10);
    await assert.rejects(lifecycle(10,'delete'), e => e.code === 'PT409');
    await assert.rejects(lifecycle(10,'archive',1,id(99)), e => e.code === 'P0002');
    assert.ok((await lifecycle(10,'archive')).archived_at);
    await assert.rejects(lifecycle(10,'restore',1), e => e.code === 'PT409');
    assert.equal((await lifecycle(10,'restore',2)).archived_at,null);
    await lifecycle(10,'archive',3);
    await assert.rejects(sql('DELETE FROM sales_quote_version WHERE quote_id=$1',[id(10)]),e => e.code === '23514');
    await assert.rejects(sql('DELETE FROM sales_quote_status_history WHERE quote_id=$1',[id(10)]),e => e.code === '23514');
    await sql(`INSERT INTO sales_quote_line(tenant_id,quote_version_id,display_order,catalogue_kind,description,
      quantity,standard_unit_price_minor,quoted_unit_price_minor,tax_rate_bps,net_minor,tax_minor,gross_minor)
      VALUES($1,$2,0,'free_text','Example',1,100,100,0,100,0,100)`,[tenant,id(1010)]);
    assert.equal((await lifecycle(10,'delete',4)).deleted,true);
    assert.equal((await sql('SELECT count(*)::int n FROM sales_quote_version WHERE quote_id=$1',[id(10)]))[0].n,0);
    assert.equal((await sql('SELECT count(*)::int n FROM sales_quote_status_history WHERE quote_id=$1',[id(10)]))[0].n,0);
    assert.equal((await sql('SELECT count(*)::int n FROM sales_quote_line'))[0].n,0);
    assert.equal((await sql("SELECT count(*)::int n FROM sales_audit_event WHERE action='quote.deleted'"))[0].n,1);
    for (const [i,table] of ['sales_quote_delivery_token','sales_quote_delivery_audit','sales_agreement_envelope',
      'sales_commercial_sale','sales_space_allocation','future_fulfilment'].entries()) {
      const n = 20+i;
      await create(n); await lifecycle(n,'archive');
      await sql(`INSERT INTO ${table}(tenant_id,quote_id) VALUES($1,$2)`,[tenant,id(n)]);
      await assert.rejects(lifecycle(n,'delete',2),e => e.code === 'PT409');
      assert.equal((await sql('SELECT row_version FROM sales_quote WHERE id=$1',[id(n)]))[0].row_version,2);
    }
    await create(30);
    await sql(`INSERT INTO sales_stage_historical_invoice VALUES($1,$2)`,[tenant,id(1030)]);
    await lifecycle(30,'archive');
    await assert.rejects(lifecycle(30,'delete',2),e => e.code === 'PT409' && /financial/.test(e.message));
    await create(31);
    await sql("UPDATE sales_quote_version SET status='issued',issued_at=now() WHERE quote_id=$1",[id(31)]);
    await lifecycle(31,'archive'); // Issued commitments are unchanged by archive.
    assert.equal((await sql('SELECT status FROM sales_quote_version WHERE quote_id=$1',[id(31)]))[0].status,'issued');
    await assert.rejects(lifecycle(31,'delete',2),e => e.code === 'PT409' && /never-issued/.test(e.message));
    await assert.rejects(sql("UPDATE sales_quote_version SET notes='changed' WHERE quote_id=$1",[id(31)]),e => e.code === '23514');
    // A new draft cannot conceal an earlier issued version.
    await sql(`INSERT INTO sales_quote_version(tenant_id,quote_id,version_number,currency,created_by)
      VALUES($1,$2,2,'GBP','actor')`,[tenant,id(31)]);
    await sql('UPDATE sales_quote SET current_version=2 WHERE id=$1',[id(31)]);
    await assert.rejects(lifecycle(31,'delete',2),e => e.code === 'PT409');
    for (const role of ['anon','authenticated']) {
      await sql(`SET ROLE ${role}`);
      await assert.rejects(lifecycle(31,'restore',2),e => e.code === '42501');
      await sql('RESET ROLE');
    }
    await sql('SET ROLE service_role');
    assert.equal((await lifecycle(31,'restore',2)).archived_at,null);
    await sql('RESET ROLE');
    // A child reference racing deletion waits on the parent lock, then fails.
    await create(40); await lifecycle(40,'archive');
    await sql('BEGIN'); await lifecycle(40,'delete',2);
    const other = await connect();
    let settled = false;
    const insert = other.query('INSERT INTO future_fulfilment VALUES($1,$2)',[tenant,id(40)])
      .then(() => 'unexpected success', e => e.code).finally(() => { settled=true; });
    await new Promise(r => setTimeout(r,100));
    assert.equal(settled,false);
    await sql('COMMIT');
    assert.equal(await insert,'23503');
  } finally {
    await Promise.all(clients.map(c => c.end().catch(() => {})));
    if (started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    rmSync(dir,{ recursive:true,force:true });
  }
});
