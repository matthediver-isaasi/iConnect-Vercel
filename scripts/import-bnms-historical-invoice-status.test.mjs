import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { prepareRows, TENANT } from './import-bnms-historical-invoices.mjs';
import { ORIGINAL_SHA, SHEETS, readWorkbook, reconcile, importStatuses } from './import-bnms-historical-invoice-status.mjs';

const member = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const base = (n, amount = 100) => ({ member_id: member, source_row: n + 1, invoice_number: `INV-${n}`,
    invoice_date: '2026-01-01', amount_minor: amount, description: 'Membership' });
  const originals = SHEETS.map((worksheet, i) => ({ worksheet, source_sha256: ORIGINAL_SHA,
    rows: prepareRows(i ? [] : [base(1), base(2), { ...base(3), invoice_number: 'Sales Overpayment' }]).map(r => ({ ...r, worksheet })) }));
  const inputs = originals.map(s => ({ ...s, source_sha256: 'a'.repeat(64), rows: s.rows.map(r => ({ ...r, status: 'paid' })) }));
  const archive = originals[0].rows.filter(r => r.invoice_number !== 'INV-2').map((r, i) => ({
    ...r, id: `00000000-0000-4000-8000-00000000000${i + 2}`, tenant_id: TENANT,
    import_id: '00000000-0000-4000-8000-000000000010', xero_company_id: 'company', status: null }));
  const imports = SHEETS.map((worksheet, i) => ({ id: `00000000-0000-4000-8000-00000000001${i}`, worksheet, source_sha256: ORIGINAL_SHA }));
  const journal = originals[0].rows.map(r => ({ import_id: imports[0].id, source_row: r.source_row,
    outcome: r.invoice_number === 'INV-2' ? 'existing' : 'imported',
    detail: r.invoice_number === 'INV-2' ? 'invoice' : 'historical metadata only' }));
  return { originals, inputs, snapshot: { archive, imports, journal, company: 'company',
    operational: [{ number: 'INV-2', table: 'invoice', column: 'invoice_number', status: 'AUTHORISED' }] } };
}

test('real workbooks: exact metadata match, pinned occurrences, explicit status vocabulary', () => {
  const originals = readWorkbook('attached_assets/Final_BNMS_invoices_to_import_01.01.25_to_date_-_import_13.10_1791914288756.xlsx', false);
  const inputs = readWorkbook('attached_assets/Final_BNMS_invoices_import_13.10.26_WITH_STATUS_1792392617933.xlsx');
  assert.deepEqual(inputs.map(s => s.rows.length), [9453, 14]);
  const statuses = {};
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(originals[i].source_sha256, ORIGINAL_SHA);
    for (let n = 0; n < inputs[i].rows.length; n++) {
      const { status, source_status, ...metadata } = inputs[i].rows[n];
      assert.deepEqual(metadata, originals[i].rows[n]);
      assert.ok(['paid', 'outstanding'].includes(status));
      statuses[status] = (statuses[status] || 0) + 1;
    }
  }
  assert.deepEqual(statuses, { paid: 9371, outstanding: 96 });
});

test('pure plan distinguishes new, historical status, operational mismatch; metadata drift blocks', () => {
  const f = fixture();
  f.inputs[0].rows.push({ ...f.inputs[0].rows[0], source_row: 5, source_key: 'invoice:NEW', invoice_number: 'NEW' });
  let plan = reconcile(f.inputs, f.originals, f.snapshot);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(plan.summary.counts, { status_update: 2, operational_skip: 1, new: 1 });
  assert.equal(plan.summary.operationalStatusComparisons.mismatch, 1);
  f.inputs[0].rows[0].amount_minor = 101;
  plan = reconcile(f.inputs, f.originals, f.snapshot);
  assert.ok(plan.conflicts.some(c => c.reason === 'original_metadata_changed'));
  assert.ok(plan.conflicts.some(c => c.reason === 'archive_metadata_conflict'));
});

test('journal disappearance, overpayment movement and duplicate identity are conflicts; invalid statuses fail', () => {
  const f = fixture();
  f.snapshot.operational = [];
  assert.ok(reconcile(f.inputs, f.originals, f.snapshot).conflicts.some(c => c.reason === 'skipped_operational_reference_missing'));
  f.inputs[0].rows[2].source_row++;
  assert.ok(reconcile(f.inputs, f.originals, f.snapshot).conflicts.some(c => c.reason === 'overpayment_occurrence_moved'));
  f.inputs[1].rows.push(f.inputs[0].rows[0]);
  assert.ok(reconcile(f.inputs, f.originals, f.snapshot).conflicts.some(c => c.reason === 'duplicate_cross_sheet_key'));
  f.inputs[0].rows[0].status = 'settled';
  assert.throws(() => reconcile(f.inputs, f.originals, f.snapshot), /Invalid status/);
});

