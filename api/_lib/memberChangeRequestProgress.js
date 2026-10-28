import {readMemberMonthlyChanges} from './memberMonthlyChangeRead.js';

// Member responses contain outcomes only, never the administrative financial
// evidence, provider identifiers, payer records or accounting credentials.
export async function attachMemberRequestProgress(db,context,records,read=readMemberMonthlyChanges){
 if(!records.some(r=>r.state==='approved'&&r.authorityId))return records;
 let rows;
 try{rows=await read(db,context.tenantId,context.memberId);}
 catch{return records.map(r=>r.state==='approved'?{...r,progress:{state:'unavailable'}}:r);}
 return records.map(record=>{
  if(record.state!=='approved')return record;
  const financial=(rows.financialChanges||[]).find(r=>r.id===record.authorityId);
  const monthly=(rows.monthlyChanges||[]).find(r=>r.id===record.authorityId);
  let state='approved';
  if(financial){
   if(financial.application)state='applied';
   else if(financial.settlement?.state==='settled')state='applying';
   else if(['awaiting_payment','awaiting_refund','awaiting_reconciliation'].includes(financial.settlement?.state)){
    state=financial.settlement.state;
   }else if(financial.execution)state='processing';
  }else if(monthly?.operation){
   const operation=monthly.operation;
   if(operation.state==='finalized'&&operation.evidence?.application)state='applied';
   else if(['uncertain','failed'].includes(operation.state))state='awaiting_reconciliation';
   else state='processing';
  }
  return {...record,progress:{state}};
 });
}
