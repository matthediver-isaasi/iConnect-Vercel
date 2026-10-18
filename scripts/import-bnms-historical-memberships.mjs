#!/usr/bin/env node
// Archive-only import. Defaults to a fully validated transaction that rolls back.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { connectDestination } from './lib/member-index-destination.mjs';
import { validateCustomObjectRecordData } from '../api/_lib/customObjectDomain.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const KEY = 'historical_membership';
const FILE = 'attached_assets/updated_YM_membership_history_17.10.26_1792332864575.xlsx';
const SHA = 'eb6939e0e1d88357a54a988d9238f49ac1fb706d62643f8b61ea8f9d6560dc8c';
const ACTOR = 'system:bnms-historical-membership-import';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => {
  const h = hash(`${TENANT}:${KEY}:${value}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
export const OBJECT = id('object');
const RELATION = id('relationship');
const columns = [
  ['website_id', 'Original website ID', 'text', true],
  ['membership', 'Historical membership', 'text', true],
  ['start_date', 'Start date', 'date', true],
  ['end_date', 'End date', 'date', false],
];
const fields = columns.map(([name,label,field_type,is_required], display_order) => ({
  id: id(`field:${name}`), tenant_id: TENANT, custom_object_id: OBJECT,
  entity_scope: 'custom_object', name, label, field_type, is_required,
  is_active: true, display_order, public_access: false,
}));
export function planRows(rows) {
  const unique = new Map();
  const date = value => {
    if (value === null || value === undefined) return null;
    assert.ok(value instanceof Date && Number.isFinite(value.getTime()), 'Invalid source date');
    assert.equal(value.toISOString().slice(10), 'T00:00:00.000Z', 'Unexpected source time');
    return value.toISOString().slice(0,10);
  };
  for (const row of rows) {
    assert.equal(row.length, 5);
    const [website, membership, start, end, member] = row;
    assert.match(member, /^[0-9a-f-]{36}$/i);
    assert.ok(typeof website === 'number' || typeof website === 'string');
    assert.ok(typeof membership === 'string' && membership.length > 0);
    const data = { website_id: String(website), membership, start_date: date(start), end_date: date(end) };
    const validation = validateCustomObjectRecordData({data, fields});
    assert.ok(validation.ok, JSON.stringify(validation.errors));
    // Deduplicate only identical full source rows; no trim/case/date corrections.
    const identity = JSON.stringify(row);
    unique.set(identity, {id: id(identity), data, member});
  }
  return [...unique.values()];
}
export function readPlan() {
  const bytes = readFileSync(FILE);
  assert.equal(hash(bytes), SHA, 'Source workbook changed');
  const workbook = XLSX.read(bytes, {type:'buffer',cellDates:true});
  assert.deepEqual(workbook.SheetNames, ['Export_281DE3018486BA0D16E34301', 'Sheet1']);
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1).length, 0);
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header:1,defval:null});
  assert.deepEqual(grid.shift(), [
    'Member/Non-Member - Website ID', 'Membership History - Membership',
    'Membership History - Membership Start Date', 'Membership History - Membership End Date', 'iConnect UUID',
  ]);
  assert.equal(grid.length,6812);
  const rows = planRows(grid);
  assert.equal(rows.length,6746);
  assert.equal(new Set(rows.map(r=>r.member)).size,3599);
  return rows;
}
async function insert(client, table, items) {
  if (!items.length) return;
  const keys = Object.keys(items[0]);
  // Internal table/column constants only, no externally supplied SQL identifiers.
  const placeholders = items.map((_,i)=>`(${keys.map((_,j)=>`$${i*keys.length+j+1}`).join(',')})`).join(',');
  await client.query(`insert into public.${table} (${keys.join(',')}) values ${placeholders}`,
    items.flatMap(item=>keys.map(key=>typeof item[key]==='object' && item[key]!==null ? JSON.stringify(item[key]) : item[key])));
}
async function operationalSnapshot(client) {
  const {rows: tables} = await client.query(`select distinct table_name from information_schema.columns
    where table_schema='public' and column_name='tenant_id'
    and (table_name like '%membership%' or table_name like '%workflow%' or table_name like '%payment%'
      or table_name in ('member','invoice','gocardless_subscriptions','stripe_subscriptions'))`);
  const result = {};
  for (const {table_name: table} of tables) {
    assert.match(table,/^[a-z_]+$/);
    result[table] = (await client.query(`select count(*)::int n,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) digest
      from public.${table} t where tenant_id=$1`,[TENANT])).rows[0];
  }
  result.member_preferences = (await client.query(`select count(*)::int n,
    md5(coalesce(string_agg(md5(to_jsonb(v)::text),'' order by md5(to_jsonb(v)::text)),'')) digest
    from member_preference_value v join member m on m.id=v.member_id where m.tenant_id=$1`,[TENANT])).rows[0];
  return result;
}
export async function run(apply = false) {
  const rows = readPlan();
  const c = await connectDestination();
  let inserted = 0;
  try {
    await c.query('begin isolation level repeatable read');
    await c.query("set local statement_timeout='90s'");
    await c.query("set local lock_timeout='8s'");
    await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${TENANT}:${KEY}`]);
    assert.equal((await c.query('select name from tenant where id=$1',[TENANT])).rows[0]?.name,'BNMS');
    const members = [...new Set(rows.map(r=>r.member))];
    assert.equal((await c.query('select id from member where tenant_id=$1 and id=any($2::uuid[]) for key share',[TENANT,members])).rowCount, members.length);
    const before = await operationalSnapshot(c);
    const existing = (await c.query('select * from custom_object_definition where tenant_id=$1 and object_key=$2',[TENANT,KEY])).rows[0];
    if (!existing) {
      await insert(c,'custom_object_definition',[{id:OBJECT,tenant_id:TENANT,object_key:KEY,
        singular_label:'Historical Membership Record',plural_label:'Historical Membership Records',
        description:'Original membership archive only. These records do not determine current membership, access, renewals or payments.',
        icon:'History',status:'draft',created_by:ACTOR}]);
      await insert(c,'preference_field',fields.map(f=>({...f,created_by:ACTOR,
        show_in_my_preferences:false,show_in_member_directory:false,show_in_my_organisation:false,
        show_in_directory_card:false,show_in_member_admin_list:false})));
      await c.query(`update custom_object_definition set status='active',primary_display_field_id=$2,
        configuration=$3 where id=$1`,[OBJECT,id('field:membership'),JSON.stringify({
          views:{list:{field_ids:fields.map(f=>f.id)},detail:{sections:[{title:'Historical membership',field_ids:fields.map(f=>f.id)}]}}
        })]);
      await insert(c,'custom_object_relationship_definition',[{
        id:RELATION,tenant_id:TENANT,relationship_key:'historical_membership_member',
        source_kind:'custom_object',source_custom_object_id:OBJECT,target_kind:'member',
        cardinality:'many_to_one',source_label:'Member',target_label:'Historical Membership Records',
        is_required:true,show_on_source:true,show_on_target:true,edit_from_source:false,edit_from_target:false,
        status:'active',created_by:ACTOR,
      }]);
      for(let offset=0;offset<rows.length;offset+=200) {
        const batch=rows.slice(offset,offset+200);
        await insert(c,'custom_object_record',batch.map(r=>({id:r.id,tenant_id:TENANT,custom_object_id:OBJECT,data:r.data,created_by:ACTOR})));
        await insert(c,'custom_object_relationship',batch.map(r=>({id:id(`edge:${r.id}`),tenant_id:TENANT,
          relationship_definition_id:RELATION,source_record_id:r.id,target_record_id:r.member,created_by:ACTOR})));
        inserted+=batch.length;
      }
    } else {
      assert.equal(existing.id,OBJECT,'Existing object is not owned by this import');
      assert.equal(existing.status,'active');
    }
    const stored = (await c.query(`select r.id,r.data,r.archived_at,e.target_record_id,e.archived_at edge_archived
      from custom_object_record r left join custom_object_relationship e
      on e.source_record_id=r.id and e.relationship_definition_id=$3 and e.tenant_id=r.tenant_id
      where r.tenant_id=$1 and r.custom_object_id=$2`,[TENANT,OBJECT,RELATION])).rows;
    assert.equal(stored.length,rows.length);
    const expected = new Map(rows.map(r=>[r.id,r]));
    for(const row of stored) {
      assert.deepEqual(row.data,expected.get(row.id)?.data);
      assert.equal(row.target_record_id,expected.get(row.id)?.member);
      assert.equal(row.archived_at,null); assert.equal(row.edge_archived,null);
    }
    assert.equal((await c.query('select count(*)::int n from custom_object_role_permission where custom_object_id=$1',[OBJECT])).rows[0].n,0,'Archive must remain admin-only');
    assert.deepEqual(await operationalSnapshot(c),before,'Operational membership data changed');
    await c.query('set constraints all immediate');
    await c.query(apply?'commit':'rollback');
    console.log(JSON.stringify({mode:apply?'committed':'dry-run rolled back',records:rows.length,
      exactDuplicatesRemoved:66,members:members.length,inserted,operationalTablesUnchanged:Object.keys(before).length,objectId:OBJECT}));
  } catch(error) {
    await c.query('rollback'); throw error;
  } finally {await c.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.includes('--apply') && !process.argv.includes('--confirm-bnms-archive')) throw new Error('Apply requires --confirm-bnms-archive');
  await run(process.argv.includes('--apply'));
}