test('verified original imported archives may receive status-only updates despite existing operational mirrors', () => {
  const f = fixture();
  f.snapshot.operational.push({ number: 'INV-1', table: 'invoice', column: 'invoice_number', status: 'AUTHORISED' });
  let plan = reconcile(f.inputs, f.originals, f.snapshot);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.summary.verifiedPreExistingOverlaps, 1);
  assert.equal(plan.rows.find(r => r.invoice_number === 'INV-1').action, 'status_update');
  assert.equal(plan.rows.find(r => r.invoice_number === 'INV-1').operational[0].status, 'AUTHORISED');
  f.snapshot.journal[0].outcome = 'existing';
  f.snapshot.journal[0].detail = 'historical_member_invoice';
  plan = reconcile(f.inputs, f.originals, f.snapshot);
  assert.ok(plan.conflicts.some(c => c.reason === 'archive_operational_overlap'));
  assert.equal(plan.summary.verifiedPreExistingOverlaps, 0);
  f.snapshot.journal[0].outcome = 'imported';
  f.snapshot.archive[0].description = 'unexpected metadata';
  plan = reconcile(f.inputs, f.originals, f.snapshot);
  assert.ok(plan.conflicts.some(c => c.reason === 'archive_operational_overlap'));
  assert.ok(plan.conflicts.some(c => c.reason === 'original_archive_or_journal_drift'));
});

