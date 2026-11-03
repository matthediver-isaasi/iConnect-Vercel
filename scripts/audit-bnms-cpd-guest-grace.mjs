// Read-only evidence extraction. No application handlers, jobs or provider calls.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const dir = 'generated-artifacts/bnms-cpd-guest-grace';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const meta = (await db.query("select transaction_timestamp() as timestamp, (transaction_timestamp() at time zone 'UTC')::date::text as today, current_setting('transaction_read_only') as read_only")).rows[0];
  const tenant = (await db.query('select id,name,slug from tenant where id=$1', [tenantId])).rows;
  assert.equal(tenant.length, 1); assert.equal(tenant[0].slug, 'bnms');
  const roles = (await db.query("select to_jsonb(r) as data from role r where tenant_id=$1 and name in ('CPD Guest','Former')", [tenantId])).rows.map(r => r.data);
  assert.equal(roles.length, 2);
  const guest = roles.find(r => r.name === 'CPD Guest');
  assert.ok(guest); assert.ok(roles.find(r => r.name === 'Former'));
  // Direct tenancy takes precedence; include inherited organisation tenancy as
  // used by session membership resolution, flag it separately during evaluation.
  const members = (await db.query(`select to_jsonb(m) as data from member m
    left join organization o on o.id=m.organization_id
    where coalesce(m.tenant_id,o.tenant_id)=$1 and m.role_id=$2 order by m.id`, [tenantId, guest.id])).rows.map(r => r.data);
  const count = +(await db.query(`select count(*) from member m left join organization o on o.id=m.organization_id
    where coalesce(m.tenant_id,o.tenant_id)=$1 and m.role_id=$2`, [tenantId, guest.id])).rows[0].count;
  assert.equal(count, members.length);
  const ids = members.map(m => m.id);
  const tables = {};
  for (const table of ['member_membership_history', 'membership_billing_agreements', 'membership_expiry_policy_assignment']) {
    tables[table] = (await db.query(`select to_jsonb(t) as data from ${table} t where tenant_id=$1 and member_id=any($2::uuid[]) order by id`, [tenantId, ids])).rows.map(r => r.data);
  }
  tables.membership_tier_config = (await db.query('select to_jsonb(t) as data from membership_tier_config t where tenant_id=$1 order by id', [tenantId])).rows.map(r => r.data);
  tables.organisation_membership_history = (await db.query('select to_jsonb(t) as data from organisation_membership_history t where tenant_id=$1 and organization_id=any($2::uuid[]) order by id', [tenantId, members.map(m => m.organization_id).filter(Boolean)])).rows.map(r => r.data);
  const fields = (await db.query(`select id,name from preference_field where tenant_id=$1
    and (name ilike '%expir%' or name ilike '%renew%' or name ilike '%grace%' or name ilike '%membership%' or name='member_class') order by id`, [tenantId])).rows;
  const preferences = (await db.query(`select v.member_id,f.id as field_id,f.name,v.value from member_preference_value v
    join preference_field f on f.id=v.field_id where v.member_id=any($1::uuid[])
    and f.id=any($2::uuid[]) order by v.member_id,f.id`, [ids, fields.map(f => f.id)])).rows;
  const amendmentTables = (await db.query("select table_name from information_schema.columns where table_schema='public' and column_name='member_id' and table_name like '%amendment%' order by table_name")).rows;
  for (const { table_name } of amendmentTables) {
    assert.match(table_name, /^[a-z_]+$/);
    tables[table_name] = (await db.query(`select to_jsonb(t) as data from ${table_name} t where tenant_id=$1 and member_id=any($2::uuid[])`, [tenantId, ids])).rows.map(r => r.data);
  }
  for (const rows of Object.values(tables)) assert.ok(rows.every(r => r.tenant_id === tenantId));
  const evidence = { project: PROJECT, ...meta, tenant: tenant[0], roles, count, members, fields, preferences, tables, writes: 0 };
  await db.query('ROLLBACK');
  fs.writeFileSync(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...meta, count, tables: Object.fromEntries(Object.entries(tables).map(([k,v]) => [k,v.length])), writes: 0 }));
} finally { await db.end(); }
