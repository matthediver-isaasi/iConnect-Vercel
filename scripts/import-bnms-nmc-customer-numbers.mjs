#!/usr/bin/env node
// One-off, hash-pinned BNMS import. Dry-run by default; --apply commits.
// Private input and before-images are excluded from Git and deployment.
import XLSX from 'xlsx';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';

const file = 'attached_assets/BNMS_NMC_UUID_Customer_Number_Import_1792392028632.xlsx';
const hash = '4e6b3d0d0adbb8b57290fb5b4ee8f366402e97531d30229297e51d12740649de';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const field = 'dd82decb-16ac-4141-8f09-b303d66f212d';
const args = process.argv.slice(2);
if (args.length > 1 || args.some(a => !['--apply', '--dry-run'].includes(a))) throw Error('Use --dry-run or --apply');
const apply = args.includes('--apply');
const bytes = readFileSync(file);
if (createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('Input hash mismatch');
const book = XLSX.read(bytes, { type: 'buffer' });
if (book.SheetNames.length !== 1) throw Error('Expected one sheet');
const grid = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: null });
if (JSON.stringify(grid.shift()) !== JSON.stringify(['UUID', 'Customer Number'])) throw Error('Header mismatch');
const rows = grid.map((r, i) => {
  if (r.length !== 2 || typeof r[0] !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r[0])
    || typeof r[1] !== 'string' || !/^\d+$/.test(r[1])) throw Error(`Invalid data at sheet row ${i + 2}`);
  return { member_id: r[0].toLowerCase(), value: r[1] };
});
if (rows.length !== 633 || new Set(rows.map(r => r.member_id)).size !== rows.length) throw Error('Unexpected row count or duplicate UUIDs');
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
  const definition = await db.query(`select f.id from preference_field f join tenant t on t.id=f.tenant_id
    where f.id=$1 and t.id=$2 and t.slug='bnms' and f.name='nmc_customer_number'
    and f.entity_scope='member' and f.field_type='text' and f.is_active and f.custom_object_id is null
    for share of f,t`, [field, tenant]);
  if (definition.rowCount !== 1) throw Error('Tenant/field authority mismatch');
  const members = await db.query('select id from member where tenant_id=$1 and id=any($2::uuid[]) for share',
    [tenant, rows.map(r => r.member_id)]);
  if (members.rowCount !== rows.length) throw Error(`${rows.length - members.rowCount} UUIDs do not match BNMS members; nothing imported`);
  const old = await db.query('select * from member_preference_value where field_id=$1 and member_id=any($2::uuid[]) for update',
    [field, rows.map(r => r.member_id)]);
  const before = new Map(old.rows.map(r => [r.member_id, r]));
  const summary = { total: rows.length, new: 0, changed: 0, unchanged: 0, existingNonblankReplaced: 0 };
  for (const r of rows) {
    const prev = before.get(r.member_id);
    if (!prev) summary.new++;
    else if (prev.value === r.value) summary.unchanged++;
    else { summary.changed++; if (prev.value?.trim()) summary.existingNonblankReplaced++; }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }));
  if (apply && summary.new + summary.changed) {
    const dir = 'private/bnms-nmc-customer-import';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${dir}/before-${Date.now()}.json`,
      JSON.stringify({ sourceHash: hash, tenant, field, before: old.rows, desired: rows }, null, 2),
      { mode: 0o600, flag: 'wx' });
    const written = await db.query(`insert into member_preference_value (member_id,field_id,value)
      select r.member_id,$2::uuid,r.value from jsonb_to_recordset($1::jsonb) as r(member_id uuid,value text)
      join member m on m.id=r.member_id and m.tenant_id=$3
      on conflict(member_id,field_id) do update set value=excluded.value,updated_at=now()
      where member_preference_value.value is distinct from excluded.value`,
    [JSON.stringify(rows), field, tenant]);
    if (written.rowCount !== summary.new + summary.changed) throw Error('Write count mismatch');
  }
  if (apply) {
    const verified = await db.query(`select count(*)::int as matches from jsonb_to_recordset($1::jsonb) as r(member_id uuid,value text)
      join member m on m.id=r.member_id and m.tenant_id=$3
      join member_preference_value v on v.member_id=m.id and v.field_id=$2 and v.value=r.value`,
    [JSON.stringify(rows), field, tenant]);
    if (verified.rows[0].matches !== rows.length) throw Error('Post-import verification failed');
    await db.query('COMMIT');
    console.log(`Committed and verified ${rows.length} exact values in DEST.`);
  } else await db.query('ROLLBACK');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