test('status parser rejects blank, unknown, and case-variant workbook values', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'invoice-status-parser-'));
  try {
    const result = spawnSync('python', ['-c', `
import openpyxl,datetime,sys
for i,status in enumerate([None,"Settled","paid","Paid","Outstanding"]):
    b=openpyxl.Workbook()
    s=b.active
    s.title="To import good"
    s.append(["iConnect member UUID","Invoice number","Invoice date","Gross","Invoice description","Payment status"])
    s.append(["${member}","INV-1",datetime.datetime(2026,1,1),1,"Membership",status])
    b.save(sys.argv[1]+"/"+str(i)+".xlsx")
`, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (let i = 0; i < 5; i++) {
      const parsed = spawnSync('python', ['scripts/lib/read-bnms-historical-invoices.py', path.join(root, `${i}.xlsx`),
        'To import good', '--status'], { encoding: 'utf8' });
      assert.equal(parsed.status === 0, i >= 3);
      if (i < 3) assert.match(parsed.stderr, /Invalid Payment status/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('disposable PostgreSQL: read-only preview, guarded atomic apply, before-image failure rollback, replay and protected finance', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'invoice-status-pg-')), data = path.join(root, 'data'), socket = path.join(root, 'socket');
  mkdirSync(socket);
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const db = new pg.Client({ host: socket, port: 55469, user: 'postgres', database: 'postgres' });
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'pg.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55469`, '-w', 'start']); started = true;
    await db.connect();
    await db.query(`CREATE TABLE organization(id uuid,tenant_id uuid);
      CREATE TABLE member(id uuid,tenant_id uuid,organization_id uuid);
      CREATE TABLE xero_token(app_tenant_id uuid,tenant_id text);
      CREATE TABLE invoice(tenant_id uuid,invoice_number text,status text,amount_minor bigint);
      CREATE TABLE historical_invoice_import(id uuid primary key default gen_random_uuid(),tenant_id uuid,source_sha256 text,worksheet text,unique(tenant_id,source_sha256,worksheet));
      CREATE TABLE historical_invoice_import_row(import_id uuid,source_row int,outcome text,detail text,primary key(import_id,source_row));
      CREATE TABLE historical_member_invoice(id uuid primary key default gen_random_uuid(),tenant_id uuid,member_id uuid,import_id uuid,source_row int,
        source_key text,invoice_number text,invoice_date date,amount_minor bigint,description text,record_kind text,xero_company_id text,status text,
        unique(tenant_id,source_key),unique(import_id,source_row));`);
    const f = fixture();
    await db.query('INSERT INTO member VALUES($1,$2,NULL)', [member, TENANT]);
    await db.query("INSERT INTO xero_token VALUES($1,'company')", [TENANT]);
    await db.query("INSERT INTO invoice VALUES($1,'INV-2','AUTHORISED',900)", [TENANT]);
    for (const i of f.snapshot.imports) await db.query('INSERT INTO historical_invoice_import VALUES($1,$2,$3,$4)', [i.id, TENANT, i.source_sha256, i.worksheet]);
    for (const j of f.snapshot.journal) await db.query('INSERT INTO historical_invoice_import_row VALUES($1,$2,$3,$4)', [j.import_id, j.source_row, j.outcome, j.detail]);
    for (const r of f.snapshot.archive) await db.query(`INSERT INTO historical_member_invoice VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [r.id, TENANT, r.member_id, r.import_id, r.source_row, r.source_key, r.invoice_number, r.invoice_date, r.amount_minor, r.description, r.record_kind, r.xero_company_id, null]);
    // Verified original archive overlap: archive status can change, finance cannot.
    await db.query("INSERT INTO invoice VALUES($1,'INV-1','AUTHORISED',800)", [TENANT]);
    const before = async () => (await db.query('SELECT to_jsonb(h) r FROM historical_member_invoice h ORDER BY id')).rows;
    const initial = await before();
    const preview = await importStatuses(db, f.inputs, f.originals);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.summary.verifiedPreExistingOverlaps, 1);
    assert.deepEqual(await before(), initial);
    await assert.rejects(importStatuses(db, f.inputs, f.originals, { apply: true }), /plan hash/);
    await assert.rejects(importStatuses(db, f.inputs, f.originals, { apply: true, expectedPlan: preview.planHash,
      beforeImages: () => { throw Error('disk failure'); } }), /disk failure/);
    assert.deepEqual(await before(), initial);
    await db.query(`CREATE FUNCTION suppress_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF OLD.invoice_number='INV-1' THEN RETURN NULL; END IF; RETURN NEW; END;$$;
      CREATE TRIGGER suppress_update BEFORE UPDATE ON historical_member_invoice FOR EACH ROW EXECUTE FUNCTION suppress_update();`);
    await assert.rejects(importStatuses(db, f.inputs, f.originals, { apply: true, expectedPlan: preview.planHash,
      beforeImages: () => {} }), /identity or status change/);
    assert.deepEqual(await before(), initial);
    await db.query('DROP TRIGGER suppress_update ON historical_member_invoice');
    f.inputs[0].rows.push({ ...f.inputs[0].rows[0], source_row: 5, invoice_number: 'NEW', source_key: 'invoice:NEW' });
    const withNew = await importStatuses(db, f.inputs, f.originals);
    await db.query(`CREATE FUNCTION reject_new() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.invoice_number='NEW' THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END;$$;
      CREATE TRIGGER reject_new BEFORE INSERT ON historical_member_invoice FOR EACH ROW EXECUTE FUNCTION reject_new();`);
    await assert.rejects(importStatuses(db, f.inputs, f.originals, { apply: true, expectedPlan: withNew.planHash, beforeImages: () => {} }), /injected insert failure/);
    assert.deepEqual(await before(), initial);
    assert.equal((await db.query('SELECT count(*)::int n FROM historical_invoice_import')).rows[0].n, 2);
    await db.query('DROP TRIGGER reject_new ON historical_member_invoice');
    let imageCount = 0;
    const statements = [];
    const trackedDb = { query: (...args) => { statements.push(args[0]); return db.query(...args); } };
    await importStatuses(trackedDb, f.inputs, f.originals, { apply: true, expectedPlan: withNew.planHash, beforeImages: () => { imageCount++; } });
    const writes = statements.filter(sql => /^(UPDATE historical_member_invoice|INSERT INTO historical_member_invoice|INSERT INTO historical_invoice_import_row)/.test(sql));
    assert.equal(writes.length, 3);
    assert.ok(writes.every(sql => sql.includes('jsonb_to_recordset')));
    assert.ok(!statements.some(sql => sql.startsWith('SELECT outcome,detail FROM historical_invoice_import_row')));
    assert.equal(imageCount, 1);
    const after = await before();
    assert.equal(after.length, 3);
    assert.ok(after.every(({ r }) => r.status === 'paid'));
    const replay = await importStatuses(db, f.inputs, f.originals);
    assert.equal(replay.conflicts.length, 0);
    assert.equal(replay.summary.counts.unchanged, 3);
    await importStatuses(db, f.inputs, f.originals, { apply: true, expectedPlan: replay.planHash, beforeImages: () => { throw Error('no-op must not journal'); } });
    assert.deepEqual(await before(), after);
    assert.deepEqual((await db.query('SELECT status,amount_minor FROM invoice ORDER BY invoice_number')).rows,
      [{ status: 'AUTHORISED', amount_minor: '800' }, { status: 'AUTHORISED', amount_minor: '900' }]);
    // The new archive is not part of the original baseline, but metadata drift still blocks it.
    await db.query("UPDATE historical_member_invoice SET description='drift' WHERE invoice_number='NEW'");
    const drift = await importStatuses(db, f.inputs, f.originals);
    assert.ok(drift.conflicts.some(c => c.reason === 'archive_metadata_conflict'));
    await assert.rejects(importStatuses(db, f.inputs, f.originals, { apply: true, expectedPlan: drift.planHash }), /conflicts/);
  } finally {
    await db.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
