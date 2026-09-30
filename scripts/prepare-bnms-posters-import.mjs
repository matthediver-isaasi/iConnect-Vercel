/**
 * GET-only proposal generator. No apply mode, no SOURCE fallback.
 * node scripts/prepare-bnms-posters-import.mjs
 */
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import XLSX from 'xlsx';
import {TENANT_ID,INPUT,readWorkbook,readAll,buildReport,checksum} from './bnms-posters-proposal.mjs';

async function main() {
  if (process.argv.length !== 2) throw Error('No arguments supported; approval-only, no apply mode');
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.rows.length,921,'Source row count changed');
  assert.equal(workbook.checksum,'853c7e8b5202fe3ce0f8175aa97bf89f0d054e5fa7502dfcf18852767a0dc972','Workbook differs from reviewed source');
  const url = process.env.DEST_SUPABASE_URL, key = process.env.DEST_SUPABASE_KEY;
  if (!key) throw Error('DEST credentials required');
  assert.equal(url,'https://lvmzliemqnieeoruhkik.supabase.co','Wrong destination');
  const client = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{
    if ((init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()!=='GET') throw Error('Only GET permitted');
    return fetch(input,init);
  }}});
  const tenantResult = await client.from('tenant').select('id,name').eq('id',TENANT_ID);
  if (tenantResult.error) throw Error('Tenant read failed');
  assert.deepEqual(tenantResult.data,[{id:TENANT_ID,name:'BNMS'}],'Tenant identity mismatch');
  // Explicit columns verify the fields used by the proposal exist in DEST.
  const columns = 'id,tenant_id,title,target_url,description,release_date,is_public,resource_type,subcategories,tags,allowed_role_ids,status,open_in_new_tab';
  const startedAt = new Date().toISOString();
  const resources = await readAll(client,'resource',columns);
  const categories = await readAll(client,'resource_category','id,tenant_id,name,subcategories,excluded_role_ids,subcategory_excluded_role_ids');
  const snapshot = {resources:resources.rows,categories:categories.rows};
  // Two complete reads detect intervening edits as well as count drift.
  const secondResources = await readAll(client,'resource',columns);
  const secondCategories = await readAll(client,'resource_category','id,tenant_id,name,subcategories,excluded_role_ids,subcategory_excluded_role_ids');
  assert.equal(checksum(JSON.stringify(snapshot)),checksum(JSON.stringify({resources:secondResources.rows,categories:secondCategories.rows})),'Destination changed during comparison; rerun');
  const report = buildReport(workbook,resources.rows,categories.rows);
  assert.deepEqual(report,buildReport(readWorkbook(readFileSync(INPUT)),snapshot.resources,snapshot.categories),'Offline replay differs');
  for (const row of report.rows) if (row.before) {
    for (const [field,value] of Object.entries(row.proposed)) {
      if (JSON.stringify(value)!==JSON.stringify(row.before[field])) assert.ok(row.changes[field],`Undisclosed change at row ${row.row}: ${field}`);
    }
  }
  Object.assign(report,{startedAt,completedAt:new Date().toISOString(),destinationProject:'lvmzliemqnieeoruhkik',tenant:tenantResult.data[0],
    schemaVerifiedColumns:{resource:columns,resource_category:Object.keys(categories.rows[0])},
    snapshotChecksum:checksum(JSON.stringify(snapshot)),coverage:{resourcePages:resources.pages,categoryPages:categories.pages,resourceTotal:resources.total,categoryTotal:categories.total,secondReadIdentical:true}});
  const dir = `reports/bnms-posters/${report.completedAt.replaceAll(':','-')}`;
  mkdirSync(dir,{recursive:true});
  const save = (name,data)=>writeFileSync(`${dir}/${name}`,data);
  save('audit.json',JSON.stringify(report,null,2));
  save('snapshot.json',JSON.stringify(snapshot,null,2));
  const issues = {};
  for (const row of report.rows) for (const issue of row.issues) (issues[issue]??=[]).push(row.row);
  const changes = {};
  for (const row of report.rows) for (const field of Object.keys(row.changes)) if(row.before) (changes[field]??=[]).push(row.row);
  const summary = `# BNMS posters — approval proposal\n\n**READ ONLY. Execution remains pending explicit approval. No database or taxonomy writes.**\n\nTenant: BNMS (British Nuclear Medicine Society), ${TENANT_ID}. DEST project: lvmzliemqnieeoruhkik.\nRead window: ${startedAt} to ${report.completedAt}.\n\n## Counts\n${Object.entries(report.summary).map(([k,v])=>`- ${k}: ${v}`).join('\n')}\n\nCounts are row-level against current DEST, not estimates. Blocked rows are excluded from insert/update/unchanged totals. Even non-blocked updates require approval.\n\n## Decisions for approval\n- All proposals use is_public=false. Existing allowed_role_ids, tags, status and other non-mapped settings remain unchanged. Public-to-member-only changes require approval; none has been applied.\n- Resource URL, Title and Brief Description are retained literally, including whitespace and empty descriptions. Review metadata differences in the workbook before approving replacements.\n- Dates are calendar years 2016–2025, not Excel serial dates. Approve the established January 1 year-only convention; this does not assert a known event date.\n- New resources would use display type Download (download), status active and the original Drive URL. Posters is a separate Resource Type taxonomy classification. Existing display types are preserved; conversion to Download is NOT included.\n- Classifications are additive: Events under Collection; Posters under Resource Type; trimmed case-insensitive X topic markers under Focus Area. Management remains Management; Management and Workforce maps to the verified Management & Workforce. Working in NM markers map to Focus Area, NOT Collection or Subject. Existing tags/classifications are never removed.\n- Page URL contains folder links and is retained separately in the audit, never used as the resource target or identity. Menu Item is source grouping context only. Approve retaining both as audit-only, with no automatic tags, folders, menus or classifications created.\n- Lists and Categories Event Photos & News are reference sheets only; no records are proposed from them.\n- Exact Resource URL matches are preferred; conservative Drive file identity is fallback. Any additional identity candidate blocks the row even if one exact URL exists. Titles never select a record to update. Resolve blocked links or duplicate candidates explicitly; no duplicate deletion is proposed.\n- Taxonomy names exist in multiple category groups; the app stores flat subcategory names. Proposed names are verified against the intended group, but existing category access rules are not changed. Snapshot includes those restrictions for review.\n\n## Changed fields on uniquely matched rows\n${Object.entries(changes).map(([k,v])=>`- ${k}: ${v.length} rows`).join('\n')}\n\n## Blocked issues and source rows\n${Object.entries(issues).map(([k,v])=>`- ${k}: ${v.join(', ')}`).join('\n') || 'None.'}\n\n## Provenance and coverage\n- Source: ${INPUT}\n- Workbook SHA-256: ${report.inputChecksum}\n- Destination snapshot SHA-256: ${report.snapshotChecksum}\n- Resource pages: ${resources.pages.join(', ')}; exact total ${resources.total}.\n- Category pages: ${categories.pages.join(', ')}; exact total ${categories.total}.\n- Two ordered, count-checked full reads were identical. This is not a transactional backup; any approved execution must refresh and compare the before-values again.\n\napproval.xlsx contains source rows, before/proposed values, differences, decisions and taxonomy. audit.json is the complete machine-readable row audit; snapshot.json is the replay input. Reproduce with node scripts/prepare-bnms-posters-import.mjs. Test with node --test scripts/bnms-posters-proposal.test.mjs.\n`;
  save('approval-summary.md',summary);
  const out = XLSX.utils.book_new();
  const sheet = (name,items)=>XLSX.utils.book_append_sheet(out,XLSX.utils.json_to_sheet(items.map(item=>Object.fromEntries(Object.entries(item).map(([k,v])=>[k,v!==null && typeof v==='object'?JSON.stringify(v):v])))),name);
  sheet('Summary',Object.entries(report.summary).map(([metric,value])=>({metric,value})));
  sheet('Rows',report.rows.map(r=>({row:r.row,status:r.status,title:r.source.Title,url:r.source['Resource URL'],match:r.matchMethod,candidates:r.candidateIds,issues:r.issues,notes:r.notes,changes:r.changes,decisions:r.decisions})));
  sheet('Source',report.rows.map(r=>({row:r.row,...r.source,hyperlinks:r.links,formulas:r.formulas})));
  sheet('Before and proposed',report.rows.map(r=>({row:r.row,status:r.status,before:r.before,proposed:r.proposed,candidateBefore:r.candidateBefore,titleOnlyCandidates:r.titleOnlyCandidateIds})));
  sheet('Taxonomy',categories.rows);
  sheet('Resolved taxonomy',report.rows.flatMap(r=>r.taxonomy.map(t=>({row:r.row,...t}))));
  sheet('Provenance',[{source:INPUT,checksum:report.inputChecksum,snapshotChecksum:report.snapshotChecksum,startedAt,completedAt:report.completedAt,coverage:report.coverage,sheets:report.sheets}]);
  XLSX.writeFile(out,`${dir}/approval.xlsx`);
  console.log(JSON.stringify({directory:dir,...report.summary}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});