import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
import { keys, mapAddress } from './bnms-address-mapping.mjs';

// Owner-authorized, snapshot-pinned blank-only copy. No generic backfill mode.
const dir = 'private/bnms-address-audit';
const raw = fs.readFileSync(`${dir}/snapshot.json`);
const hash = crypto.createHash('sha256').update(raw).digest('hex');
const s = JSON.parse(raw);
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
assert.equal(s.tenant.id, tenant);
const apply = process.argv[2] === '--apply';
if (process.argv.length > 2 && (!apply || process.argv[3] !== hash || process.argv.length !== 4)) {
  throw new Error('Usage: node scripts/apply-bnms-address-copy.mjs [--apply SNAPSHOT_SHA256]');
}
const fields = keys.map(k => {
  const matches = s.fields.filter(f => f.name === k);
  assert.equal(matches.length, 1);
  const f = matches[0];
  assert.equal(f.tenant_id, tenant);
  assert.equal(f.entity_scope, 'organization');
  assert.equal(f.is_active, true);
  assert.equal(f.field_type, k === 'org_country' ? 'country' : 'text');
  return f;
});
const plan = [], manual = [];
let clear = 0;
for (const o of s.organizations) {
  const existing = Object.fromEntries(fields.map(f => {
    const rows = s.values.filter(v => v.organization_id === o.id && v.field_id === f.id);
    assert.ok(rows.length <= 1, 'Duplicate values');
    return [f.name, rows[0]?.value ?? null];
  }));
  const m = mapAddress(o.invoicing_address, existing, fields[6]);
  if (m.missing || m.ambiguous || m.conflicts.length) {
    manual.push({ id: o.id, name: o.name, ...existing });
    continue;
  }
  clear++;
  for (const f of fields) {
    if (m.proposed[f.name] !== null && !String(existing[f.name] ?? '').trim()) {
      plan.push({ organization_id: o.id, field_id: f.id, value: m.proposed[f.name] });
    }
  }
}
assert.equal(s.organizations.length, 477);
assert.equal(clear, 215);
assert.equal(plan.length, 728);
assert.equal(manual.length, 262);
assert.equal(new Set(manual.map(o => o.id)).size, manual.length);
const csvCell = value => {
  const text = String(value ?? '');
  assert.ok(!/^[\s]*[=+@\t\r]/.test(text), 'Formula-like CSV cell requires safe handling');
  return `"${text.replaceAll('"', '""')}"`;
};
const csv = '\ufeff' + [
  ['Organisation Name', 'Organisation ID', ...fields.map(f => f.label)],
  ...manual.sort((a, b) => a.name.localeCompare(b.name, 'en')).map(o => [o.name, o.id, ...keys.map(k => o[k])]),
].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
console.log(JSON.stringify({ snapshotSha256: hash, clearOrganizations: clear, fieldFills: plan.length, manualOrganizations: manual.length, apply }));
if (!apply) process.exit(0);
const receiptPath = `${dir}/copy-receipt.json`;
if (fs.existsSync(receiptPath)) throw new Error('Receipt already exists; do not apply twice.');
const db = await connectDestination();
const read = async () => ({
  fields: (await db.query("SELECT id,tenant_id,name,label,field_type,options,is_active,entity_scope,to_jsonb(f)->'all_countries' AS all_countries,to_jsonb(f)->'selected_countries' AS selected_countries FROM public.preference_field f WHERE tenant_id=$1 AND entity_scope='organization' ORDER BY id", [tenant])).rows,
  organizations: (await db.query('SELECT id,tenant_id,name,invoicing_address FROM public.organization WHERE tenant_id=$1 ORDER BY id', [tenant])).rows,
  values: (await db.query("SELECT v.id,v.organization_id,v.field_id,v.value FROM public.organization_preference_value v JOIN public.organization o ON o.id=v.organization_id JOIN public.preference_field f ON f.id=v.field_id WHERE o.tenant_id=$1 AND f.tenant_id=$1 AND f.entity_scope='organization' ORDER BY v.id", [tenant])).rows,
});
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query("SET LOCAL statement_timeout='30s'");
  // Brief table locks also prevent insertion into previously absent value pairs.
  await db.query('LOCK TABLE public.organization, public.preference_field, public.organization_preference_value IN SHARE ROW EXCLUSIVE MODE');
  const before = await read();
  assert.deepEqual(before.fields, s.fields, 'Definitions changed since fresh audit');
  assert.deepEqual(before.organizations, s.organizations, 'Organisation/source drift');
  assert.deepEqual(before.values, s.values, 'Value drift; abort without writing');
  fs.writeFileSync(`${dir}/copy-plan.json`, JSON.stringify({ snapshotSha256: hash, plan, before }, null, 2), { mode: 0o600, flag: 'wx' });
  const result = await db.query(`
    INSERT INTO public.organization_preference_value (organization_id,field_id,value)
    SELECT organization_id,field_id,value
    FROM jsonb_to_recordset($1::jsonb) AS p(organization_id uuid,field_id uuid,value text)
    ON CONFLICT (organization_id,field_id) DO UPDATE
      SET value=EXCLUDED.value,updated_at=now()
      WHERE organization_preference_value.value IS NULL OR btrim(organization_preference_value.value)=''
    RETURNING id,organization_id,field_id,value`, [JSON.stringify(plan)]);
  assert.equal(result.rowCount, 728, 'Unexpected write count');
  const after = await read();
  assert.deepEqual(after.fields, before.fields);
  assert.deepEqual(after.organizations, before.organizations, 'Source organisations must not change');
  const pair = v => `${v.organization_id}/${v.field_id}`;
  const planned = new Map(plan.map(v => [pair(v), v.value]));
  const current = new Map(after.values.map(v => [pair(v), v]));
  for (const v of before.values) {
    assert.deepEqual(current.get(pair(v)), planned.has(pair(v)) ? { ...v, value: planned.get(pair(v)) } : v);
  }
  for (const v of plan) assert.equal(current.get(pair(v))?.value, v.value);
  const beforePairs = new Set(before.values.map(pair));
  assert.equal(after.values.length, before.values.length + plan.filter(v => !beforePairs.has(pair(v))).length);
  fs.writeFileSync(`${dir}/copy-precommit.json`, JSON.stringify({ snapshotSha256: hash, changed: result.rows, after, verified: true }, null, 2), { mode: 0o600, flag: 'wx' });
  await db.query('COMMIT');
  // An independent committed read must match the verified transaction state.
  assert.deepEqual(await read(), after, 'Post-commit drift; inspect private journal before any retry');
  fs.writeFileSync(receiptPath, JSON.stringify({ committedAt: new Date().toISOString(), snapshotSha256: hash, organizations: clear, fields: result.rowCount, postCommitVerified: true }, null, 2), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${dir}/organisations-for-manual-address-entry.csv`, csv, { mode: 0o600 });
  console.log('Committed and independently verified: 215 organisations, 728 blank-only fills. CSV: 262 organisations.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await db.end();
}
