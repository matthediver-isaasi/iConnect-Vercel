import fs from 'node:fs';
import {projectNmcReport,NMC_FIELDS,NMC_TENANT} from '../api/_lib/nmcMembershipReport.js';
import {MEMBERSHIP_RECOGNITION_TABLES} from '../api/_lib/alphaMembershipRecognition.js';
import {loadCanvasRenewalEligibility} from '../api/_lib/canvasRenewalEligibility.js';
import {recurringGraceWarning} from '../api/_lib/memberGraceWarning.js';
const dir='generated-artifacts/bnms-current-commitments';
const data=JSON.parse(fs.readFileSync(`${dir}/snapshot.json`));
const today=data.at.slice(0,10);
// Read-only adapter over the captured, consistent database snapshot.
const db={from(table){
  if(!Array.isArray(data[table]))throw Error(`Snapshot table missing: ${table}`);
  let rows=data[table].slice(),one=false;
  const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},
    order(k,{ascending=true}={}){rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k]))*(ascending?1:-1));return q;},
    range(a,b){rows=rows.slice(a,b+1);return q;},limit(n){rows=rows.slice(0,n);return q;},
    maybeSingle(){one=true;return q;},
    then(resolve,reject){return Promise.resolve(one&&rows.length>1?{error:new Error('Ambiguous snapshot rows')}
      :{data:one?rows[0]||null:rows,error:null}).then(resolve,reject);}};
  return q;
}};
const report=projectNmcReport({members:data.member,fields:data.preference_field.filter(f=>f.is_active&&f.entity_scope==='member'&&NMC_FIELDS.includes(f.name)),
  preferences:data.member_preference_value,history:data.member_membership_history,organizations:data.organization,roles:data.role,
  agreements:data.membership_billing_agreements,recognitions:MEMBERSHIP_RECOGNITION_TABLES.flatMap(t=>data[t]),reportDate:today});
const rows=[];
for(const source of data.sources.filter(s=>s.preferences.membership_status==='Active')){
  const m=data.member.find(m=>m.id===source.id),klass=source.preferences.member_class;
  const history=data.member_membership_history.filter(h=>h.member_id===m.id&&!h.organization_id).map(h=>({...h,membership_source:'personal'}));
  let group=null;
  if(m.is_sample||m.is_test||m.deleted_at||m.anonymized_at||m.status==='deleted')group='Excluded test/deleted';
  else if(m.is_guest||['CPD Guest','Department contact'].includes(klass))group='Contact/CPD guest';
  else if(klass==='Former')group='Former class despite Active status';
  else if(klass==='Honorary'&&!history.length&&!source.preferences.ym_date_membership_expires?.trim())group='Honorary non-expiring';
  const r=report.rows.find(r=>r.memberId===m.id);
  let current=r?.cells[12]==='Active',grace=false,graceUnknown=false;
  const agreements=data.membership_billing_agreements.filter(a=>a.member_id===m.id&&!a.organization_id&&a.environment==='live');
  for(const agreement of agreements){
    const plan=data.membership_payment_plans.filter(p=>p.billing_agreement_id===agreement.id&&p.member_id===m.id&&!p.organization_id)
      .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
    const warning=recurringGraceWarning(plan,agreement,Date.parse(data.at));
    if(warning&&!warning.expired&&history.some(h=>h.billing_agreement_id===agreement.id))grace=true;
  }
  if(!current&&!grace)for(const record of history){
    const eligibility=await loadCanvasRenewalEligibility(db,{selected:{record},owner:m,history,today});
    if(eligibility.reason==='eligibility_evidence_unavailable')graceUnknown=true;
    if(eligibility.inGrace)grace=true;
  }
  rows.push({memberId:m.id,memberClass:klass,historyCount:history.length,paused:!!m.membership_paused,
    group:group||(grace?'Grace':current?'Current paid/recognised':'No current paid or confirmed grace'),
    graceUnknown,reportStatus:r?.cells[12]||null,
    lastEnd:history.map(h=>h.term_end_date).filter(Boolean).sort().at(-1)||null,
    legacyExpiry:source.preferences.ym_date_membership_expires||null,ddEvidence:source.dd_evidence});
}
const count=rs=>rs.reduce((o,r)=>(o[r.group]=(o[r.group]||0)+1,o),{});
const missing=rows.filter(r=>r.group==='No current paid or confirmed grace');
const summary={asOf:data.at,activeStatus:rows.length,groups:count(rows),
  missingNoHistory:missing.filter(r=>!r.historyCount).length,missingWithHistory:missing.filter(r=>r.historyCount).length,
  graceUnresolved:missing.filter(r=>r.graceUnknown).length,missingPaused:missing.filter(r=>r.paused).length,
  missingClasses:missing.reduce((o,r)=>(o[r.memberClass]=(o[r.memberClass]||0)+1,o),{}),
  missingHistoryEnds:missing.filter(r=>r.historyCount).map(r=>({end:r.lastEnd,report:r.reportStatus,class:r.memberClass,unknown:r.graceUnknown})),writes:0};
fs.writeFileSync(`${dir}/results.json`,JSON.stringify({summary,rows},null,2),{mode:0o600});
console.log(JSON.stringify(summary));
