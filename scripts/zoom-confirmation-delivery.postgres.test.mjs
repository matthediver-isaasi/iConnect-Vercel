import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('Zoom claims enforce uniqueness under concurrency and remain service-only', async () => {
  const h = await createLocalPostgresHarness('zoom-confirmation-');
  const run = (cmd,args) => { const r=spawnSync(cmd,args,{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); };
  let db, other, started=false;
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    const config={host:h.socket,port:h.port,user:'postgres',database:'postgres'};
    db=new pg.Client(config); other=new pg.Client(config);
    await db.connect(); await other.connect();
    await db.query('create role anon; create role authenticated; create role service_role bypassrls;');
    const sql=readFileSync('supabase/migrations/202612310110_zoom_confirmation_delivery.sql','utf8');
    await db.query(sql); await db.query(sql);
    for (const role of ['anon','authenticated']) {
      await db.query(`set role ${role}`);
      await assert.rejects(db.query('select * from zoom_confirmation_delivery'), /permission denied/);
      await db.query('reset role');
    }
    await db.query('set role service_role'); await other.query('set role service_role');
    const id='00000000-0000-4000-8000-000000000001';
    const insert=`insert into zoom_confirmation_delivery
      (tenant_id,scope,resource_id,operation_id,booking_id,target,state)
      values ($1,'event',$1,$1,$1,'meeting','claimed')`;
    const results=await Promise.allSettled([db.query(insert,[id]),other.query(insert,[id])]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'23505');
    await db.query(`update zoom_confirmation_delivery set state='completed', results='[{"success":true}]', completed_at=now()`);
    assert.equal((await db.query('select state from zoom_confirmation_delivery')).rows[0].state,'completed');
    await assert.rejects(db.query(`update zoom_confirmation_delivery set operation_id=gen_random_uuid()`),/permission denied/);
    await assert.rejects(db.query('delete from zoom_confirmation_delivery'),/permission denied/);
    await assert.rejects(other.query(insert,[id]),e=>e.code==='23505');
  } finally {
    await db?.end(); await other?.end();
    if(started) spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{stdio:'ignore'});
    await h.cleanup();
  }
});
