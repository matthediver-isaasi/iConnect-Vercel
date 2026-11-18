import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { TENANT, COMPANY, keys, hash, pick, normalize } from './lib/bnms-member-invoice-audit.mjs';

const dir=process.argv[2];
assert.equal(process.argv.length,3);
assert.match(dir||'',/^generated-artifacts\/bnms-member-invoice-audit-[a-zA-Z0-9-]+$/);
const load=async name=>JSON.parse(await readFile(`${dir}/${name}`,'utf8'));
const original=await load('snapshot.json'), manifest=await load('manifest.json'), pin=await load('manifest-pin.json');
assert.equal(hash(manifest),pin.sha256); assert.equal(hash(original),manifest.snapshotHash);
let verification=null, final=original;
try { verification=await load('verification.json'); final=await load('final-snapshot.json'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
if(verification) { assert.equal(verification.verified,true); assert.equal(hash(final),verification.finalSnapshotHash); }
const receipts=new Map((verification?.receipts||[]).map(r=>[r.id,r]));
const roleNames=new Map(original.roles.map(r=>[r.id,r.name]));
const rows=manifest.rows.map(r=>{
  const receipt=receipts.get(r.member.id);
  const after=pick(final.addresses.find(a=>a.owner_type==='member'&&a.owner_id===r.member.id));
  const copied=receipt?.outcome==='copied';
  if(copied) assert.deepEqual(after,pick(receipt.after));
  return {...r,after,outcome:copied?'copied':receipt ? 'lookup error/incomplete':r.outcome,
    reason:receipt&&!copied?receipt.outcome:r.reason,receipt,
    finalDifferences:r.proposed?keys.filter(k=>normalize(after[k])!==normalize(r.proposed[k])):[]};
});
assert.equal(rows.length,original.total-original.excludedCount);
assert.equal(new Set(rows.map(r=>r.member.id)).size,rows.length);
assert.equal(rows.filter(r=>r.outcome==='copied').length,verification?.copied||0);
const outcomes=['same','different','copied','no contact','missing Xero invoice address','ambiguous','partial iConnect address','lookup error/incomplete'];
const counts=Object.fromEntries(outcomes.map(k=>[k,rows.filter(r=>r.outcome===k).length]));
assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),rows.length);
const source=await load('discovery.json');
const contactsById=new Map(source.contacts.map(c=>[c.ContactID,c]));
const candidateDetails=r=>r.candidates.map(id=>{
  const c=contactsById.get(id);
  return {ContactID:id,Name:c?.Name??null,EmailAddress:c?.EmailAddress??null,
    AccountNumber:c?.AccountNumber??null,ContactStatus:c?.ContactStatus??null,Addresses:c?.Addresses??null,
    savedMemberCompanyBinding:original.links.some(l=>l.member_id===r.member.id&&l.xero_contact_id===id&&l.xero_tenant_id===COMPANY),
    exactEmail:typeof c?.EmailAddress==='string'&&typeof r.member.email==='string'&&c.EmailAddress.trim().toLowerCase()===r.member.email.trim().toLowerCase()};
});
const book=new ExcelJS.Workbook();
book.creator='iConnect BNMS private audit'; book.created=new Date(); book.subject='Private member invoicing address comparison and empty-only backfill';
const addSheet=(name,headers,data)=>{
  const sheet=book.addWorksheet(name,{views:[{state:'frozen',ySplit:1,xSplit:3}]});
  sheet.addRow(headers);
  for(const values of data) {
    sheet.addRow(values.map(v=>{
      if(v==null) return '';
      if(typeof v==='number'||typeof v==='boolean') return v;
      const text=String(v);
      assert.ok(text.length<=32767,'Workbook cell exceeds Excel length; do not truncate evidence');
      return text; // ExcelJS emits literal text, never formula/hyperlink objects.
    }));
  }
  sheet.getRow(1).height=42;
  sheet.getRow(1).eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF24476B'}};c.alignment={vertical:'middle',wrapText:true};});
  sheet.columns.forEach((c,i)=>{c.width=i<3?38:28;});
  sheet.eachRow((r,n)=>{if(n>1){r.alignment={vertical:'top',wrapText:true}; if(n%2===0)r.eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F4F8'}};});}});
  sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:headers.length}};
  return sheet;
};
const summary=[
  ['PRIVATE — BNMS member invoice address audit','Do not publish or upload to public assets. Access is limited to this project.'],
  ['Tenant',`${original.tenant.name} / ${TENANT}`],
  ['Xero company',`${source.organisation?.[0]?.Name||original.connection.tenant_name||'Unverified'} / ${COMPANY}`],
  ['Destination','Supabase lvmzliemqnieeoruhkik (verified TLS and project identity)'],
  ['Snapshot time UTC',original.capturedAt],['Contact discovery completed UTC',source.completedAt||'INCOMPLETE'],
  ['Final verification UTC',verification?.at||'No backfill applied / no committed verification'],
  ['All BNMS members (all statuses)',original.total],['Excluded CPD Guest assignments',original.excludedCount],
  ['Eligible members audited',rows.length],['Secondary role assignments examined',original.secondary.length],
  ['Secondary role schema',original.relations.some(r=>r.table_name==='member_role')?'member_role':'No secondary member-role relation installed; catalog evidence retained'],
  ['Member pagination counts',original.pagination.join(', ')],
  ['Full Xero scan complete',source.complete],['Xero contacts scanned (including archived)',source.contacts.length],
  ['Xero contact pages (includes terminal empty page)',source.pages.length],
  ['Committed and verified copies',verification?.copied||0],
  ['Actual zero-write rerun',verification?.zeroWriteRerunCandidates===0?'Zero eligible writes on replay against committed records':'NOT PROVEN'],
  ['Protected untouched address rows verified',verification?.protectedTargetsVerified||false],
  ['Member profile/membership/mailing rows unchanged',verification?.memberRecordsUnchanged||false],
  ['Snapshot SHA256',manifest.snapshotHash],['Pinned dry-run manifest SHA256',pin.sha256],
  ['Final snapshot SHA256',verification?.finalSnapshotHash||'Not applied'],
  ...Object.entries(counts).map(([k,v])=>[`Final outcome: ${k}`,v]),
  ['Comparison policy','Trim, collapse whitespace, lowercase only; no abbreviation, country, postcode or punctuation rewriting. Original text is retained.'],
  ['Partial policy','Any existing nonblank canonical component protects the entire target; missing components are never filled.'],
  ['Copy policy','Unique active member/company binding or unique exact normalized email only; shared identities held. Names are evidence only.'],
  ['Mapping policy','POBOX only; six fields copied verbatim. Attention, AddressLine3/4, unknown nonempty fields, control characters or overlong fields are held; no STREET substitution.'],
  ['Blank policy','All six fields must be null or whitespace; transaction rechecks owner, CPD Guest role, identity, source and atomic emptiness.'],
  ['Timing','Before columns and comparison describe the pinned pre-update snapshot. After columns and final differences describe verified committed state.'],
  ['Same/different','Normalized comparison, not raw text equality. Empty target candidates appear as pre-update different, then copied only after verified commit.'],
  ['No contact','Complete company contact scan with no verified bound ID or exact normalized email; not a name-only account search.'],
  ['Limitations',source.complete?'No incomplete discovery. Missing, archived, ambiguous, partial and unsupported rows were not changed. No historical invoice or organisation address is a member-address source.':`INCOMPLETE LIVE COVERAGE: ${source.error||'Contact scan did not finish'}. No writes authorized.`],
  ['Scope','No Xero contacts/invoices, historical snapshots, organisation addresses, mailing addresses, membership details or application behavior were changed. Shared quota bookkeeping only.'],
];
addSheet('Summary',['Measure / policy','Value'],summary).columns=[{width:55},{width:125}];
const labels=['line 1','line 2','city','region','postcode','country'];
const headers=['Member ID','Member name','Member email','Member status','Primary role','Final outcome','Matching basis','Outcome detail',
  'Xero company ID','Xero company name','Xero contact ID','Xero contact / company name','Xero account number','Xero email','Xero contact status',
  'Candidate contact IDs','Pre-update comparison','Pre-update differing fields','Final differing fields',
  ...labels.map(k=>`iConnect BEFORE ${k}`),...labels.map(k=>`Xero mapped ${k}`),...labels.map(k=>`iConnect AFTER ${k}`),
  'Xero POBOX AttentionTo','Xero POBOX AddressLine1','Xero POBOX AddressLine2','Xero POBOX AddressLine3','Xero POBOX AddressLine4',
  'Xero POBOX City','Xero POBOX Region','Xero POBOX PostalCode','Xero POBOX Country','Xero complete raw addresses JSON',
  'Write outcome','Write committed and verified','Receipt time UTC','All Xero candidate evidence JSON'];
const values=r=>[
  r.member.id,[r.member.first_name,r.member.last_name].filter(Boolean).join(' '),r.member.email,r.member.status,roleNames.get(r.member.role_id)||r.member.role_id,
  r.outcome,r.basis||(r.candidates.length?'Unresolved saved binding and/or exact email candidates':''),r.reason,COMPANY,source.organisation?.[0]?.Name||'',r.contact?.ContactID,r.contact?.Name,r.contact?.AccountNumber,r.contact?.EmailAddress,r.contact?.ContactStatus,
  r.candidates.join(', '),r.comparison,r.differences.join(', '),r.finalDifferences.join(', '),
  ...keys.map(k=>r.before[k]),...keys.map(k=>r.proposed?.[k]),...keys.map(k=>r.after[k]),
  ...['AttentionTo','AddressLine1','AddressLine2','AddressLine3','AddressLine4','City','Region','PostalCode','Country'].map(k=>r.source?.[k]),
  JSON.stringify(r.contact?.Addresses||[]),r.receipt?.outcome||'not written',r.outcome==='copied'&&verification?.verified===true,r.receipt?.at,JSON.stringify(candidateDetails(r)),
];
addSheet('All member audit',headers,rows.map(values));
addSheet('Differences',headers,rows.filter(r=>r.differences.length).map(values));
addSheet('Copied addresses',headers,rows.filter(r=>r.outcome==='copied').map(values));
addSheet('Review and errors',headers,rows.filter(r=>!['same','copied'].includes(r.outcome)).map(values));
addSheet('Contact match evidence',[
  'Member ID','Member name','Member email','Final outcome','Selected unique contact','Xero company ID','Candidate contact ID',
  'Candidate contact / company name','Candidate email','Candidate account number','Candidate status','Saved member/company binding',
  'Exact normalized email match','Candidate raw addresses JSON',
],rows.flatMap(r=>candidateDetails(r).map(c=>[
  r.member.id,[r.member.first_name,r.member.last_name].filter(Boolean).join(' '),r.member.email,r.outcome,
  r.contact?.ContactID===c.ContactID,COMPANY,c.ContactID,c.Name,c.EmailAddress,c.AccountNumber,c.ContactStatus,
  c.savedMemberCompanyBinding,c.exactEmail,JSON.stringify(c.Addresses),
])));
const bytes=await book.xlsx.writeBuffer();
const roundtrip=new ExcelJS.Workbook();await roundtrip.xlsx.load(bytes);
assert.equal(roundtrip.getWorksheet('All member audit').rowCount,rows.length+1);
for(const sheet of roundtrip.worksheets) sheet.eachRow(row=>row.eachCell(cell=>assert.notEqual(cell.type,ExcelJS.ValueType.Formula,'No spreadsheet formula may be emitted')));
await writeFile(`${dir}/BNMS-member-invoice-address-audit.xlsx`,bytes,{mode:0o600,flag:'wx'});
await writeFile(`${dir}/workbook-reconciliation.json`,JSON.stringify({total:original.total,excluded:original.excludedCount,eligible:rows.length,counts,
  copied:verification?.copied||0,workbookSha256:hash(Buffer.from(bytes)),sheets:roundtrip.worksheets.map(s=>({name:s.name,rows:s.rowCount-1})),
  noFormulaCells:true},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({total:original.total,excluded:original.excludedCount,eligible:rows.length,counts,workbookVerified:true}));
