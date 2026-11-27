import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { createGroupResourcePinHandler } from '../api/_lib/groupResourcePins.js';
import { guardGenericResourcePin } from '../api/_lib/resourcePins.js';

test('group pin migration and dedicated writes persist independently on disposable PostgreSQL', async () => {
  const h = await createLocalPostgresHarness('group-resource-pins-');
  let db, started = false;
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    run('initdb', ['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl', ['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started = true;
    db = new pg.Client({ host:h.socket, port:h.port, user:'postgres', database:'postgres' });
    await db.connect();
    await db.query(`CREATE TABLE resource(id text PRIMARY KEY, tenant_id text NOT NULL,
      member_group_id text, title text, release_date text, is_pinned boolean NOT NULL DEFAULT false);
      INSERT INTO resource VALUES ('one','tenant','group','Original','2026-01-01',true),
      ('two','tenant','group','Second','2025-01-01',false),
      ('linked','tenant',null,'Linked',null,true),('foreign','other','group','Foreign',null,false)`);
    const migration = readFileSync('supabase/migrations/202702080002_resource_group_pins.sql','utf8');
    await db.query(migration);
    await db.query(migration);
    assert.deepEqual((await db.query('SELECT is_group_pinned FROM resource')).rows.map(r=>r.is_group_pinned), [false,false,false,false]);
    await db.query(`INSERT INTO resource(id,tenant_id,member_group_id) VALUES ('new','tenant','group')`);
    assert.equal((await db.query(`SELECT is_group_pinned FROM resource WHERE id='new'`)).rows[0].is_group_pinned, false);
    await assert.rejects(db.query(`UPDATE resource SET is_group_pinned=null WHERE id='one'`), /not-null/);
    const adapter = { from(table) {
      assert.equal(table, 'resource');
      const filters = [], values = [];
      let patch;
      const q = {
        update(value) { assert.deepEqual(Object.keys(value), ['is_group_pinned']); patch = value; return q; },
        eq(key,value) {
          assert.ok(['tenant_id','id','member_group_id'].includes(key));
          values.push(value); filters.push(`${key}=$${values.length}`); return q;
        },
        select() { return q; },
        async maybeSingle() {
          try {
            const sql = patch ? `UPDATE resource SET is_group_pinned=$${values.length+1} WHERE ${filters.join(' AND ')} RETURNING *`
              : `SELECT * FROM resource WHERE ${filters.join(' AND ')}`;
            const r = await db.query(sql, patch ? [...values,patch.is_group_pinned] : values);
            return { data:r.rows[0] || null };
          } catch (error) { return { error }; }
        },
      };
      return q;
    }};
    const ctx = { isAuthenticated:true,tenantId:'tenant' };
    const access = { hasAdminAccess:async()=>true,hasFeatureAccess:async()=>false };
    const call = async (id,is_group_pinned) => {
      // Recreate handler to simulate another request/reload.
      const res = { setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;} };
      await createGroupResourcePinHandler({db:adapter,getTenantContext:async()=>ctx,...access})
        ({method:'PATCH',body:{id,is_group_pinned}},res);
      return res;
    };
    assert.equal((await call('one',true)).code,200);
    assert.equal((await call('two',true)).code,200);
    assert.equal((await call('linked',true)).code,403);
    assert.equal((await call('foreign',true)).code,404);
    const request = {method:'PATCH',body:{title:'Edited',is_pinned:false,is_group_pinned:false}};
    assert.equal(await guardGenericResourcePin({entity:'Resource',req:request,ctx,db:adapter,id:'one',...access}),false);
    assert.deepEqual(request.body,{title:'Edited'});
    await db.query(`UPDATE resource SET title=$1 WHERE id='one'`,[request.body.title]);
    assert.equal((await call('two',false)).code,200);
    const rows = (await db.query(`SELECT id,title,is_pinned,is_group_pinned,release_date FROM resource WHERE id IN ('one','two') ORDER BY id`)).rows;
    assert.deepEqual(rows, [
      {id:'one',title:'Edited',is_pinned:true,is_group_pinned:true,release_date:'2026-01-01'},
      {id:'two',title:'Second',is_pinned:false,is_group_pinned:false,release_date:'2025-01-01'},
    ]);
    await db.query('ALTER TABLE resource DROP COLUMN is_group_pinned');
    const failed = await call('one',false);
    assert.equal(failed.code,503);
    assert.match(failed.body.error,/migration/);
  } finally {
    await db?.end();
    if (started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
