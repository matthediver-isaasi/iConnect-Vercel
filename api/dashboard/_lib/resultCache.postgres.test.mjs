import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createLocalPostgresHarness } from '../../../scripts/test-support/local-postgres-harness.mjs';
import { readWidgetCache, executeClaim, runCacheScheduler } from './resultCache.js';

function command(name, args) {
  const out = spawnSync(name, args, { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr || out.stdout);
}

test('durable widget cache SQL, fencing, isolation, fairness and 24-widget warm performance', async t => {
  const local = await createLocalPostgresHarness('dashboard-cache-');
  let client;
  try {
    command('initdb', ['-D', local.data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', local.data, '-l', `${local.root}/postgres.log`, '-o',
      `-k ${local.socket} -p ${local.port} -c listen_addresses=''`, '-w', 'start']);
    client = new pg.Client({ host: local.socket, port: local.port, user: 'postgres', database: 'postgres' });
    await client.connect();
    await client.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member(id uuid PRIMARY KEY);`);
    await client.query(await readFile(new URL('../../../migrations/create_dashboard_widget.sql', import.meta.url), 'utf8'));
    const migration = await readFile(new URL('../../../migrations/dashboard_widget_result_cache.sql', import.meta.url), 'utf8');
    await client.query(migration);
    await client.query(migration); // deployment replay is safe
    const db = {
      async rpc(name, args = {}) {
        const keys = Object.keys(args);
        assert.match(name, /^dashboard_widget_cache_(touch|claim|publish|stats)$/);
        assert.ok(keys.every(key => /^p_[a-z_]+$/.test(key)));
        try {
          const result = await client.query(`SELECT to_jsonb(${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')})) AS value`, Object.values(args));
          return { data: result.rows[0].value, error: null };
        } catch (error) { return { data: null, error }; }
      },
    };
    const rpc = async (name, args = {}) => {
      const r = await db.rpc(`dashboard_widget_cache_${name}`, args);
      if (r.error) throw r.error;
      return r.data;
    };
    const actor = { memberId: randomUUID(), tenantId: randomUUID() };
    const other = { memberId: randomUUID(), tenantId: randomUUID() };
    await client.query('INSERT INTO member(id) VALUES($1),($2)', [actor.memberId, other.memberId]);
    async function insert(overrides = {}) {
      const w = { id: randomUUID(), tenant_id: actor.tenantId, scope: 'shared', owner_member_id: null,
        config: { source: 'organization', measure: { aggregator: 'count' } }, widget_type: 'bar', ...overrides };
      await client.query(`INSERT INTO dashboard_widget(id,tenant_id,scope,owner_member_id,title,widget_type,config)
        VALUES($1,$2,$3,$4,'Test',$5,$6)`, [w.id,w.tenant_id,w.scope,w.owner_member_id,w.widget_type,w.config]);
      return w;
    }
    const row = async w => (await client.query('SELECT * FROM dashboard_widget_result_cache WHERE widget_id=$1', [w.id])).rows[0];
    const due = async w => client.query(`UPDATE dashboard_widget_result_cache
      SET due_at=now()-interval '1 second',last_explicit_at=NULL,lease_until=NULL WHERE widget_id=$1`, [w.id]);
    const claim = async w => rpc('claim', { p_widget_id:w.id,p_identity:(await row(w)).identity });
    const publish = (c, result, error = null) => rpc('publish', { p_widget_id:c.widget.id,p_identity:c.cache.identity,
      p_token:c.cache.lease_token,p_result:result,p_error:error });

    const widgets = await Promise.all(Array.from({ length: 24 }, () => insert()));
    let calls = 0;
    const run = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 3)); return { rows:[{ value:7 }],categories:[] }; };
    const coldStart = performance.now();
    for (const w of widgets) assert.equal((await readWidgetCache(db,w,actor,{ run })).cache.status,'current');
    const coldMs = performance.now()-coldStart;
    assert.equal(calls,24);
    const warmStart = performance.now();
    for (const w of widgets) assert.equal((await readWidgetCache(db,w,actor,{ run })).data.rows[0].value,7);
    const warmMs = performance.now()-warmStart;
    assert.equal(calls,24);
    t.diagnostic(JSON.stringify({ widgets:24,coldAggregations:24,warmAggregations:0,coldMs,warmMs }));

    const w = widgets[0];
    await client.query(`UPDATE dashboard_widget_result_cache SET updated_at=now()-interval '16 minutes',
      due_at=now()-interval '1 minute' WHERE widget_id=$1`,[w.id]);
    assert.equal((await readWidgetCache(db,w,actor,{ run })).cache.status,'stale');
    assert.equal(calls,24);
    const first = await claim(w);
    assert.ok(first);
    assert.equal(await claim(w),null);
    // Explicit claims while a lease is active coalesce; stale payload stays visible.
    const pending = await readWidgetCache(db,w,actor,{ refresh:true,run });
    assert.equal(pending.cache.pending,true);
    assert.equal(pending.data.rows[0].value,7);
    await client.query(`UPDATE dashboard_widget_result_cache SET lease_until=now()-interval '1 second' WHERE widget_id=$1`,[w.id]);
    const second = await claim(w);
    assert.notEqual(first.cache.lease_token,second.cache.lease_token);
    assert.equal(await publish(first,{ rows:[{ value:999 }] }),false);
    assert.equal(await publish(second,null,'Failure'),true);
    const failed = await readWidgetCache(db,w,actor,{ run });
    assert.equal(failed.cache.status,'failed');
    assert.equal(failed.data.rows[0].value,7);
    assert.equal(await claim(w),null); // backoff enforced
    await due(w);
    const editedClaim = await claim(w);
    await client.query(`UPDATE dashboard_widget SET config='{"source":"member"}' WHERE id=$1`,[w.id]);
    assert.equal(await publish(editedClaim,{ rows:[{ value:999 }] }),false);
    await assert.rejects(readWidgetCache(db,w,actor,{ run }),/Widget changed/);
    assert.equal((await row(w)).result,null);
    // Cosmetic updates do not discard successful cache identities.
    const identity = (await row(widgets[1])).identity;
    await client.query(`UPDATE dashboard_widget SET title='New title' WHERE id=$1`,[widgets[1].id]);
    assert.equal((await row(widgets[1])).identity,identity);
    await due(widgets[1]);
    const deletedClaim = await claim(widgets[1]);
    await client.query('DELETE FROM dashboard_widget WHERE id=$1',[widgets[1].id]);
    assert.equal(await publish(deletedClaim,{ rows:[] }),false);

    const personal = await insert({ scope:'personal',owner_member_id:actor.memberId });
    assert.equal(await claim(personal),null); // dormant personal widgets not prewarmed
    await assert.rejects(readWidgetCache(db,personal,other,{ run }),/not available/);
    await readWidgetCache(db,personal,actor,{ run });
    await due(personal);
    assert.ok(await claim(personal));
    const nullTenant = await insert({ tenant_id:null });
    assert.ok((await readWidgetCache(db,nullTenant,{ ...actor,tenantId:null },{ run })).data);
    await assert.rejects(rpc('touch',{ p_widget:{ ...nullTenant,tenant_id:other.tenantId },p_actor:actor.memberId }),/Widget changed/);
    const scopeClaimWidget = await insert();
    const scopeClaim = await claim(scopeClaimWidget);
    await client.query(`UPDATE dashboard_widget SET scope='personal',owner_member_id=$2 WHERE id=$1`,[scopeClaimWidget.id,other.memberId]);
    assert.equal(await publish(scopeClaim,{ rows:[] }),false);

    const cooldown = widgets[2];
    let before = calls;
    await readWidgetCache(db,cooldown,actor,{ refresh:true,run });
    await readWidgetCache(db,cooldown,actor,{ refresh:true,run });
    assert.equal(calls,before+1);
    for (let i=0;i<20;i++) {
      try { await readWidgetCache(db,cooldown,actor,{ refresh:true,run }); } catch (error) { assert.match(error.message,/Refresh limit/); }
    }
    await assert.rejects(readWidgetCache(db,cooldown,actor,{ refresh:true,run }),/Refresh limit/);

    await client.query(`UPDATE dashboard_widget_result_cache SET due_at=now()+interval '1 hour',lease_until=NULL,lease_token=NULL`);
    const raced = await insert();
    const connection = new pg.Client({ host:local.socket,port:local.port,user:'postgres',database:'postgres' });
    await connection.connect();
    try {
      const key = (await row(raced)).identity;
      const sql = 'SELECT dashboard_widget_cache_claim($1,$2) AS claim';
      const claims = await Promise.all([client.query(sql,[raced.id,key]),connection.query(sql,[raced.id,key])]);
      assert.equal(claims.filter(r=>r.rows[0].claim!==null).length,1,'concurrent connections coalesce atomically');
      await executeClaim(db,claims.find(r=>r.rows[0].claim).rows[0].claim,{run});
    } finally { await connection.end(); }
    await client.query(`UPDATE dashboard_widget_result_cache SET last_viewed_at=now()-interval '8 days',
      due_at=now()-interval '1 minute' WHERE widget_id=$1`,[personal.id]);
    assert.equal(await claim(personal),null);

    // Clear work, then show tenant rotation despite a larger first-tenant backlog.
    await client.query(`UPDATE dashboard_widget_result_cache SET due_at=now()+interval '1 hour',lease_until=NULL,lease_token=NULL`);
    const a = await insert();
    await insert();
    const b = await insert({ tenant_id:other.tenantId });
    const c1 = await rpc('claim');
    const c2 = await rpc('claim');
    assert.notEqual(c1.widget.tenant_id,c2.widget.tenant_id);
    assert.ok([actor.tenantId,other.tenantId].includes(c1.widget.tenant_id));
    await executeClaim(db,c1,{ run });
    await executeClaim(db,c2,{ run });
    const report = await runCacheScheduler(db,{ run,maxJobs:2 });
    assert.ok(report.attempted<=2);
    assert.equal(typeof report.backlog.overdue,'number');

    // Timeout leaves last success untouched and records failure.
    await due(b);
    const timeoutClaim = await claim(b);
    await executeClaim(db,timeoutClaim,{ run:()=>new Promise(()=>{}),timeoutMs:5 });
    assert.equal((await row(b)).failures,1);
    assert.ok((await row(b)).result);
    await client.query('SET ROLE authenticated');
    await assert.rejects(client.query('SELECT * FROM dashboard_widget_result_cache'),/permission denied/);
    await assert.rejects(client.query('SELECT dashboard_widget_cache_claim()'),/permission denied/);
    await client.query('RESET ROLE');
    assert.ok(a.id);
  } finally {
    if (client) await client.end();
    try { command('pg_ctl',['-D',local.data,'-m','immediate','-w','stop']); } finally { await local.cleanup(); }
  }
});