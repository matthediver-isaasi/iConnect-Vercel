import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
const input='attached_assets/BNMS-complete-priced-membership-commitments_SB_updated_1794387451905.xlsx';
const w=new ExcelJS.Workbook();await w.xlsx.readFile(input);
const rows=[];w.getWorksheet('Remaining cases').eachRow((r,i)=>{if(i>1)rows.push({name:r.getCell(1).text,id:r.getCell(2).text,note:r.getCell(5).text});});
const t='ff2df806-b321-4254-b651-3af11fccf1db',db=await connectDestination(),result=[];
try{
 await db.query('begin read only');
 for(const row of rows){
  const read=async(table)=> (await db.query(`select to_jsonb(x) row from ${table} x where tenant_id=$1 and member_id=$2 order by id`,[t,row.id])).rows.map(r=>r.row);
  const member=(await db.query('select to_jsonb(m) row from member m where tenant_id=$1 and id=$2',[t,row.id])).rows[0]?.row;
  const prefs=(await db.query("select f.name,v.value from member_preference_value v join preference_field f on f.id=v.field_id where f.tenant_id=$1 and v.member_id=$2 and f.name='member_class'",[t,row.id])).rows;
  const histories=await read('member_membership_history'),invoices=await read('historical_member_invoice');
  const related={};for(const table of ['membership_billing_agreements','membership_payment_plans','membership_payment_quote','membership_successor_election'])related[table]=await read(table);
  result.push({...row,member,prefs,histories,invoices,related});
  console.log(JSON.stringify({name:row.name,note:row.note,cls:prefs,histories:histories.map(h=>({id:h.id,status:h.status,payment:h.payment_status,method:h.payment_method,start:h.term_start_date,end:h.term_end_date,invoice:h.invoice_number||h.accounting_invoice_number,commitment:!!h.commitment_snapshot,policy:!!h.renewal_policy_snapshot,agreement:h.billing_agreement_id,term_key:h.term_key})),invoices:invoices.filter(i=>row.note.includes(i.invoice_number)).map(i=>({number:i.invoice_number,date:i.invoice_date,paid:i.accounting_payment_status,description:i.description})),related:Object.fromEntries(Object.entries(related).map(([k,v])=>[k,v.map(r=>({id:r.id,status:r.status}))]))}));
 }
 await db.query('rollback');await fs.mkdir('generated-artifacts/bnms-returned-membership-review',{recursive:true});
 await fs.writeFile('generated-artifacts/bnms-returned-membership-review/evidence.json',JSON.stringify(result,null,2),{mode:0o600});
}finally{await db.end();}
