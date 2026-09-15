/**
 * Read-only, destination-only validation. No live mode or write methods exist.
 * Run: node scripts/validate-bnms-youtube-categorisation.mjs
 * Outputs (including a replay snapshot) stay under .local/bnms-youtube-categorisation/.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { INPUT, readWorkbook, readAll, buildReport, checksum } from './bnms-youtube-categorisation.mjs';

async function main() {
  if (process.argv.slice(2).some(a=>a !== '--dry-run')) throw new Error('Only --dry-run is accepted; no live mode exists');
  const workbook = readWorkbook(readFileSync(INPUT));
  const url = process.env.DEST_SUPABASE_URL, key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw new Error('Destination credentials are required; legacy fallback is forbidden');
  const client = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch: (input,init) => {
      if ((init?.method || 'GET').toUpperCase() !== 'GET') throw new Error('Read-only transport rejects non-GET requests');
      return fetch(input,init);
    }}});
  const resources = await readAll(client,'resource','id,target_url,subcategories,tags');
  const categories = await readAll(client,'resource_category','id,name,subcategories');
  const report = buildReport(workbook,resources.rows,categories.rows);
  report.coverage = { resourcePages:resources.pages, categoryPages:categories.pages, exactResourceCount:resources.total };
  const snapshot = {resources:resources.rows,categories:categories.rows};
  report.snapshotChecksum = checksum(JSON.stringify(snapshot));
  const repeat = buildReport(workbook,snapshot.resources,snapshot.categories);
  if (JSON.stringify(repeat) !== JSON.stringify(buildReport(workbook,resources.rows,categories.rows))) throw new Error('Non-repeatable report');
  const dir = '.local/bnms-youtube-categorisation';
  mkdirSync(dir,{recursive:true});
  writeFileSync(`${dir}/snapshot.json`,JSON.stringify(snapshot,null,2));
  writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));
  const summary = `# BNMS YouTube categorisation — approval dry run\n\nNo database writes. Existing fields other than subcategories are outside the proposed patch; all existing tags are retained.\n\nWorkbook SHA-256: ${report.inputChecksum}\n\nSnapshot SHA-256: ${report.snapshotChecksum}\n\nRead at: ${new Date().toISOString()}\n\n${Object.entries(report.summary).map(([k,v])=>`- ${k}: ${v}`).join('\n')}\n\nCollection additions: ${report.categoryDefinitions[0].additions.join(', ')}.\n\nBlocked rows: ${report.rows.filter(r=>r.status==='blocked').map(r=>`${r.row}: ${r.issues.join('; ')}`).join('\n')}\n\nDuplicate consolidation:\n${report.proposals.filter(p=>p.sourceRows.length>1).map(p=>`- Rows ${p.sourceRows.join(', ')}: ${p.resulting.subcategories.join(', ')}`).join('\n')}\n\nRe-run: node scripts/validate-bnms-youtube-categorisation.mjs --dry-run\nTests: node --test scripts/bnms-youtube-categorisation.test.mjs\n\nreport.json contains every row and consolidated proposal. snapshot.json permits offline replay through buildReport/readWorkbook. approval-report.xlsx provides the same review data in spreadsheet form. A new live read is required before any separately authorised import; this snapshot is not a transactionally frozen database backup.\n`;
  writeFileSync(`${dir}/summary.md`,summary);
  const out = XLSX.utils.book_new();
  const sheet = (name,items) => XLSX.utils.book_append_sheet(out,XLSX.utils.json_to_sheet(items.map(item=>Object.fromEntries(Object.entries(item).map(([k,v])=>[k,typeof v==='object' ? JSON.stringify(v) : v])))),name);
  sheet('Summary',Object.entries(report.summary).map(([metric,value])=>({metric,value})));
  sheet('Source rows',report.rows);
  sheet('Resource proposals',report.proposals);
  sheet('Collection definitions',report.categoryDefinitions);
  sheet('Provenance',[{input:INPUT,checksum:report.inputChecksum,snapshotChecksum:report.snapshotChecksum,mapping:report.mapping,coverage:report.coverage}]);
  XLSX.writeFile(out,`${dir}/approval-report.xlsx`);
  console.log(summary);
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });