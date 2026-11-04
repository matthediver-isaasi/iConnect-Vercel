import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { createXeroRateLimitedFetch } from '../api/_lib/xeroRateLimit.js';
import { createAccountingRequestProviders } from '../api/_lib/accountingRequestProviders.js';

const app = 'a'.repeat(64), otherApp = 'b'.repeat(64);
const url = 'https://api.xero.com/api.xro/2.0/Invoices/inv';
const headers = company => ({ Authorization: `Bearer fixture`, 'Xero-tenant-id': company });

test('shared Xero quota authority with isolated PostgreSQL and fake HTTP only', async t => {
  const h = await createLocalPostgresHarness('xero-rates-');
  let pool, started = false;
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o',
      `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    pool = new pg.Pool({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres', max: 12 });
    await pool.query('create role anon; create role authenticated; create role service_role bypassrls;');
    await pool.query(readFileSync('supabase/migrations/202612060002_xero_shared_rate_limits.sql', 'utf8'));
    const db = { rpc: async (name, args) => {
      const names = Object.keys(args);
      const client = await pool.connect();
      try {
        await client.query('set role service_role');
        const { rows } = await client.query(`select public.${name}(${names.map((key, i) => `${key}=>$${i + 1}`).join(',')}) as data`, Object.values(args));
        return { data: rows[0].data, error: null };
      } catch (error) { return { data: null, error }; }
      finally { await client.query('reset role'); client.release(); }
    } };
    const reserve = (company = 'org', key = app) => db.rpc('xero_rate_reserve', { p_app: key, p_company: company }).then(r => {
      assert.equal(r.error, null); return r.data;
    });
    const finish = (id, evidence = {}, status = 200, retry = null, company = 'org', key = app) =>
      db.rpc('xero_rate_finish', { p_app: key, p_company: company, p_id: id, p_status: status, p_headers: evidence, p_retry: retry }).then(r => {
        assert.equal(r.error, null); return r.data;
      });
    const reset = () => pool.query('truncate xero_rate_request,xero_rate_scope');
    const transport = (fetchImpl, key = app) => createXeroRateLimitedFetch({
      resolve: async h => ({ db, appKey: key, companyId: h.get('xero-tenant-id') }), fetchImpl,
    });

    await t.test('concurrent queued adapter and direct callers share five slots', async () => {
      let release;
      const latch = new Promise(r => { release = r; });
      let startedRequests = 0;
      const fetch = transport(async () => {
        startedRequests++; await latch;
        return Response.json({ Invoices: [{ InvoiceID: 'inv' }] });
      });
      const adapter = createAccountingRequestProviders({
        beforeRequest: async () => ({}), fetchImpl: fetch,
        resolveConnection: async row => ({ tenantId: row.tenant_id, provider: 'xero',
          connectionId: 'connection', companyId: 'org', accessToken: 'fixture' }),
      });
      const row = { tenant_id: 'tenant', provider: 'xero', connection_id: 'connection', company_id: 'org', snapshot: {} };
      const pending = Array.from({ length: 10 }, (_, i) => i % 2
        ? fetch(url, { headers: headers('org') }).then(r => r.status)
        : adapter.readExistingInvoice(row, 'inv').then(() => 200, e => e.status));
      // Wait for all reservations without arbitrary timing assumptions.
      for (let i = 0; i < 100; i++) {
        if (startedRequests === 5) break;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(startedRequests, 5);
      // Remaining reservations must finish before releasing held transports.
      await new Promise(r => setTimeout(r, 100));
      release();
      const statuses = await Promise.all(pending);
      assert.equal(statuses.filter(s => s === 200).length, 5);
      assert.equal(statuses.filter(s => s === 429).length, 5);
      assert.equal((await pool.query('select count(*)::int as n from xero_rate_request where not finished')).rows[0].n, 0);
    });

    await t.test('rolling 60/minute per app+organisation; other apps independent', async () => {
      await reset();
      for (let i = 0; i < 60; i++) { const r = await reserve(); assert.ok(r.id); await finish(r.id); }
      assert.equal((await reserve()).retry_after, 60);
      assert.ok((await reserve('org', otherApp)).id);
      assert.ok((await reserve('other')).id);
      await pool.query("update xero_rate_request set started_at=clock_timestamp()-interval '61 seconds',lease_until=clock_timestamp()-interval '1 second'");
      assert.ok((await reserve()).id);
    });

    await t.test('app-wide 10000/minute includes other organisations', async () => {
      await reset();
      await pool.query(`insert into xero_rate_request(app_key,company_id,finished)
        select $1,'other-'||i,true from generate_series(1,10000) i`, [app]);
      assert.equal((await reserve('new-org')).retry_after, 60);
      assert.ok((await reserve('new-org', otherApp)).id);
    });

    await t.test('long daily Retry-After survives later success and crosses local tenants', async () => {
      await reset();
      const first = await reserve(), inFlight = await reserve();
      await finish(first.id, { 'retry-after': '900000', 'x-daylimit-remaining': '0',
        'x-minlimit-remaining': '15', 'x-rate-limit-problem': 'day' }, 429, 900000);
      await finish(inFlight.id, { 'x-daylimit-remaining': '3' });
      assert.ok((await reserve()).retry_after >= 899999);
      assert.ok((await reserve('org', otherApp)).id);
      assert.ok((await reserve('other')).id);
    });

    await t.test('app headers stop other organisations, unknown 429 fails closed', async () => {
      await reset();
      const first = await reserve();
      await finish(first.id, { 'retry-after': '120', 'x-appminlimit-remaining': '0', 'x-rate-limit-problem': 'appminute' }, 429, 120);
      assert.ok((await reserve('other')).retry_after >= 119);
      assert.ok((await reserve('org', otherApp)).id);
      await reset();
      await finish((await reserve()).id, {}, 429);
      assert.ok((await reserve('other')).retry_after >= 59);
    });

    await t.test('success quota headers trigger daily/minute pauses and retain evidence', async () => {
      await reset();
      let calls = 0;
      const fetch = transport(async () => {
        calls++;
        return Response.json({}, { headers: { 'x-daylimit-remaining': '0',
          'x-minlimit-remaining': '55', 'x-appminlimit-remaining': '9980' } });
      });
      const first = await fetch(url, { headers: headers('org') });
      assert.equal(first.headers.get('x-daylimit-remaining'), '0');
      assert.equal((await fetch(url, { headers: headers('org') })).status, 429);
      assert.equal(calls, 1);
      assert.ok((await reserve()).retry_after >= 86399);
      const saved = (await pool.query("select headers from xero_rate_scope where company_id='org'")).rows[0].headers;
      assert.equal(saved['x-appminlimit-remaining'], '9980');
      await reset();
      await finish((await reserve()).id, { 'x-minlimit-remaining': '0' });
      assert.ok((await reserve()).retry_after >= 59);
    });

    await t.test('HTTP dates and overflow pauses are never capped or replayed', async () => {
      await reset();
      let calls = 0;
      const retryDate = new Date(Date.now() + 900000000).toUTCString();
      const fetch = transport(async () => {
        calls++; return Response.json({}, { status: 429, headers: {
          'retry-after': retryDate, 'x-rate-limit-problem': 'day',
        } });
      });
      assert.equal((await fetch(url, { method: 'POST', headers: headers('org'), body: '{}' })).status, 429);
      assert.ok((await reserve()).retry_after > 899990);
      assert.equal((await fetch(url, { method: 'POST', headers: headers('org'), body: '{}' })).status, 429);
      assert.equal(calls, 1);
      await reset();
      await finish((await reserve()).id, { 'x-rate-limit-problem': 'day' }, 429, -1);
      assert.equal((await reserve()).retry_after, 2147483648);
    });

    await t.test('coordination failure refuses before send; post-send failure stays uncertain', async () => {
      let calls = 0;
      const failedDb = { rpc: async () => ({ error: new Error('fixture unavailable') }) };
      const fetch = createXeroRateLimitedFetch({
        resolve: async () => ({ db: failedDb, appKey: app, companyId: 'org' }),
        fetchImpl: async () => { calls++; return Response.json({}); },
      });
      await assert.rejects(fetch(url, { method: 'POST' }), e => e.definitelyNotWritten === true);
      assert.equal(calls, 0);
      const afterSend = createXeroRateLimitedFetch({
        resolve: async () => ({ db: { rpc: async name => name.endsWith('reserve')
          ? { data: { id: 'fixture' } } : { error: new Error('fixture unavailable') } }, appKey: app, companyId: 'org' }),
        fetchImpl: async () => { calls++; return Response.json({}); },
      });
      await assert.rejects(afterSend(url, { method: 'POST' }), e => e.definitelyNotWritten === false && e.ambiguous);
      assert.equal(calls, 1);
    });

    await t.test('only service role can use quota RPCs; tables are not browser writable', async () => {
      const client = await pool.connect();
      try {
        for (const role of ['anon', 'authenticated']) {
          await client.query(`set role ${role}`);
          await assert.rejects(client.query('select xero_rate_reserve($1,$2)', [app, 'org']), /permission denied/);
          await assert.rejects(client.query('select * from xero_rate_scope'), /permission denied/);
        }
      } finally { await client.query('reset role'); client.release(); }
    });
  } finally {
    await pool?.end();
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    await h.cleanup();
  }
});
