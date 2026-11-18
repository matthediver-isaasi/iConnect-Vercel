import assert from 'node:assert/strict';
import { TENANT, COMPANY, hash, excluded, keys, pick, blank } from './lib/bnms-member-invoice-audit.mjs';

export async function snapshot(db) {
  const q = async (s,p=[]) => (await db.query(s,p)).rows;
  const tenant = (await q('select id,name,slug from tenant where id=$1',[TENANT]))[0];
  assert.equal(tenant?.name,'BNMS'); assert.equal(tenant.slug,'bnms');
  const roles = await q('select * from role where tenant_id=$1 order by id',[TENANT]);
  const guests = roles.filter(r => r.name === 'CPD Guest');
  assert.equal(guests.length,1,'Guest role missing or ambiguous');
  const relations = await q(`select table_name,column_name from information_schema.columns
    where table_schema='public' and (table_name in ('member','member_role','member_roles','member_secondary_role')
    or (column_name='member_id' and table_name ilike '%role%')) order by table_name,column_name`);
  const secondaryTables = [...new Set(relations.filter(r => ['member_role','member_roles','member_secondary_role'].includes(r.table_name)).map(r=>r.table_name))];
  assert.ok(secondaryTables.every(t=>t==='member_role'),'Unsupported secondary-role schema requires review');
  const secondary = secondaryTables.length ? await q(`select mr.* from member_role mr join member m on m.id=mr.member_id
    where m.tenant_id=$1 order by mr.member_id,mr.role_id`,[TENANT]) : [];
  // No active-only predicate. Direct ownership wins; include inherited tenancy in audit, never in writes.
  const predicate = 'coalesce(m.tenant_id,o.tenant_id)=$1';
  const total = +(await q(`select count(*) total from member m left join organization o on o.id=m.organization_id where ${predicate}`,[TENANT]))[0].total;
  const members = [], pagination = [];
  let cursor = null;
  for (;;) {
    const page = await q(`select to_jsonb(m) data from member m left join organization o on o.id=m.organization_id
      where ${predicate} and ($2::uuid is null or m.id>$2::uuid) order by m.id limit 500`,[TENANT,cursor]);
    members.push(...page.map(r=>r.data)); pagination.push(page.length);
    if (!page.length) break;
    cursor=members.at(-1).id;
  }
  assert.equal(members.length,total); assert.equal(new Set(members.map(m=>m.id)).size,total);
  const addresses = await q('select * from invoicing_address_private where tenant_id=$1 order by owner_type,owner_id',[TENANT]);
  const links = [];
  for (const table of ['bnms_dd_alpha_invoice_link','bnms_dd_beta_invoice_link']) {
    const exists=(await q('select to_regclass($1) relation',[`public.${table}`]))[0].relation;
    if (exists) links.push(...await q(`select tenant_id,member_id,xero_tenant_id,xero_contact_id,evidence from ${table} where tenant_id=$1 order by member_id,xero_contact_id`,[TENANT]));
  }
  const connection = await q('select id,tenant_id,tenant_name from xero_token where app_tenant_id=$1',[TENANT]);
  assert.equal(connection.length,1); assert.equal(connection[0].tenant_id,COMPANY);
  const integration = await q("select is_enabled from tenant_integrations where tenant_id=$1 and integration_type='xero'",[TENANT]);
  assert.equal(integration.length,1); assert.equal(integration[0].is_enabled,true);
  return {tenant,guestRole:guests[0],roles,secondary,relations,total,members,pagination,addresses,links,
    connection:connection[0],capturedAt:new Date().toISOString(),
    excludedCount:members.filter(m=>excluded(m,guests[0].id,secondary)).length};
}

export const emptyUpsertSQL = `insert into public.invoicing_address_private as target
  (tenant_id,owner_type,owner_id,${keys.join(',')})
  select $1,'member',$2,${keys.map((_,i)=>`$${i+3}::text`).join(',')}
  where exists(select 1 from public.member where id=$2 and tenant_id=$1 and role_id is distinct from $9::uuid)
  on conflict(tenant_id,owner_type,owner_id) do update set ${keys.map(k=>`${k}=excluded.${k}`).join(',')}
  where ${keys.map(k=>`(target.${k} is null or target.${k} ~ '^[[:space:]]*$')`).join(' and ')}
  returning *`;

export async function writeCandidate(db,row,fresh,saved) {
  const m = fresh.members.find(m=>m.id===row.member.id);
  if (!m || m.tenant_id!==TENANT || excluded(m,fresh.guestRole.id,fresh.secondary) || hash(m)!==hash(row.member)) {
    return {id:row.member.id,outcome:'skipped eligibility/identity changed'};
  }
  const target=fresh.addresses.find(a=>a.owner_type==='member'&&a.owner_id===m.id);
  if (!blank(target) || hash(pick(target))!==hash(row.before)) return {id:m.id,outcome:'skipped target changed'};
  assert.ok(saved?.candidate && hash(saved.contact)===hash(row.contact) && hash(saved.proposed)===hash(row.proposed),'Fresh source changed');
  const result = await db.query(emptyUpsertSQL,[TENANT,m.id,...keys.map(k=>row.proposed[k]),fresh.guestRole.id]);
  assert.equal(result.rowCount,1,'Atomic empty-only address guard rejected write');
  assert.deepEqual(pick(result.rows[0]),row.proposed,'Write result mismatch');
  return {id:m.id,outcome:'copied',before:target||null,after:result.rows[0],verifiedInTransaction:true,at:new Date().toISOString()};
}
