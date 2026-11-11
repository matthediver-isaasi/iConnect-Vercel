import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './lib/member-index-destination.mjs';
import { buildMemberDateTerm } from '../shared/memberDateMembershipTerm.js';
import { assertMemberDateSchedule } from '../api/_lib/memberDateTermPolicy.js';
import { deriveAnnualTerm, classifyAnnualRenewal } from '../api/_lib/annualRenewalPolicy.js';
import { assessFormMembershipRenewalEvidence } from '../api/_lib/formMembershipRenewalEvidence.js';
import { shapePersistedCommitment } from '../api/membership/member-membership.js';
import { canvasRenewalEligibility } from '../api/_lib/canvasRenewalEligibility.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const ORIGINAL = '57ba60c8-3703-4b2c-83ae-0cf7f0884cf8';
export const FIELD = '462a3258-0808-4edc-bd01-45c7def87af2';
export const FORMS = ['7a173155-7932-4f80-bac3-12644920b9a0',
  '84df23c7-b148-45d7-8b57-c2e194c57ceb', '816a5f51-61bd-4733-a42f-118c5136fa68'];
const root = 'generated-artifacts/bnms-student-reconstruction';
const migrations = ['supabase/migrations/202701220001_member_date_rolling_compatibility.sql',
  'supabase/migrations/202701220002_bnms_student_reconstruction_audit.sql'];
