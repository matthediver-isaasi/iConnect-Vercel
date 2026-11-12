#!/usr/bin/env node
import pg from 'pg';
import XLSX from 'xlsx';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const FILE = 'attached_assets/Individuals_update_role_and_class_import_12.11.26_1794470024358.xlsx';
export const SHA = '75e71d6eb6f7820081d52a80d0e355eed779b9a800fc58ed59b08531b9605b9a';
export const check = (ok, message) => { if (!ok) throw new Error(message); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function parseWorkbook(w) {
  check(JSON.stringify(w.SheetNames) === '["Sheet1"]', 'Sheet mismatch');
  const s = w.Sheets.Sheet1;
  check(s['!ref'] === 'A1:C49', 'Dimensions mismatch');
  check(Object.entries(s).every(([k,v]) => k.startsWith('!') || !v.f), 'Formulas forbidden');
  const grid = XLSX.utils.sheet_to_json(s, { header: 1, raw: true, defval: null });
  check(JSON.stringify(grid[0]) === '["member_id","role_name","Member class"]', 'Headers mismatch');
  const ids = grid.slice(1).map(row => {
    check(row.length === 3 && typeof row[0] === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row[0])
      && row[1] === 'Supporter' && row[2] === 'Supporter', 'Malformed source row');
    return row[0];
  });
  check(ids.length === 48 && new Set(ids).size === 48, 'Source count or duplicate mismatch');
  return ids.sort();
}
export function source() {
  const bytes = readFileSync(FILE);
  check(createHash('sha256').update(bytes).digest('hex') === SHA, 'Workbook hash mismatch');
  return parseWorkbook(XLSX.read(bytes, {type:'buffer'}));
}
export async function connect() {
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  check(response.ok, 'CA unavailable');
  const client = new pg.Client({connectionString:target.toString(),
    ssl:{rejectUnauthorized:true, ca:await response.text(), servername:target.hostname}});
  await client.connect();
  return client;
}
export async function snapshot(client, ids) {
  const read = async (sql, args=[]) => (await client.query(sql,args)).rows;
  const json = async (sql,args=[]) => (await read(sql,args)).map(r=>r.data);
  const tenant = await read('SELECT id,name FROM public.tenant WHERE id=$1',[TENANT]);
  check(tenant.length===1 && tenant[0].name==='BNMS','Tenant mismatch');
  const roles = await json('SELECT to_jsonb(r) data FROM public.role r WHERE tenant_id=$1 ORDER BY id',[TENANT]);
  const fields = await json("SELECT to_jsonb(f) data FROM public.preference_field f WHERE tenant_id=$1 AND (name='member_class' OR label='Member class') ORDER BY id",[TENANT]);
  const members = await json('SELECT to_jsonb(m) data FROM public.member m WHERE id=ANY($1::uuid[]) ORDER BY id',[ids]);
  const values = await json('SELECT to_jsonb(v) data FROM public.member_preference_value v WHERE member_id=ANY($1::uuid[]) ORDER BY id',[ids]);
  const secondaryTable = (await read("SELECT to_regclass('public.member_role') relation"))[0].relation;
  const secondary = secondaryTable ? await json('SELECT to_jsonb(r) data FROM public.member_role r WHERE member_id=ANY($1::uuid[]) ORDER BY member_id,role_id',[ids]) : [];
  const triggers = await read(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('member','member_preference_value','member_role')
    AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
  const constraints = await read(`SELECT conrelid::regclass::text relation,pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE conrelid IN ('public.member'::regclass,'public.member_preference_value'::regclass)
    ORDER BY conrelid,conname`);
  const groups = await json('SELECT to_jsonb(g) data FROM public.member_group g WHERE tenant_id=$1 AND automatic_membership_enabled=true ORDER BY id',[TENANT]);
  const dependencies = await read(`SELECT proname,pg_get_functiondef(oid) definition FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`,
  [['invalidate_member_content_source','queue_automatic_memberships_for_source_changes',
    'department_current_set_auth_lock','organisation_login_gate_transaction_lock']]);
  return {tenant,roles,fields,members,values,secondaryTable,secondary,triggers,constraints,groups,dependencies};
}
export function plan(ids, s) {
  check(ids.length===48 && new Set(ids).size===48,'Source count or duplicate mismatch');
  const roles=s.roles.filter(r=>r.name==='Supporter');
  check(roles.length===1,'Missing or duplicate Supporter definition');
  const role=roles[0];
  const safeRole=r=>r && r.tenant_id===TENANT && r.is_admin===false && r.is_tenant_admin===false
    && r.excluded_features?.includes('admin');
  check(safeRole(role) && !role.requires_effective_from_date && role.max_members==null
    && role.max_member_groups==null,'Privileged or constrained target role');
  check(s.fields.length===1,'Missing or duplicate class definition');
  const field=s.fields[0];
  check(field.tenant_id===TENANT && field.name==='member_class' && field.entity_scope==='member'
    && field.is_active===true && field.field_type==='dropdown' && field.custom_object_id==null
    && field.options?.filter(o=>o.value==='Supporter' && o.label==='Supporter').length===1,
  'Class definition or option mismatch');
  // This live schema has no secondary assignment table; fail closed if that changes.
  check(s.secondaryTable===null && s.secondary.length===0,'Secondary assignment schema requires review');
  check(s.constraints.some(c=>c.relation==='member_preference_value'
    && c.definition==='UNIQUE (member_id, field_id)'),'Missing preference uniqueness');
  check(s.members.length===48 && new Set(s.members.map(m=>m.id)).size===48,'Missing or duplicate member');
  for(const g of s.groups) {
    check(Array.isArray(g.automatic_membership_filter_groups),'Malformed group definition');
    for(const f of g.automatic_membership_filter_groups) {
      check(Array.isArray(f.conditions),'Malformed group conditions');
      check(!f.conditions.some(c=>c.entity_scope==='member' && ['role_id',field.id].includes(c.field_key)),
        'Automatic group side effects require review');
    }
  }
  const items=ids.map(id=>{
    const m=s.members.find(m=>m.id===id);
    check(m && m.tenant_id===TENANT,'Missing or cross-tenant member');
    check(!/^deleted_.+@deleted[.]local$/.test(m.email??'') && !m.deleted_at && !m.is_deleted
      && !['deleted','anonymized'].includes(m.status),'Deleted member');
    check(m.role_id==null || safeRole(s.roles.find(r=>r.id===m.role_id)),'Privileged or foreign prior role');
    check(m.role_effective_from==null,'Effective-dated prior role requires review');
    const values=s.values.filter(v=>v.member_id===id && v.field_id===field.id);
    check(values.length<=1,'Duplicate class values');
    return {id,beforeMember:m,beforeClass:values[0]??null,roleChange:m.role_id!==role.id,
      classAction:values.length ? values[0].value==='Supporter' ? 'none':'update':'insert',
      desiredRole:role.id,desiredClass:'Supporter'};
  });
  const updated=items.filter(i=>i.roleChange || i.classAction!=='none').length;
  return {items,roleId:role.id,fieldId:field.id,summary:{total:48,updated,alreadyCorrect:48-updated,
    blocked:0,roleUpdates:items.filter(i=>i.roleChange).length,
    classUpdates:items.filter(i=>i.classAction==='update').length,
    classInserts:items.filter(i=>i.classAction==='insert').length}};
}
export function verifyDigest(expected, state) {
  check(expected===digest(state),'Reviewed snapshot changed');
}
const omit=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
export function verifyAfter(before, after, p) {
  check(digest(omit(before,['members','values']))===digest(omit(after,['members','values'])),
    'Definitions, secondary assignments or automatic groups changed');
  check(after.members.length===48,'Post-update member count mismatch');
  for(const i of p.items) {
    const m=after.members.find(m=>m.id===i.id);
    const changes=Number(i.roleChange)+Number(i.classAction!=='none');
    check(m && m.role_id===p.roleId,'Role verification mismatch');
    check(digest(omit(m,['role_id','updated_at','survey_invitation_revision']))
      ===digest(omit(i.beforeMember,['role_id','updated_at','survey_invitation_revision'])),
    'Unrelated member data changed');
    check(BigInt(m.survey_invitation_revision)===BigInt(i.beforeMember.survey_invitation_revision)+BigInt(changes),
      'Unexpected survey revision change');
    if(!changes) check(digest(m)===digest(i.beforeMember),'Already-correct member changed');
    const v=after.values.filter(v=>v.member_id===i.id && v.field_id===p.fieldId);
    check(v.length===1 && v[0].value==='Supporter','Class verification mismatch');
    if(i.beforeClass) check(digest(omit(v[0],['value']))===digest(omit(i.beforeClass,['value'])),
      'Unrelated class metadata changed');
  }
  const unrelated=s=>s.values.filter(v=>v.field_id!==p.fieldId);
  check(digest(unrelated(before))===digest(unrelated(after)),'Unrelated preferences changed');
  check(plan(p.items.map(i=>i.id),after).summary.updated===0,'Replay proposes writes');
}
export async function unaffected(client,ids) {
  const result=await client.query(`SELECT
    (SELECT md5(COALESCE(string_agg(to_jsonb(m)::text,',' ORDER BY id),'')) FROM public.member m
      WHERE NOT(id=ANY($1::uuid[]))) members,
    (SELECT md5(COALESCE(string_agg(to_jsonb(v)::text,',' ORDER BY id),'')) FROM public.member_preference_value v
      WHERE NOT(member_id=ANY($1::uuid[]))) preferences`,[ids]);
  return result.rows[0];
}
export async function applyChanges(client,p) {
  const roleRows=p.items.filter(i=>i.roleChange);
  if(roleRows.length) {
    const result=await client.query(`UPDATE public.member m SET role_id=$1
      FROM jsonb_to_recordset($2::jsonb) old(id uuid,role_id uuid)
      WHERE m.id=old.id AND m.tenant_id=$3 AND m.role_id IS NOT DISTINCT FROM old.role_id
      AND m.role_id IS DISTINCT FROM $1 RETURNING m.id`,
    [p.roleId,JSON.stringify(roleRows.map(i=>({id:i.id,role_id:i.beforeMember.role_id}))),TENANT]);
    check(result.rowCount===roleRows.length,'Conditional role write count mismatch');
  }
  const updates=p.items.filter(i=>i.classAction==='update');
  if(updates.length) {
    const result=await client.query(`UPDATE public.member_preference_value v SET value='Supporter'
      FROM jsonb_to_recordset($1::jsonb) old(id uuid,member_id uuid,value text)
      WHERE v.id=old.id AND v.member_id=old.member_id AND v.field_id=$2
      AND v.value IS NOT DISTINCT FROM old.value AND EXISTS (
        SELECT 1 FROM public.member m WHERE m.id=v.member_id AND m.tenant_id=$3)
      RETURNING v.id`,[JSON.stringify(updates.map(i=>i.beforeClass)),p.fieldId,TENANT]);
    check(result.rowCount===updates.length,'Conditional class write count mismatch');
  }
  const inserts=p.items.filter(i=>i.classAction==='insert');
  if(inserts.length) {
    const result=await client.query(`INSERT INTO public.member_preference_value(member_id,field_id,value)
      SELECT m.id,$1,'Supporter' FROM public.member m WHERE m.id=ANY($2::uuid[]) AND m.tenant_id=$3
      AND NOT EXISTS(SELECT 1 FROM public.member_preference_value v WHERE v.member_id=m.id AND v.field_id=$1)
      RETURNING id`,[p.fieldId,inserts.map(i=>i.id),TENANT]);
    check(result.rowCount===inserts.length,'Conditional insert count mismatch');
  }
}
export function save(name, value) {
  const dir = 'private/bnms-supporter-update';
  mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
}
export async function main(args=process.argv.slice(2)) {
  check(args.every(a=>a==='--apply' || a==='--approve-metadata-effects' || /^--review-sha256=[a-f0-9]{64}$/.test(a))
    && new Set(args).size===args.length,'Invalid arguments');
  const apply=args.includes('--apply');
  check(!apply || (args.includes('--approve-metadata-effects')
    && args.filter(a=>a.startsWith('--review-sha256=')).length===1),'Apply requires reviewed digest and metadata approval');
  const ids=source(), client=await connect();
  const run=Date.now();
  let committed=false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE ${apply?'':'READ ONLY'}`);
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    if(apply) {
      check((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only==='off',
        'Connection is read-only; settings will not be overridden');
      // Prevent new matching definitions or group rules while this bounded transaction runs.
      await client.query('LOCK TABLE public.role,public.preference_field,public.member_group IN SHARE ROW EXCLUSIVE MODE');
      await client.query('SELECT id FROM public.tenant WHERE id=$1 FOR SHARE',[TENANT]);
      await client.query('SELECT id FROM public.member WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
      await client.query('SELECT id FROM public.member_preference_value WHERE member_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
    }
    const state=await snapshot(client,ids);
    const p=plan(ids,state), review={sourceSha256:SHA,ids,state}, planSha256=digest(review);
    const summary={...p.summary,project:'lvmzliemqnieeoruhkik',tenant:TENANT,planSha256};
    save(`before-${run}`,{review,plan:p,summary});
    if(!apply) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({...summary,dryRun:true,writes:0}));
      return;
    }
    verifyDigest(args.find(a=>a.startsWith('--review-sha256=')).split('=')[1],review);
    const protectedBefore=await unaffected(client,ids);
    await applyChanges(client,p);
    const after=await snapshot(client,ids);
    verifyAfter(state,after,p);
    check(digest(protectedBefore)===digest(await unaffected(client,ids)),'Out-of-cohort data changed');
    save(`after-in-transaction-${run}`,{after,protectedBefore,summary});
    await client.query('COMMIT');
    committed=true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const persisted=await snapshot(client,ids);
    verifyAfter(state,persisted,p);
    await client.query('ROLLBACK');
    const result={...summary,committed:true,replayWrites:0,protectedDataUnchanged:true};
    save(`result-${run}`,{result,persisted});
    console.log(JSON.stringify(result));
  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    save(`failure-${run}`,{committed,code:e.code??null,message:e.code?'Database operation failed':e.message});
    throw e;
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.code ? `Database failure (${e.code}); no credentials logged` : e.message);process.exitCode=1;});
