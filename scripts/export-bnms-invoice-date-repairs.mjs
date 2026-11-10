import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { TENANT } from './lib/bnms-invoice-date-repair.mjs';
const root = 'generated-artifacts/bnms-invoice-date-repair';
const read = async path => JSON.parse(await fs.readFile(path,'utf8'));
const {plan} = await read(`${root}/plan.json`);
const verified = await read(`${root}/final-verify.json`);
const evidence = await read('generated-artifacts/bnms-all-renewal/evidence.json');
const db = await connectDestination();
let names;
try {
  await db.query('BEGIN READ ONLY');
  names = (await db.query(`select id,first_name,last_name from member where tenant_id=$1 and id=any($2::uuid[])`,
    [TENANT,plan.map(p=>p.memberId)])).rows;
  await db.query('ROLLBACK');
} finally { await db.end(); }
const name = id => { const m=names.find(m=>m.id===id);return m ? `${m.first_name||''} ${m.last_name||''}`.trim() : id; };
const book = new ExcelJS.Workbook();
function sheet(title, headers, rows) {
  const ws=book.addWorksheet(title);
  ws.addRow(headers);
  rows.forEach(row=>ws.addRow(row));
  ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163B55'}};
  ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:{row:1,column:1},to:{row:rows.length+1,column:headers.length}};
  ws.columns.forEach((c,i)=>c.width=i===0?32:48);
  ws.eachRow(r=>r.alignment={vertical:'top',wrapText:true});
  return ws;
}
sheet('Summary',['Measure','Result'],[
 ['Scope','60 non-deleted BNMS renewal blockers reviewed'],
 ['Repaired and independently verified',verified.count],
 ['Renewal blockers before',60],['Renewal blockers after',evidence.summary.uniqueBlockerMembers],
 ['Blocker or risk before',70],['Blocker or risk after',evidence.summary.uniqueActionableMembers],
 ['Deleted members excluded',139],
 ['Current memberships, renewal not open',verified.results.filter(r=>r.renewal.state==='renewal_not_open').length],
 ['Admitted to pricing boundary',verified.results.filter(r=>r.renewal.state==='admitted_to_pricing_not_run').length],
 ['Invoice evidence','Stored paid invoices and previously attested paid histories; no fresh Xero settlement checks'],
 ['Preserved','Existing expiry dates, known start dates, financial amounts, member classes, roles and login settings'],
 ['Financial safety','No new invoices, charges, subscriptions, emails or event-total allocation to membership'],
 ['Policy','Current matching schedule supplies renewal rules, not historical prices or original purchase policy'],
 ['Verification limit','Full renewal-context checks used captured data and stopped before pricing/payment execution. Signed-in browser UI not verified.'],
]);
sheet('Repaired memberships',['Member','Member ID','Invoice','Membership starts','Retained expiry','Invoice type','Schedule','Start-date authority','Renewal result'],
 plan.filter(p=>p.state==='candidate').flatMap(p=>p.repairs.map(r=>[
   name(p.memberId),p.memberId,r.invoice.invoice_number,r.start,r.end,r.kind==='standalone'?'Membership invoice':'Membership included with event',
   r.config.name,r.before.term_start_date?'Existing start preserved':'Invoice date',
   verified.results.find(v=>v.memberId===p.memberId)?.renewal.state,
 ])));
const remaining=evidence.rows.filter(r=>!r.exclusion&&r.issues.some(i=>i.code==='renewal_admission_review'));
sheet('Remaining blockers',['Member','Member ID','Review finding','Renewal blocker'],
 remaining.map(r=>[name(r.memberId),r.memberId,plan.find(p=>p.memberId===r.memberId)?.reason,r.renewalReason]));
const output=`${root}/BNMS-membership-repairs-and-remaining-review.xlsx`;
await book.xlsx.writeFile(output); await fs.chmod(output,0o600);
const check=new ExcelJS.Workbook();await check.xlsx.readFile(output);
assert.equal(check.getWorksheet('Repaired memberships').rowCount,46);
assert.equal(check.getWorksheet('Remaining blockers').rowCount,16);
console.log(JSON.stringify({output,repaired:45,remaining:15}));
