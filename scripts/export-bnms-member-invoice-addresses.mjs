import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { TENANT, COMPANY, keys, hash, pick, normalize } from './lib/bnms-member-invoice-audit.mjs';

const dir=process.argv[2];
const currentState=process.argv[3]==='--current-state';
assert.equal(process.argv.length,currentState?4:3);
assert.match(dir||'',/^generated-artifacts\/bnms-member-invoice-audit-[a-zA-Z0-9-]+$/);
const load=async name=>JSON.parse(await readFile(`${dir}/${name}`,'utf8'));
const original=await load('snapshot.json'), manifest=await load('manifest.json'), pin=await load('manifest-pin.json');
assert.equal(hash(manifest),pin.sha256); assert.equal(hash(original),manifest.snapshotHash);
let verification=null, final=original;
try { verification=await load('verification.json'); final=await load('final-snapshot.json'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
if(verification) { assert.equal(verification.verified,true); assert.equal(hash(final),verification.finalSnapshotHash); }
if(currentState) assert.equal(verification,null,'Current-state exports cannot consume historical write receipts');
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
assert.equal(hash(source),manifest.discoveryHash,'Discovery must match the pinned manifest');
if(currentState) assert.equal(source.complete,true,'A current-state audit requires complete live discovery');
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
if(currentState) book.subject='NEW current-state read-only audit; not the recovered historical workbook';
book.views=[{activeTab:0,firstSheet:0,visibility:'visible'}];
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
const currentSummary=[
  ['PRIVATE — BNMS CURRENT-STATE audit','NEW read-only report, NOT the missing historical workbook. Do not publish.'],
  ['Report generated UTC',book.created.toISOString()],
  ['Member/address snapshot UTC',original.capturedAt],
  ['Xero contact discovery completed UTC',source.completedAt],
  ['Collection timing','Database snapshot and Xero scan are separate observations, not a single cross-system transaction.'],
  ['Tenant',`${original.tenant.name} / ${TENANT}`],
  ['Xero company',`${source.organisation?.[0]?.Name||''} / ${COMPANY}`],
  ['All current BNMS members (all statuses)',original.total],
  ['Current excluded CPD Guest assignments',original.excludedCount],
  ['Current eligible members audited',rows.length],
  ['Secondary role assignments examined',original.secondary.length],
  ['Member pagination counts',original.pagination.join(', ')],
  ['Full Xero scan complete',source.complete],
  ['Xero contacts scanned (including archived)',source.contacts.length],
  ['Xero contact pages (includes terminal empty page)',source.pages.length],
  ['Address writes performed by this audit',0],
  ['Current snapshot SHA256',manifest.snapshotHash],
  ['Current discovery SHA256',manifest.discoveryHash],
  ['Current manifest SHA256',pin.sha256],
  ...Object.entries(counts).map(([k,v])=>[`Current outcome: ${k}`,v]),
  ['Current normalized matching addresses',rows.filter(r=>r.comparison==='same').length],
  ['Current wholly blank copy candidates (NOT applied)',rows.filter(r=>r.candidate).length],
  ['Historical provenance','Original workbook, before-images and write receipts unavailable. Current values cannot prove historical copy outcomes. See Historical context.'],
  ['Comparison policy','Trim, collapse whitespace and lowercase only. Missing optional components may classify an existing address as partial even when its normalized comparison is same.'],
  ['Identity and source policy','Verified member/company binding or unique exact normalized email; POBOX only. Unsupported source components, archived contacts and conflicting identities remain review rows.'],
  ['Scope','Read-only member/address snapshot and GET-only Xero scan. No member, address, contact or invoice changes. Shared Xero quota bookkeeping only.'],
];
addSheet('Summary',['Measure / policy','Value'],currentState?currentSummary:summary).columns=[{width:55},{width:125}];
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
// Never relabel today's values as historical before/after evidence.
const currentHeaders=[
  'Member ID','Member name','Member email','Member status','Primary role','Current outcome','Matching basis','Outcome detail',
  'Xero company ID','Xero company name','Xero contact ID','Xero contact / company name','Xero account number','Xero email','Xero contact status',
  'Candidate contact IDs','Current normalized comparison','Current differing fields',
  ...labels.map(k=>`iConnect CURRENT ${k}`),...labels.map(k=>`Xero mapped ${k}`),
  'Xero POBOX AttentionTo','Xero POBOX AddressLine1','Xero POBOX AddressLine2','Xero POBOX AddressLine3','Xero POBOX AddressLine4',
  'Xero POBOX City','Xero POBOX Region','Xero POBOX PostalCode','Xero POBOX Country','Xero complete raw addresses JSON',
  'Wholly blank copy candidate (NOT applied)','Historical copy provenance','All Xero candidate evidence JSON',
];
const currentValues=r=>[
  r.member.id,[r.member.first_name,r.member.last_name].filter(Boolean).join(' '),r.member.email,r.member.status,roleNames.get(r.member.role_id)||r.member.role_id,
  r.outcome,r.basis,r.reason,COMPANY,source.organisation?.[0]?.Name||'',r.contact?.ContactID,r.contact?.Name,r.contact?.AccountNumber,r.contact?.EmailAddress,r.contact?.ContactStatus,
  r.candidates.join(', '),r.comparison,r.differences.join(', '),
  ...keys.map(k=>r.before[k]),...keys.map(k=>r.proposed?.[k]),
  ...['AttentionTo','AddressLine1','AddressLine2','AddressLine3','AddressLine4','City','Region','PostalCode','Country'].map(k=>r.source?.[k]),
  JSON.stringify(r.contact?.Addresses||[]),r.candidate,'Unavailable — not inferred from current values',JSON.stringify(candidateDetails(r)),
];
const auditHeaders=currentState?currentHeaders:headers, auditValues=currentState?currentValues:values;
addSheet('All member audit',auditHeaders,rows.map(auditValues));
addSheet('Differences',auditHeaders,rows.filter(r=>r.differences.length).map(auditValues));
if(currentState) addSheet('Historical context',['Recorded measure / limitation','Historical value','Evidence status'],[
  ['Original audit date','2026-11-18','Recorded in docs/bnms-member-invoice-address-audit.md; not reverified'],
  ['Eligible members',1406,'Recorded historical aggregate only'],
  ['Excluded CPD Guests',2685,'Recorded historical aggregate only'],
  ['Verified copies',251,'Recorded historical aggregate only; row-level receipts unavailable'],
  ['No verified contact',431,'Recorded historical aggregate only'],
  ['Missing usable first line',24,'Recorded historical aggregate only'],
  ['Held review rows',700,'606 extra source components, 88 conflicting identities, 6 archived contacts; recorded only'],
  ['Original workbook bytes',908501,'Original unavailable; this report is a new file'],
  ['Original workbook SHA256','534ff681ee965926210570f60c5871412d63e24dbdb2e587c56cda94044f536e','Not the hash of this report'],
  ['Historical before/after addresses','UNAVAILABLE','Not reconstructed from current records'],
]);
else addSheet('Copied addresses',headers,rows.filter(r=>r.outcome==='copied').map(values));
addSheet('Review and errors',auditHeaders,rows.filter(r=>!['same','copied'].includes(r.outcome)).map(auditValues));
addSheet('Contact match evidence',[
  'Member ID','Member name','Member email',currentState?'Current outcome':'Final outcome','Selected unique contact','Xero company ID','Candidate contact ID',
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
const filename=currentState?'BNMS-member-invoice-address-current-state-audit.xlsx':'BNMS-member-invoice-address-audit.xlsx';
await writeFile(`${dir}/${filename}`,bytes,{mode:0o600,flag:'wx'});
await writeFile(`${dir}/${currentState?'current-state-reconciliation':'workbook-reconciliation'}.json`,JSON.stringify({reportType:currentState?'current-state':'historical',total:original.total,excluded:original.excludedCount,eligible:rows.length,counts,
  copied:verification?.copied||0,workbookSha256:createHash('sha256').update(bytes).digest('hex'),workbookBytes:bytes.length,sheets:roundtrip.worksheets.map(s=>({name:s.name,rows:s.rowCount-1})),
  noFormulaCells:true},null,2),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({total:original.total,excluded:original.excludedCount,eligible:rows.length,counts,workbookVerified:true}));
