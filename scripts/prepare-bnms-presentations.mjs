import {createClient} from '@supabase/supabase-js';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import XLSX from 'xlsx';
import {INPUT,TENANT_ID,readWorkbook,readAll,buildReport,checksum} from './bnms-presentations-proposal.mjs';

async function main() {
  if(process.argv.slice(2).some(a=>a!=='--dry-run')) throw Error('Read-only runner; only --dry-run is accepted');
  const url=process.env.DEST_SUPABASE_URL,key=process.env.DEST_SUPABASE_KEY;
  if(url!=='https://lvmzliemqnieeoruhkik.supabase.co'||!key) throw Error('Pinned DEST credentials required; no fallback');
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{
    if((init?.method||'GET').toUpperCase()!=='GET') throw Error('Read transport forbids writes');
    return fetch(input,init);
  }}});
  const {data:tenant,error}=await client.from('tenant').select('id,name').eq('id',TENANT_ID).single();
  if(error||tenant?.name!=='BNMS') throw Error('BNMS tenant identity verification failed');
  const workbook=readWorkbook(readFileSync(INPUT));
  const resources=await readAll(client,'resource','*'), categories=await readAll(client,'resource_category','*');
  const required=['title','target_url','resource_type','release_date','description','is_public','subcategories','tags','allowed_role_ids'];
  if(!resources.rows.length || required.some(k=>!(k in resources.rows[0]))) throw Error('Destination resource schema differs');
  const report=buildReport(workbook,resources.rows,categories.rows);
  const snapshot={tenant,resources:resources.rows,categories:categories.rows};
  const generatorChecksums=Object.fromEntries(['scripts/bnms-presentations-proposal.mjs','scripts/prepare-bnms-presentations.mjs','scripts/bnms-youtube-categorisation.mjs'].map(path=>[path,checksum(readFileSync(path))]));
  Object.assign(report,{readAt:new Date().toISOString(),input:INPUT,sheets:workbook.sheets,snapshotChecksum:checksum(JSON.stringify(snapshot,null,2)),generatorChecksums,
    coverage:{resourceCount:resources.total,resourcePages:resources.pages,categoryCount:categories.total,categoryPages:categories.pages,allSourceRowsCompared:report.rows.length===workbook.rows.length}});
  const dir=`reports/bnms-presentations/${report.readAt.replaceAll(':','-')}`;
  mkdirSync(dir,{recursive:true});
  const save=(name,data)=>writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2));
  save('destination-snapshot',snapshot);save('proposal',report);
  const summary=`# BNMS presentations — approval proposal

**No live changes have been applied. All totals below are proposed, not executed.**

Read at: ${report.readAt}
Tenant: ${tenant.name} (${TENANT_ID})
Workbook SHA-256: ${report.inputChecksum}
Destination snapshot SHA-256: ${report.snapshotChecksum}
(Hash of the exact saved destination-snapshot.json bytes. Generator file hashes are recorded in proposal.json.)

## Proposed operations
${Object.entries(report.summary).map(([k,v])=>`- ${k}: ${v}`).join('\n')}

Skip for this proposal: ${report.summary.unchanged+report.summary.blocked} rows (${report.summary.unchanged} unchanged; ${report.summary.blocked} blocked pending decisions).
All ${report.summary.sourceRows} populated Resources rows were compared with all ${resources.total} destination resources. Ordered, exact-count-checked pages: ${resources.pages.join(', ')}. Taxonomy pages: ${categories.pages.join(', ')}. Other worksheets are references only.

## Mapping for approval
- Resource URL → target_url for inserts; matched resources retain their existing URL variant.
- Title → title; Brief Description → description (blank source preserves existing description).
- Date → release_date. Four-digit years propose **1 January of that year**, not an Excel serial. This convention requires approval; source raw values remain in the audit. Blank source preserves an existing date.
- Member Only Yes → is_public=false. No would allow public only for new/already-public records; existing restrictions, allowed roles, tags, status, folders, member-group links and other fields are preserved.
- New links use external_link, open_in_new_tab=true, active status, no role-specific restrictions beyond member-only access.
- Collection → existing Collection; Resource Type → existing Resource Type; Yes-marked topic columns → existing Focus Area, with Management and Workforce → Management & Workforce and Artificial Intelligence → Artificial intelligence.
- Classifications are additive: no existing classifications or tags removed. Missing taxonomy is blocked, not created.
- Menu Item and Page URL are audit-only; no menus/pages or inferred meeting collections are created. Working in NM is a Focus Area marker (blank in this source). Highlights is treated as a candidate Focus Area only if that exact destination value exists; otherwise selected rows are unresolved, requiring an explicit mapping decision rather than navigation changes.
- Unique exact URL preferred, then conservative Drive file/YouTube identity. Multiple destination candidates, repeated source links, shared folders and title-only candidates require review; no title-only mutations.

## Decisions required
1. Approve the field mapping and year-only date convention.
2. Approve each proposed existing core/access change separately (see Core changes sheet and full before/proposed values).
3. Resolve missing taxonomy: ${report.missingTaxonomy.join('; ')||'none'}.
4. Resolve blocked rows listed in the workbook; blanks never imply public access.
5. Supply distinct file links or explicit per-row handling for repeated/shared links; nothing is silently collapsed.

### Existing core changes requiring separate approval
${report.rows.filter(r=>r.coreChanges.length).map(r=>`- Row ${r.row}: ${r.coreChanges.join(', ')}. Date: ${r.before.release_date} → ${r.proposed.release_date}. Title: "${r.before.title}" → "${r.proposed.title}".`).join('\n')||'None.'}
No existing access changes are proposed in this comparison.

### Held-row reasons (overlap is possible)
${Object.entries(report.rows.reduce((counts,r)=>{for(const issue of r.issues) counts[issue]=(counts[issue]||0)+1;return counts;},{})).map(([reason,count])=>`- ${reason}: ${count} rows`).join('\n')}
The row missing access, Collection and Resource Type is ${report.rows.filter(r=>r.issues.includes('missing_or_invalid_access')).map(r=>r.row).join(', ')}.

## Repeated link investigation
${report.duplicateGroups.map(g=>`- Rows ${g.rows.join(', ')}: ${g.kind}; ${g.identical?'identical source rows':'different source metadata'}; all blocked. Differing fields: ${g.differingFields.join(', ')}. Identity: ${g.key}. Titles: ${g.titles.map(t=>`${t.row}: ${t.title}`).join(' / ')}`).join('\n')}

## Reproducibility and execution boundary
proposal.json contains every raw source row, hyperlink metadata, matching candidate IDs, before/proposed values, patch and issues. destination-snapshot.json contains the complete tenant-scoped resource/taxonomy comparison. approval-report.xlsx is the review copy.
Re-run: node scripts/prepare-bnms-presentations.mjs --dry-run
Tests: node --test scripts/bnms-presentations-proposal.test.mjs
This read was paginated, not a transactionally frozen backup. Before any separately approved execution, recheck workbook checksum, destination identity and all before-values/taxonomy; stop on drift. This runner has no apply mode and rejects non-GET requests.
`;
  writeFileSync(`${dir}/approval-summary.md`,summary);
  const book=XLSX.utils.book_new();
  const sheet=(name,data)=>XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(data.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):v])))),name);
  sheet('Summary',Object.entries(report.summary).map(([metric,value])=>({metric,value})));
  sheet('Approval guide',summary.split('\n').map((text,i)=>({line:i+1,text})));
  const flattened=report.rows.map(r=>({row:r.row,title:r.source.Title,status:r.status,issues:r.issues,match:r.matchMethod,candidateIds:r.candidateIds,titleCandidates:r.titleCandidates,source:r.source,hyperlinks:r.hyperlinks,date:r.date,before:r.before,proposed:r.proposed,patch:r.patch,coreChanges:r.coreChanges,accessChange:r.accessChange}));
  sheet('All source rows',flattened);sheet('Blocked rows',flattened.filter(r=>r.status==='blocked'));sheet('Core changes',flattened.filter(r=>r.coreChanges.length));sheet('Duplicate links',report.duplicateGroups);
  sheet('Taxonomy',categories.rows);sheet('Provenance',[{input:INPUT,inputChecksum:report.inputChecksum,snapshotChecksum:report.snapshotChecksum,readAt:report.readAt,coverage:report.coverage,generatorChecksums}]);
  XLSX.writeFile(book,`${dir}/approval-report.xlsx`,{compression:true});
  console.log(JSON.stringify({dir,summary:report.summary,missingTaxonomy:report.missingTaxonomy}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});