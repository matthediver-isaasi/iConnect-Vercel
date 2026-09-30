#!/usr/bin/env node
// Pinned one-off correction. Dry run by default; no inserts or importer calls.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import XLSX from 'xlsx';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const FIELD = '2f04cda8-33f9-4df4-bcd5-e7150e4ca9ae';
export const HASH = '811de006424954fa68809d1bcd6f87f8e7975c7efa9f98e3c0a08592dc8206db';
const FILE = new URL('../attached_assets/US_dates_to_change_1789906416468.xlsx', import.meta.url);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function convert(value) {
  const match = typeof value === 'string' && /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(value);
  assert(match, 'Expected a US m/d/yy string');
  const [, m, d, y] = match;
  const year = 2000 + Number(y);
  const date = new Date(Date.UTC(year, +m - 1, +d));
  assert(year >= 2024 && year <= 2027 && date.getUTCFullYear() === year
    && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d, 'Invalid calendar date or year');
  return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${year}`;
}

export function parseGrid(grid, count = 227) {
  assert(JSON.stringify(grid[0]) === JSON.stringify(['member_id', 'YM Date Membership Expires']), 'Header mismatch');
  const seen = new Set();
  const rows = grid.slice(1).map((r, i) => {
    assert(r.length === 2 && typeof r[0] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r[0]), `Invalid row ${i + 2}`);
    const member_id = r[0].toLowerCase();
    assert(!seen.has(member_id), 'Duplicate member ID');
    seen.add(member_id);
    return { member_id, source: r[1], desired: convert(r[1]), sourceRow: i + 2 };
  });
  assert(rows.length === count, 'Row count mismatch');
  return rows;
}

export function readSource() {
  const bytes = readFileSync(FILE);
  assert(createHash('sha256').update(bytes).digest('hex') === HASH, 'Workbook hash mismatch');
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false });
  assert(JSON.stringify(workbook.SheetNames) === '["Sheet1"]', 'Sheet mismatch');
  return parseGrid(XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1, raw: true, defval: '', blankrows: false }));
}

export function makePlan(source, members, values) {
  return source.map(row => {
    const member = members.find(m => m.id === row.member_id);
    assert(member?.tenant_id === TENANT, `Missing or cross-tenant member at row ${row.sourceRow}`);
    const matches = values.filter(v => v.member_id === row.member_id && v.field_id === FIELD);
    assert(matches.length <= 1, 'Duplicate preference rows');
    const before = matches[0];
    const action = !before ? 'blocked-missing' : before.value === row.desired ? 'unchanged'
      : before.value === row.source ? 'update' : 'blocked-conflict';
    return { ...row, before, action };
  });
}
export const counts = plan => ({
  updated: plan.filter(r => r.action === 'update').length,
  unchanged: plan.filter(r => r.action === 'unchanged').length,
  blocked: plan.filter(r => r.action.startsWith('blocked')).length,
});

export async function applyUpdates(client, plan) {
  const updates = plan.filter(r => r.action === 'update');
  if (!updates.length) return 0;
  const result = await client.query(`
    UPDATE public.member_preference_value v SET value = input.desired
    FROM jsonb_to_recordset($1::jsonb) AS input(member_id uuid, desired text, before jsonb)
    WHERE v.id = (input.before->>'id')::uuid AND v.member_id = input.member_id
      AND v.field_id = $2::uuid AND to_jsonb(v) = input.before
      AND EXISTS (SELECT 1 FROM public.member m WHERE m.id = v.member_id AND m.tenant_id = $3::uuid)
    RETURNING v.member_id, v.value`, [JSON.stringify(updates), FIELD, TENANT]);
  assert(result.rowCount === updates.length && updates.every(u => result.rows.some(r =>
    r.member_id === u.member_id && r.value === u.desired)), 'Concurrent edit or affected-row mismatch; transaction must roll back');
  return result.rowCount;
}

async function load(client, ids) {
  const members = (await client.query(`SELECT to_jsonb(m) - 'updated_at' AS data FROM public.member m WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows.map(r => r.data);
  // Preserve PostgreSQL timestamp precision and representation for whole-row CAS.
  const values = (await client.query('SELECT to_jsonb(v) AS data FROM public.member_preference_value v WHERE member_id = ANY($1::uuid[]) ORDER BY id', [ids])).rows.map(r => r.data);
  return { members, values };
}

