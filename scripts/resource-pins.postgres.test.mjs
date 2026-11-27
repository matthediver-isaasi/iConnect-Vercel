import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { createResourcePinHandler, guardGenericResourcePin } from '../api/_lib/resourcePins.js';

test('migration, API persistence, tenant fencing and ordinary edits on disposable PostgreSQL', async () => {
  const h = await createLocalPostgresHarness('resource-pins-');
  let db, started = false;
  const run = (command, args) => {
    const r = spawnSync(command, args, { encoding:'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    run('initdb', ['-D', h.data, '-A','trust','-U','postgres']);
    run('pg_ctl', ['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started = true;
    db = new pg.Client({ host:h.socket, port:h.port, user:'postgres', database:'postgres' });
    await db.connect();
    await db.query(`CREATE TABLE resource(id text PRIMARY KEY, tenant_id text NOT NULL,
      member_group_id text, title text, release_date text, folder_id text);
      INSERT INTO resource VALUES ('one','tenant',null,'Original','2026-01-01','folder'),
      ('two','tenant',null,'Second','2025-01-01',null),('foreign','other',null,'Foreign',null,null)`);
    await db.query(readFileSync('supabase/migrations/202702080001_resource_editorial_pins.sql','utf8'));
    assert.deepEqual((await db.query('SELECT is_pinned FROM resource')).rows.map(r=>r.is_pinned), [false,false,false]);
    await db.query(`INSERT INTO resource(id,tenant_id) VALUES ('new','tenant')`);
    assert.equal((await db.query(`SELECT is_pinned FROM resource WHERE id='new'`)).rows[0].is_pinned, false);
    await assert.rejects(db.query(`UPDATE resource SET is_pinned=null WHERE id='one'`), /not-null/);
    const adapter = { from(table) {
      assert.equal(table,'resource');
      const filters = [], values = [];
      let update;
      const q = {
        update(patch) { assert.deepEqual(Object.keys(patch),['is_pinned']); update=patch.is_pinned; return q; },
        eq(key,value) { assert.ok(['tenant_id','id'].includes(key)); values.push(value); filters.push(`${key}=$${values.length}`); return q; },
        is(key,value) { assert.equal(key,'member_group_id'); assert.equal(value,null); filters.push('member_group_id IS NULL'); return q; },
        select() { return q; },
        async maybeSingle() {
          const sql = update === undefined ? `SELECT * FROM resource WHERE ${filters.join(' AND ')}`
            : `UPDATE resource SET is_pinned=$${values.length+1} WHERE ${filters.join(' AND ')} RETURNING id,is_pinned`;
          const result = await db.query(sql, update === undefined ? values : [...values, update]);
          return {data:result.rows[0] || null};
        },
      };
      return q;
    }};
    const ctx = {isAuthenticated:true,tenantId:'tenant',roleId:'manager'};
    const access = {hasAdminAccess:async()=>false,hasFeatureAccess:async()=>true};
    const action = createResourcePinHandler({db:adapter,getTenantContext:async()=>ctx,...access});
    const invoke = async (id,is_pinned) => {
      const res = {setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;}};
      await action({method:'PATCH',body:{id,is_pinned}},res);
      return res;
    };
    assert.equal((await invoke('one',true)).code,200);
    assert.equal((await invoke('two',true)).code,200);
    assert.equal((await invoke('foreign',true)).code,404);
    const request = {method:'PATCH',body:{title:'Edited',is_pinned:false}};
    await guardGenericResourcePin({entity:'Resource',req:request,ctx,db:adapter,id:'one',...access});
    assert.deepEqual(request.body,{title:'Edited'});
    await db.query('UPDATE resource SET title=$1 WHERE id=$2',[request.body.title,'one']);
    assert.deepEqual((await db.query(`SELECT is_pinned,release_date,folder_id,title FROM resource WHERE id='one'`)).rows[0],
      {is_pinned:true,release_date:'2026-01-01',folder_id:'folder',title:'Edited'});
    assert.equal((await invoke('one',false)).code,200);
    assert.deepEqual((await db.query(`SELECT id FROM resource WHERE is_pinned ORDER BY id`)).rows.map(r=>r.id),['two']);
  } finally {
    await db?.end();
    if (started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
