import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {connectDestination} from './lib/member-index-destination.mjs';
import {shapePersistedCommitment} from '../api/membership/member-membership.js';
import {getMembershipPricingPresentation} from '../client/src/components/membership/membershipPricingPresentation.js';
import {assessFormMembershipRenewalEvidence} from '../api/_lib/formMembershipRenewalEvidence.js';
const root='generated-artifacts/bnms-returned-membership-review',tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const evidence=JSON.parse(await fs.readFile(`${root}/evidence.json`,'utf8'));
const db=await connectDestination(),results=[];
try{
 await db.query('begin read only');
 const audits=(await db.query('select * from bnms_returned_membership_repair_audit where tenant_id=$1',[tenant])).rows;
 const decisions=(await db.query('select * from bnms_returned_decisions_audit where tenant_id=$1',[tenant])).rows;
 assert.equal(decisions.length,2);
 assert.equal(audits.length,13);
 for(const r of evidence){
  const audit=audits.find(a=>a.member_id===r.id);
  const histories=(await db.query('select to_jsonb(h) row from member_membership_history h where tenant_id=$1 and member_id=$2',[tenant,r.id])).rows.map(r=>r.row);
  assert.equal(histories.length,r.histories.length);
  assert.deepEqual((await db.query('select to_jsonb(m) row from member m where tenant_id=$1 and id=$2',[tenant,r.id])).rows[0].row,r.member);
  for(const table of Object.keys(r.related))
   assert.deepEqual((await db.query(`select to_jsonb(x) row from ${table} x where tenant_id=$1 and member_id=$2 order by id`,[tenant,r.id])).rows.map(r=>r.row),r.related[table]);
  for(const h of histories)assert.deepEqual(h,decisions.find(d=>d.id===h.id)?.after_record
   ||(h.id===audit?.history_id?audit.after_record:r.histories.find(old=>old.id===h.id)));
  if(audit){
   const h=histories.find(h=>h.id===audit.history_id),display=shapePersistedCommitment(h),prices=getMembershipPricingPresentation(h);
   assert(display.structureName&&display.startDate&&display.endDate&&display.renewalDate);
   assert.equal(display.durationMonths,12);
   for(const key of ['agreed','net','gross'])assert.equal(prices[key].amount,h.final_cost);
   const configRows=(await db.query(`select to_jsonb(c) row from membership_tier_config c
     where tenant_id=$1 and structure_scope_type='member' and structure_field_id=$2
       and structure_match_value=$3 and start_mode='immediate' and is_active
       and (effective_from is null or effective_from<=$4::date)
       and (effective_to is null or effective_to>=$4::date)`,
     [tenant,h.commitment_snapshot.config.structure_field_id,h.commitment_snapshot.config.structure_match_value,h.membership_renewal_date])).rows;
   const config=configRows.length===1?configRows[0].row:null;
   const assessment=assessFormMembershipRenewalEvidence({tenantId:tenant,memberId:r.id,histories,agreements:[],successorConfig:config,now:new Date()});
   if(histories.length===1)assert.notEqual(assessment.state,'review_required',JSON.stringify(assessment));
   results.push({name:r.name,id:r.id,status:histories.length>1?'Previous term repaired':'Repaired',invoice:h.accounting_invoice_number,structure:display.structureName,
    start:h.term_start_date,end:h.term_end_date,amount:h.final_cost,renewal:h.membership_renewal_date,
    renewalAssessment:assessment,
    note:!h.accounting_invoice_id?'Imported paid invoice used; Xero document identity remains unresolved.':
      histories.length>1?'Previous-year term repaired. Current term remains 1 October 2026–31 March 2027 at £30.50; approved Trainee renewal policy added (90-day early renewal and 90-day grace), without changing the purchased term.':'Paid annual term reconstructed; no new collection arrangement created.'});
  }else results.push({name:r.name,id:r.id,status:r.note?'Workbook correction applied':'Excluded test record',
    invoice:r.note?'200007749':'',
    note:r.note?'Owner confirmed workbook correction: disputed paid/active membership cancelled and marked unpaid. Former class and original invoice evidence retained; no Xero changes.':'Test record excluded; no change made.'});
 }
 await db.query('rollback');
 await fs.writeFile(`${root}/verified-results.json`,JSON.stringify(results,null,2),{mode:0o600});
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Repair results');
 sheet.addRow(['Member','Outcome','Invoice evidence','Saved structure','Term start','Term end','Next renewal','Agreed GBP','Notes / action needed','Member record']);
 for(const r of results)sheet.addRow([r.name,r.status,r.invoice||'',r.structure||'',r.start||'',r.end||'',r.renewal||'',r.amount??'',r.note,
   {text:'Open member record',hyperlink:`https://bnms.dev.iconn.app/members/${r.id}?tab=membership`}]);
 sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
 sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163B55'}};
 sheet.columns.forEach((c,i)=>c.width=[28,24,20,38,16,16,16,16,70,24][i]);
 sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter='A1:J16';
 sheet.getColumn(8).numFmt='£#,##0.00';
 sheet.eachRow((row,index)=>{row.alignment={wrapText:true,vertical:'top'};if(index>1){row.height=48;
  row.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:results[index-2].status==='Repaired'?'FFE2F0D9':'FFFFF2CC'}};
  if(results[index-2].status!=='Repaired')row.getCell(9).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF2CC'}};
 }});
 const file=`${root}/BNMS-membership-repair-results.xlsx`;await book.xlsx.writeFile(file);await fs.chmod(file,0o600);
 const check=new ExcelJS.Workbook();await check.xlsx.readFile(file);assert.equal(check.getWorksheet(1).rowCount,16);
 console.log(JSON.stringify({verifiedRepairs:13,approvedDecisionsApplied:2,membersNeedingDecision:0,testExcluded:1,renewalAssessments:results.filter(r=>r.renewalAssessment).map(r=>({name:r.name,state:r.renewalAssessment.state,reason:r.renewalAssessment.reason})),file},null,2));
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