async function audit(client) {
  const tenant = (await client.query('SELECT name FROM public.tenant WHERE id=$1', [TENANT])).rows[0];
  assert(/\bbnms\b|british nuclear medicine society/i.test(tenant?.name || ''), 'Tenant identity mismatch');
  const fields = (await client.query(`SELECT * FROM public.preference_field WHERE id=$1 OR
    (tenant_id=$2 AND entity_scope='member' AND (name='ym_date_membership_expires' OR label='YM Date Membership Expires'))`, [FIELD, TENANT])).rows;
  const f = fields[0];
  assert(fields.length === 1 && f.id === FIELD && f.tenant_id === TENANT && f.entity_scope === 'member'
    && f.name === 'ym_date_membership_expires' && f.label === 'YM Date Membership Expires'
    && f.field_type === 'text' && f.is_active === true && f.options == null, 'Live field contract mismatch');
  const col = (await client.query(`SELECT data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='member_preference_value' AND column_name='value'`)).rows;
  assert(col.length === 1 && col[0].data_type === 'text', 'Storage contract mismatch');
  return f;
}

export async function main(args = process.argv.slice(2)) {
  assert(args.every(a => a === '--apply' || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Unsupported arguments');
  const apply = args.includes('--apply');
  const source = readSource();
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'CA download failed');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  const directory = path.join(homedir(), '.private-recovery', 'bnms-expiry', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name, data) => writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await client.connect();
  try {
    await client.query(apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    const field = await audit(client);
    const ids = source.map(r => r.member_id);
    if (apply) {
      await client.query('SELECT id FROM public.preference_field WHERE id=$1 FOR SHARE', [FIELD]);
      await client.query('SELECT id FROM public.member WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
      await client.query('SELECT id FROM public.member_preference_value WHERE member_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    }
    const before = await load(client, ids);
    const plan = makePlan(source, before.members, before.values);
    const review = digest(plan);
    save('before.json', { workbook: HASH, target: 'production DEST lvmzliemqnieeoruhkik', field, plan });
    const summary = { mode: apply ? 'apply' : 'dry-run', ...counts(plan), review, evidence: directory };
    console.log(JSON.stringify(summary));
    if (apply) {
      assert(args.includes(`--review-sha256=${review}`), 'Reviewed plan changed or missing hash');
      const writes = await applyUpdates(client, plan);
      const after = await load(client, ids);
      assert(digest(before.members) === digest(after.members), 'Core member data changed');
      const updatedIds = new Set(plan.filter(r => r.action === 'update').map(r => r.before.id));
      const expected = before.values.map(v => updatedIds.has(v.id) ? { ...v, value: plan.find(r => r.before?.id === v.id).desired } : v);
      assert(digest(expected) === digest(after.values), 'Unrelated preference data changed');
      const replay = makePlan(source, after.members, after.values);
      assert(counts(replay).updated === 0, 'Replay is not a no-op');
      save('after-before-commit.json', { values: after.values.filter(v => v.field_id === FIELD), replay, writes, coreAndOtherPreferencesUnchanged: true });
      await client.query('COMMIT');
      const persisted = await load(client, ids);
      const finalPlan = makePlan(source, persisted.members, persisted.values);
      assert(counts(finalPlan).updated === 0 && counts(finalPlan).unchanged === counts(replay).unchanged, 'Persisted verification failed');
      save('committed.json', { writes, verified: counts(finalPlan), targetValues: persisted.values.filter(v => v.field_id === FIELD), timestamp: new Date().toISOString() });
      console.log(JSON.stringify({ committed: true, writes, verified: counts(finalPlan), replayWrites: 0 }));
    } else await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}