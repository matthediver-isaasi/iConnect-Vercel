import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('isolated PostgreSQL: fair durable archive leases, retry and least privilege', async () => {
  const h = await createLocalPostgresHarness('historical-status-');
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  const sql = text => run('psql', ['-h', h.socket, '-p', String(h.port), '-U', 'postgres',
    '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At'], text);
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY); CREATE TABLE member(id uuid PRIMARY KEY);`);
    sql(readFileSync('supabase/migrations/20261202_historical_member_invoices.sql', 'utf8'));
    const migration = readFileSync('supabase/migrations/20261203_historical_invoice_status_refresh.sql', 'utf8');
    sql(migration);
    sql(migration);
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'claim_historical_invoice_status_refresh(integer)', 'EXECUTE')`), 'f');
      assert.equal(sql(`SELECT has_function_privilege('${role}', 'apply_historical_invoice_status_batch(jsonb)', 'EXECUTE')`), 'f');
    }
    assert.equal(sql("SELECT has_column_privilege('service_role','historical_member_invoice','status','UPDATE')"), 'f');
    assert.equal(sql("SELECT has_column_privilege('service_role','historical_member_invoice','accounting_status','UPDATE')"), 't');
    sql(`INSERT INTO tenant SELECT md5('tenant-'||n)::uuid FROM generate_series(1,5) n;
      INSERT INTO member VALUES (md5('member')::uuid);
      INSERT INTO historical_invoice_import(id,tenant_id,source_sha256,worksheet)
        SELECT id,id,repeat('a',64),'sheet' FROM tenant;
      INSERT INTO historical_member_invoice
        (tenant_id,member_id,import_id,source_row,source_key,invoice_number,invoice_date,amount_minor,record_kind,status,xero_company_id)
        SELECT t.id,md5('member')::uuid,t.id,n+1,'invoice:'||n,'INV-'||n,'2020-01-01',100,
          CASE WHEN n=21 THEN 'credit' WHEN n=22 THEN 'overpayment' ELSE 'invoice' END,
          'imported unpaid','company'
        FROM tenant t CROSS JOIN generate_series(1,22) n;`);
    const claim = (limit = 12) => JSON.parse(sql(`SET ROLE service_role;
      SELECT coalesce(json_agg(r),'[]') FROM claim_historical_invoice_status_refresh(${limit}) r;`));
    const first = claim();
    assert.equal(first.length, 12);
    const tenants = new Map();
    for (const row of first) {
      assert.equal(row.record_kind, 'invoice');
      assert.equal(row.status, 'imported unpaid');
      assert.ok(new Date(row.accounting_status_next_check_at) > new Date());
      tenants.set(row.tenant_id, (tenants.get(row.tenant_id) || 0) + 1);
    }
    assert.equal(tenants.size, 5);
    assert.ok([...tenants.values()].every(count => count <= 3));
    const second = claim();
    assert.equal(second.length, 12);
    assert.ok(second.every(row => !first.some(previous => previous.id === row.id)));
    // Exhaust the due queue: archived credit/overpayment rows are never leased.
    let total = first.length + second.length;
    for (let i = 0; i < 20; i++) {
      const next = claim();
      total += next.length;
      if (!next.length) break;
    }
    assert.equal(total, 100);
    assert.equal(claim().length, 0);
    // Simulate an abandoned claim's lease expiring. Only that record retries.
    sql(`UPDATE historical_member_invoice SET accounting_status_next_check_at=now()-interval '1 minute'
      WHERE id='${first[0].id}';`);
    assert.deepEqual(claim().map(row => row.id), [first[0].id]);
    assert.equal(sql("SELECT count(*) FROM historical_member_invoice WHERE status <> 'imported unpaid'"), '0');
    assert.equal(sql("SELECT count(*) FROM historical_member_invoice WHERE xero_document_id IS NOT NULL"), '0');

    const expected = first[1];
    const patch = {
      xero_document_id: '11111111-1111-4111-8111-111111111111', xero_document_type: 'Invoices',
      accounting_status: 'PAID', accounting_payment_status: 'paid',
      accounting_status_checked_at: '2026-01-01T00:00:00Z',
      accounting_status_next_check_at: '2099-01-01T00:00:00Z',
      accounting_status_error: null, accounting_status_failures: 0,
    };
    const apply = updates => sql(`SET ROLE service_role; SELECT apply_historical_invoice_status_batch('${JSON.stringify(updates)}'::jsonb);`);
    assert.equal(apply([{ expected, patch }]), '1');
    assert.equal(apply([{ expected, patch }]), '0'); // old lease/reference CAS
    assert.equal(sql(`SELECT status||':'||accounting_payment_status FROM historical_member_invoice WHERE id='${expected.id}'`), 'imported unpaid:paid');
    const conflicting = first[2];
    sql(`UPDATE historical_member_invoice SET xero_document_id='22222222-2222-4222-8222-222222222222',xero_document_type='Invoices'
      WHERE id='${conflicting.id}';`);
    assert.equal(apply([{ expected: conflicting, patch }]), '0');
    assert.equal(sql(`SELECT xero_document_id FROM historical_member_invoice WHERE id='${conflicting.id}'`), '22222222-2222-4222-8222-222222222222');

    // Realistically sized first sweep: one tenant's 7086 records fit eight ticks,
    // with no PostgREST >1000-row response requirement and no repeat starvation.
    sql(`INSERT INTO tenant VALUES(md5('large-tenant')::uuid);
      INSERT INTO historical_invoice_import(id,tenant_id,source_sha256,worksheet)
        VALUES(md5('large-tenant')::uuid,md5('large-tenant')::uuid,repeat('b',64),'sheet');
      INSERT INTO historical_member_invoice
        (tenant_id,member_id,import_id,source_row,source_key,invoice_number,invoice_date,amount_minor,record_kind,status,xero_company_id)
        SELECT md5('large-tenant')::uuid,md5('member')::uuid,md5('large-tenant')::uuid,
          n+1,'invoice:'||n,'INV-'||n,'2020-01-01',100,'invoice','imported unpaid','company'
        FROM generate_series(1,7086) n;`);
    // Recently checked unpaid rows are due again, but cannot crowd out the
    // first/full daily sweep. Spare capacity may still refresh these sooner.
    sql(`INSERT INTO historical_member_invoice
        (tenant_id,member_id,import_id,source_row,source_key,invoice_number,invoice_date,amount_minor,record_kind,status,xero_company_id,
          accounting_status_checked_at,accounting_status_next_check_at,accounting_payment_status)
      SELECT md5('large-tenant')::uuid,md5('member')::uuid,md5('large-tenant')::uuid,
        n+1,'invoice:'||n,'INV-'||n,'2020-01-01',100,'invoice','imported unpaid','company',
        now()-interval '3 hours',now()-interval '1 hour','unpaid'
      FROM generate_series(7087,8086) n;`);
    const seen = new Set();
    for (let tick = 0; tick < 8; tick++) {
      const batch = claim(100000);
      assert.equal(batch.length, 1000);
      assert.equal(batch.filter(row => row.accounting_status_checked_at === null).length, tick < 7 ? 1000 : 86);
      for (const row of batch) {
        assert.equal(seen.has(row.id), false);
        seen.add(row.id);
      }
    }
    assert.equal(seen.size, 8000);
    assert.equal(claim(1000).length, 86);
    assert.equal(claim(1000).length, 0);
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