export const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function stableId(key) {
  const h = hash(key); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
export const SUCCESSOR = stableId('bnms-student-course-date-successor');
export function planMember(member, histories, preferences, field, config, today) {
  const result = { memberId: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim(),
    start: member.created_on?.slice(0,10) || null,
    end: preferences.find(p => p.member_id === member.id && p.field_id === FIELD)?.value || null };
  const held = reason => ({ ...result, outcome: 'held', reason });
  if (member.email?.startsWith('deleted_')) return { ...result, outcome:'excluded',reason:'Deleted member' };
  if (member.membership_paused || member.membership_cancelled) return held('Membership paused or cancelled');
  if (!result.start) return held('Member since date missing');
  if (!result.end) return held('Course end date missing');
  let term;
  try { term = buildMemberDateTerm({tenantId:TENANT,memberId:member.id,field,
    value:result.end,startDate:result.start,graceDays:config.renewal_grace_days}); }
  catch(e) { return held(e.message); }
  if (result.start > today) return held('Member since date is in the future');
  const live = histories.filter(h=>h.member_id===member.id);
  if (live.length>1) return held('Multiple historical memberships need review');
  const old=live[0] || null;
  if (old) {
    let notes; try { notes=JSON.parse(old.notes); } catch {}
    if (old.term_key || old.term_source_snapshot || old.commitment_snapshot
      || old.config_id || old.billing_agreement_id || old.membership_payment_quote_id
      || old.stripe_payment_intent_id || old.accounting_invoice_id || old.xero_invoice_id
      || old.membership_successor_election_id || old.payment_status!=='paid'
      || notes?.source!=='bnms_non_dd_current_backfill'
      || ['annual_cost','final_cost','total_with_vat'].some(k=>old[k]!=null)) {
      return held('Existing issued or financial membership retained for review');
    }
  }
  const record = {
    id:old?.id || stableId(`student-course-term:${member.id}`),tenant_id:TENANT,member_id:member.id,
    config_id:config.id, membership_year:`member-date:${term.term_start_date}:${term.term_end_date}`,
    tier_label:config.name,field_value:'Student',currency:config.currency,billing_period:config.billing_period,
    annual_cost:0,final_cost:0,total_with_vat:0,vat_amount:0,vat_rate_percent:0,
    payment_method:'manual',payment_status:'paid',status:term.term_end_date<today?'expired':'active',
    ...term,
    renewal_policy_snapshot:config,
    notes:JSON.stringify({source:'bnms_student_course_date_reconstruction',version:1,
      startAuthority:'owner_approved_member_since',endAuthority:'saved_student_course_end_date',
      pricingAuthority:'no_charge_student_structure',originalHistory:old,
      noChargesCreated:true,noEmailsSent:true}),
  };
  return {...result,outcome:old?'repair':'create',record};
}

async function capture(db) {
  const one=async(sql,args)=> (await db.query(sql,args)).rows.map(r=>r.row);
  const members=await one(`select to_jsonb(m) row from member m join role r on r.id=m.role_id
    where m.tenant_id=$1 and r.tenant_id=$1 and r.name='Student' order by m.id`,[TENANT]);
  const ids=members.map(m=>m.id);
  return {
    members,
    configs:await one(`select to_jsonb(c) row from membership_tier_config c where tenant_id=$1 order by id`,[TENANT]),
    field:(await one('select to_jsonb(f) row from preference_field f where tenant_id=$1 and id=$2',[TENANT,FIELD]))[0],
    preferences:await one('select to_jsonb(p) row from member_preference_value p where member_id=any($1::uuid[]) order by id',[ids]),
    histories:await one(`select to_jsonb(h) row from member_membership_history h where tenant_id=$1
      and (member_id=any($2::uuid[]) or config_id=$3) order by id`,[TENANT,ids,ORIGINAL]),
    agreements:await one(`select to_jsonb(a) row from membership_billing_agreements a
      where tenant_id=$1 and member_id=any($2::uuid[]) order by id`,[TENANT,ids]),
    forms:await one('select to_jsonb(f) row from form f where tenant_id=$1 and id=any($2::uuid[]) order by id',[TENANT,FORMS]),
  };
}
export function buildPlan(before,today) {
  const original=before.configs.find(c=>c.id===ORIGINAL);
  assert(original?.is_active && original.name==='2026-2027 Student');
  assert(!before.configs.some(c=>c.id===SUCCESSOR));
  const successor={...original,id:SUCCESSOR,term_end_mode:'member_date_field',term_end_field_id:FIELD};
  assertMemberDateSchedule(successor);
  assert.equal(before.forms.length,3);
  for(const form of before.forms) {
    assert.equal(form.date_membership_config_id,null);
    assert(!form.fields.some(f=>['payment','membership_payment'].includes(f.type)));
    assert(form.entity_pipelines.members.some(m=>m.mappings.some(x=>x.target_field===FIELD
      && x.source_type==='field' && form.fields.some(f=>f.id===x.source_field_id&&f.type==='date'))));
  }
  const rows=before.members.map(m=> {
    const plan=planMember(m,before.histories,before.preferences,before.field,successor,today);
    if (['create','repair'].includes(plan.outcome) && before.agreements.some(a=>a.member_id===m.id
      && !['cancelled','canceled','completed','expired'].includes(a.status))) {
      return {memberId:m.id,name:plan.name,start:plan.start,end:plan.end,outcome:'held',reason:'Existing payment arrangement'};
    }
    return plan;
  });
  return {today,successor,rows};
}

async function setRecord(db,table,id,patch) {
  assert(['membership_tier_config','member_membership_history','form'].includes(table));
  const keys=Object.keys(patch); assert(keys.every(k=>/^[a-z_]+$/.test(k)));
  const values=keys.map(k=>patch[k]!==null&&typeof patch[k]==='object'?JSON.stringify(patch[k]):patch[k]);
  const result=await db.query(`update ${table} set ${keys.map((k,i)=>`"${k}"=$${i+1}`).join(',')}
    where id=$${keys.length+1} and tenant_id=$${keys.length+2}`,[...values,id,TENANT]);
  assert.equal(result.rowCount,1);
}
async function insertRecord(db,table,record) {
  assert(['membership_tier_config','member_membership_history'].includes(table));
  const keys=Object.keys(record); assert(keys.every(k=>/^[a-z_]+$/.test(k)));
  const cols=keys.map(k=>`"${k}"`).join(',');
  await db.query(`insert into ${table}(${cols}) select ${cols}
    from jsonb_populate_record(null::public.${table},$1::jsonb)`,[JSON.stringify(record)]);
}
async function verify(db,before,plan) {
  const after=await capture(db);
  assert.deepEqual(after.members,before.members,'Member profile changed');
  assert.deepEqual(after.preferences,before.preferences,'Saved fields changed');
  assert.deepEqual(after.agreements,before.agreements,'Payment arrangements changed');
  for(const old of before.configs)assert.deepEqual(after.configs.find(c=>c.id===old.id),
    old.id===ORIGINAL?{...old,is_active:false,name:'2026-2027 Student (legacy annual)'}:old);
  assert.deepEqual(after.configs.find(c=>c.id===SUCCESSOR),plan.successor);
  for(const old of before.forms)assert.deepEqual(after.forms.find(f=>f.id===old.id),
    {...old,date_membership_config_id:SUCCESSOR});
  const changed=new Set(plan.rows.filter(r=>r.record).map(r=>r.record.id));
  for(const old of before.histories)if(!changed.has(old.id))
    assert.deepEqual(after.histories.find(h=>h.id===old.id),old,'Unapproved history changed');
  for(const row of plan.rows.filter(r=>r.record)) {
    const saved=after.histories.find(h=>h.id===row.record.id); assert(saved);
    for(const [key,value] of Object.entries(row.record))assert.deepEqual(saved[key],value,key);
    const term=deriveAnnualTerm(saved,plan.successor);
    assert.equal(term.start.toISOString().slice(0,10),row.start);
    assert.equal(term.end.toISOString().slice(0,10),row.end);
    const renewal=classifyAnnualRenewal({previousRecord:saved,config:plan.successor,now:term.nextStart});
    assert.notEqual(renewal.state,'review_required');
    assert.equal(renewal.eligible,true,JSON.stringify(renewal));
    const formRenewal=assessFormMembershipRenewalEvidence({tenantId:TENANT,memberId:row.memberId,
      histories:[saved],agreements:[],now:term.nextStart,successorConfig:plan.successor});
    assert.equal(formRenewal.state,'eligible_renewal',JSON.stringify(formRenewal));
    const display=shapePersistedCommitment(saved,new Date(plan.today));
    assert.equal(display.structureName,plan.successor.name);
    assert.equal(display.endDate,row.end);
    const portal=canvasRenewalEligibility({record:{...saved,membership_source:'personal'},
      config:plan.successor,history:[],today:term.nextStart.toISOString().slice(0,10)});
    assert.equal(portal.eligible,true,'Portal must offer renewal after course ends');
  }
  return after;
}
async function guardChecks(db,plan) {
  await db.query('set local role service_role');
  const row=plan.rows.find(r=>r.record).record;
  await db.query('update member_membership_history set notes=notes where id=$1',[row.id]);
  for (const sql of [
    'update member_membership_history set final_cost=1 where id=$1',
    'update member_membership_history set term_end_date=term_end_date+1,membership_renewal_date=membership_renewal_date+1 where id=$1',
    'update member_membership_history set term_source_snapshot=null where id=$1',
    'update member_membership_history set renewal_policy_snapshot=null where id=$1',
  ]) {
    await db.query('savepoint guard_test'); let rejected=false;
    try{await db.query(sql,[row.id]);}catch(e) {
      rejected=/Invalid no-charge|immutable|manual extension/.test(e.message);
    }
    await db.query('rollback to savepoint guard_test'); assert(rejected,'Protection failed');
  }
  await db.query('savepoint guard_test');
  let duplicateBlocked=false;
  try{await insertRecord(db,'member_membership_history',{...row,id:stableId('duplicate-student-guard')});}
  catch(e){duplicateBlocked=/overlaps/.test(e.message);}
  await db.query('rollback to savepoint guard_test');assert(duplicateBlocked);
  await db.query('savepoint guard_test');
  let auditBlocked=false;
  try{await db.query('delete from bnms_student_term_reconstruction_audit');}
  catch(e){auditBlocked=e.code==='42501';}
  await db.query('rollback to savepoint guard_test');assert(auditBlocked);
  await db.query('savepoint guard_test');
  let annualBlocked=false;
  try{await db.query('update member_membership_history set final_cost=1 where config_id=$1',[ORIGINAL]);}
  catch(e){annualBlocked=/immutable/.test(e.message);}
  await db.query('rollback to savepoint guard_test');assert(annualBlocked);
  await db.query('reset role');
}
async function main() {
  const mode=process.argv[2]; assert(['inspect','rehearse','apply','verify'].includes(mode));
  await mkdir(root,{recursive:true,mode:0o700});
  const db=await connectDestination();
  try {
    await db.query(mode==='inspect'||mode==='verify'?'begin read only':'begin isolation level serializable');
    await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'");
    if(mode==='verify') {
      const {before,plan}=JSON.parse(await readFile(`${root}/applied.json`,'utf8'));
      await verify(db,before,plan);await db.query('rollback');console.log('Live records verified; no writes');return;
    }
    if(mode!=='inspect') {
      await db.query(`select m.id from member m join role r on r.id=m.role_id
        where m.tenant_id=$1 and r.name='Student' order by m.id for update of m`,[TENANT]);
      await db.query(`select p.id from member_preference_value p join member m on m.id=p.member_id
        join role r on r.id=m.role_id where m.tenant_id=$1 and r.name='Student' for share of p`,[TENANT]);
      await db.query('select id from membership_tier_config where tenant_id=$1 order by id for update',[TENANT]);
      await db.query('select id from form where id=any($1::uuid[]) order by id for update',[FORMS]);
      await db.query(`select h.id from member_membership_history h join member m on m.id=h.member_id
        join role r on r.id=m.role_id where m.tenant_id=$1 and r.name='Student' order by h.id for update of h`,[TENANT]);
    }
    const before=await capture(db);
    const plan=buildPlan(before,new Date().toISOString().slice(0,10));
    const sql=await Promise.all(migrations.map(p=>readFile(p,'utf8')));
    const digest=hash({before,plan,sql});
    if(mode==='apply') {
      const reviewed=JSON.parse(await readFile(`${root}/rehearse.json`,'utf8'));
      assert.equal(digest,reviewed.digest,'Reviewed evidence changed; rehearse again');
    }
    if(mode!=='inspect') {
      for(const text of sql)await db.query(text.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
      for(const row of plan.rows.filter(r=>r.outcome==='repair')) {
        const old=before.histories.find(h=>h.id===row.record.id);
        await db.query(`insert into bnms_student_term_reconstruction_audit
          (history_id,tenant_id,member_id,before_record,after_record) values($1,$2,$3,$4,$5)`,
          [old.id,TENANT,row.memberId,JSON.stringify(old),JSON.stringify({...old,...row.record})]);
      }
      await db.query('set local role service_role');
      await setRecord(db,'membership_tier_config',ORIGINAL,{name:'2026-2027 Student (legacy annual)',is_active:false});
      await insertRecord(db,'membership_tier_config',plan.successor);
      for(const id of FORMS)await setRecord(db,'form',id,{date_membership_config_id:SUCCESSOR});
      for(const row of plan.rows.filter(r=>r.record)) {
        if(row.outcome==='repair')await setRecord(db,'member_membership_history',row.record.id,row.record);
        else await insertRecord(db,'member_membership_history',row.record);
      }
      await db.query('reset role');
      await verify(db,before,plan);
      await guardChecks(db,plan);
    }
    await writeFile(`${root}/${mode==='apply'?'applied':mode}.json`,JSON.stringify({digest,before,plan},null,2),{mode:0o600});
    await db.query(mode==='apply'?'commit':'rollback');
    console.log(JSON.stringify({mode,digest,successor:SUCCESSOR,
      counts:Object.fromEntries(['create','repair','held','excluded'].map(k=>[k,plan.rows.filter(r=>r.outcome===k).length])),
      held:plan.rows.filter(r=>r.outcome==='held')},null,2));
  } catch(e) {await db.query('rollback');throw e;}finally{await db.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main();
