import assert from 'node:assert/strict';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import pg from 'pg';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID, checksum, readAll } from './bnms-presentations-proposal.mjs';
import { loadApproval, planApproved, applyApproved, verifyApplied, assertSnapshot, PROPOSAL_SHA, SOURCE_SHA } from './bnms-presentations-live.mjs';
import { destinationConfig, durableFile, writeComplete, syncDirectory } from './bnms-youtube-categorisation-io.mjs';

async function main() {
  const args = process.argv.slice(2);
  assert(args.length <= 1 && (!args.length || ['--dry-run','--apply'].includes(args[0])), 'Only --dry-run or --apply accepted');
  const live = args[0] === '--apply';
  const bundle = loadApproval(), plan = planApproved(bundle);
  const config = destinationConfig(process.env.DEST_SUPABASE_URL, process.env.DEST_DATABASE_URL);
  assert(process.env.DEST_SUPABASE_KEY, 'DEST read verification credentials required');
  const rest = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>{
      assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'REST transport is read-only');
      return fetch(input,init);
    }},
  });
  const readRest = async () => {
    const {data:tenant,error} = await rest.from('tenant').select('id,name').eq('id', TENANT_ID).single();
    assert(!error && tenant?.id === TENANT_ID && tenant.name === 'BNMS', 'REST tenant identity mismatch');
    const resources = await readAll(rest,'resource','*'), categories = await readAll(rest,'resource_category','*');
    return {snapshot:{tenant,resources:resources.rows,categories:categories.rows},
      coverage:{resources:resources.pages,categories:categories.pages}};
  };
  const initial = await readRest();
  let alreadyApplied = false;
  try { assertSnapshot(initial.snapshot, plan.expected); alreadyApplied = true; } catch { /* Check pinned before-state below. */ }
  if (alreadyApplied) verifyApplied(bundle, initial.snapshot);
  else assertSnapshot(initial.snapshot, bundle.before, 'REST destination drift; stop for review');
  if (!live) {
    console.log(JSON.stringify({mode:'READ_ONLY',alreadyApplied,inserts:alreadyApplied?0:plan.inserts.length,
      updates:alreadyApplied?0:plan.updates.length,skipped:plan.skipped.length,databaseWrites:0,coverage:initial.coverage}));
    return;
  }
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'Could not load trusted Supabase CA');
  const ca = await response.text();
  assert.equal(checksum(ca), '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
  const client = new pg.Client({...config,ssl:{rejectUnauthorized:true,ca}});
  const dir = `reports/bnms-presentations/execution/${new Date().toISOString().replaceAll(':','-')}`;
  mkdirSync(dir,{recursive:true,mode:0o700});
  for (const path of [dir,`${dir}/..`,'reports/bnms-presentations','reports','.']) syncDirectory(path);
  const save = (name,value) => durableFile(`${dir}/${name}.json`, JSON.stringify(value,null,2));
  save('plan',{proposalChecksum:PROPOSAL_SHA,inputChecksum:SOURCE_SHA,tenantId:TENANT_ID,
    userApproval:'Complete the import now please and save the changes',
    scope:'Only previously proposed inserts and updates; all 87 blocked rows stay untouched. No taxonomy writes.',
    ...plan});
  save('before',initial);
  const fd = openSync(`${dir}/journal.jsonl`,'ax',0o600);
  syncDirectory(dir);
  const journal = entry => writeComplete(fd,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
  console.log(JSON.stringify({auditDirectory:dir,live:true,plannedInserts:plan.inserts.length,plannedUpdates:plan.updates.length}));
  try {
    await client.connect();
    const result = await applyApproved({client,bundle,journal});
    save('transaction-result',result);
    // Repeat the actual apply path: a successful second invocation must have zero DML.
    const replay = await applyApproved({client,bundle,journal});
    assert.equal(replay.writes,0,'Replay wrote records');
    const final = await readRest();
    const replaySummary = verifyApplied(bundle,final.snapshot);
    save('after',final);
    const verification = {status:result.status,tenantId:TENANT_ID,inserted:result.inserted,updated:result.updated,
      skipped:plan.skipped.length,databaseWrites:result.writes,replayWrites:replay.writes,
      initialResourceCount:initial.snapshot.resources.length,finalResourceCount:final.snapshot.resources.length,
      allExpectedFieldsVerified:true,allMemberOnlyAccessPreserved:true,existingTagsAndClassificationsPreserved:true,
      taxonomyUnchanged:true,coverage:final.coverage,replaySummary,proposalChecksum:PROPOSAL_SHA,inputChecksum:SOURCE_SHA};
    save('verification',verification);
    const records = bundle.report.rows.map(r=>({sourceRow:r.row,title:r.source.Title,
      action:r.status === 'insert' ? 'inserted' : r.status === 'update' ? 'updated' : 'skipped',
      resourceId:plan.inserts.find(p=>p.row === r.row)?.record.id ?? r.before?.id ?? '',
      issues:JSON.stringify(r.issues),isPublic:r.proposed.is_public,sourceUrl:r.url,
      releaseDate:r.proposed.release_date,coreChanges:JSON.stringify(r.coreChanges)}));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(Object.entries(verification).map(([metric,value])=>({
      metric,value:typeof value === 'object'?JSON.stringify(value):value,
    }))),'Verification');
    XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(records),'All source rows');
    XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(records.filter(r=>r.action === 'skipped')),'Skipped rows');
    XLSX.writeFile(book,`${dir}/execution-report.xlsx`,{compression:true});
    console.log(JSON.stringify({auditDirectory:dir,...verification}));
  } finally {
    closeSync(fd);
    await client.end();
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});