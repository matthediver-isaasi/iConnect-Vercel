import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root='generated-artifacts/bnms-invoice-date-repair';
const receipt=JSON.parse(await fs.readFile(`${root}/priced-verify.json`,'utf8'));
const previous=new ExcelJS.Workbook();
await previous.xlsx.readFile(`${root}/BNMS-membership-repairs-and-remaining-review.xlsx`);
const names=new Map();
previous.getWorksheet('Repaired memberships').eachRow((row,index)=>{
  if(index>1)names.set(row.getCell(2).value,row.getCell(1).value);
});
const book=new ExcelJS.Workbook();
function add(title,headers,rows){
  const ws=book.addWorksheet(title);
  ws.addRow(headers);rows.forEach(row=>ws.addRow(row));
  ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163B55'}};
  ws.columns.forEach((c,i)=>c.width=i===0?32:38);
  ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:{row:1,column:1},to:{row:rows.length+1,column:headers.length}};
  ws.eachRow(row=>row.alignment={vertical:'top',wrapText:true});
  return ws;
}
add('Read me',['Item','Result'],[
  ['Supersedes earlier repair workbook','Full priced commitments replace the earlier evidence-only reconstruction'],
  ['Verified commitments',receipt.results.length],
  ['Date authority','Invoice date plus matching membership structure duration, as approved by owner'],
  ['Price authority','Matching member_class structure; not a financial allocation of the bundled event invoice'],
  ['Price display','Agreed, net and gross values verified; saved structure name, frequency, duration and renewal date included'],
  ['UI verification','All 45 saved histories passed rendered membership-tab component checks. Authenticated live browser not used.'],
  ['Safety','No charges, emails, subscriptions, Xero invoice changes or changes to existing fully documented purchases'],
  ['Unresolved cases','The 15 separate cases from the earlier review remain outside this priced reconstruction'],
]);
const rows=receipt.results.map(r=>[names.get(r.memberId)||r.memberId,r.memberId,r.invoice,r.structure,
  r.start,r.end,r.renewal,12,'upfront',r.amount,r.prices.net.amount,r.prices.gross.amount,r.renewalAssessment.state]);
const ws=add('Complete commitments',['Member','Member ID','Invoice','Saved structure','Start','Expiry','Renewal date',
  'Duration months','Frequency','Agreed GBP','Net GBP','Gross GBP','Renewal check'],rows);
for(const index of [10,11,12])ws.getColumn(index).numFmt='£#,##0.00';
const remaining=previous.getWorksheet('Remaining blockers');
const remainingRows=[];remaining.eachRow((row,i)=>{if(i>1)remainingRows.push(row.values.slice(1));});
add('Remaining cases',remaining.getRow(1).values.slice(1),remainingRows);
const path=`${root}/BNMS-complete-priced-membership-commitments.xlsx`;
await book.xlsx.writeFile(path);await fs.chmod(path,0o600);
const check=new ExcelJS.Workbook();await check.xlsx.readFile(path);
assert.equal(check.getWorksheet('Complete commitments').rowCount,46);
assert.equal(check.getWorksheet('Complete commitments').getCell('F2').value,'2027-03-02');
assert.equal(check.getWorksheet('Complete commitments').getCell('J2').value,156);
console.log(path);
