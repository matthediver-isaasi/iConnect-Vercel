// Owner-approved, exact-target display correction. No provider calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && args.every(a => ['--rehearse','--apply'].includes(a)));
const path = 'supabase/migrations/202701220002_form_cart_display_amendments.sql';
const migration = await readFile(path, 'utf8');
const hash = createHash('sha256').update(migration).digest('hex');
if (!args.length) { console.log(JSON.stringify({ offline:true,path,sha256:hash })); process.exit(0); }
const target = destinationTarget(process.env);
const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
assert.ok(caResponse.ok);
const db = new pg.Client({ connectionString:target.toString(), connectionTimeoutMillis:15000,
  ssl:{ ca:await caResponse.text(),rejectUnauthorized:true,servername:target.hostname } });
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const submission='c9537c37-2278-4dc9-b8ad-31bab1e895a7';
const oldId='68e75792-5c88-4eb1-8c52-ac32e20f7a6c',newId='024d5072-64cf-4be0-b1e1-bf1329d201c9';
async function run(apply) {
 await db.query('BEGIN');
 try {
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const installed=(await db.query("SELECT to_regclass('public.form_cart_display_amendment') installed")).rows[0].installed;
  if (!installed) await db.query(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
  const read = async (query,params=[]) => (await db.query(query,params)).rows.map(r=>r.row);
  const before=(await read('SELECT to_jsonb(s) row FROM form_submission s WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[submission,tenant]))[0];
  assert.equal(before.form_id,'56f11cfb-2ffa-4665-8294-a92943ca6700');
  const receipts=await read('SELECT to_jsonb(r) row FROM form_cart_receipt r WHERE submission_id=$1 AND tenant_id=$2 FOR UPDATE',[submission,tenant]);
  assert.equal(receipts.length,1);assert.equal(receipts[0].state,'consumed');
  const invoice=await read('SELECT to_jsonb(q) row FROM accounting_request_queue q WHERE source_id=$1 AND tenant_id=$2 FOR UPDATE',[submission,tenant]);
  assert.equal(invoice.length,1);assert.equal(invoice[0].state,'complete');
  const stock=await read('SELECT to_jsonb(s) row FROM form_bundle_stock s WHERE tenant_id=$1 AND bundle_id=ANY($2::uuid[]) ORDER BY bundle_id FOR UPDATE',[tenant,[oldId,newId]]);
  const names=await db.query('SELECT id,name FROM sales_catalogue_bundle WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,[oldId,newId]]);
  assert.equal(names.rows.find(r=>r.id===newId)?.name,'Silver Sponsor - Stand 49');
  const existing=(await db.query('SELECT * FROM form_cart_display_amendment WHERE tenant_id=$1 AND submission_id=$2',[tenant,submission])).rows;
  if (!existing.length) {
   assert.equal(before.submission_data.__cart_receipt.lines[0].id,oldId);
   await db.query(`INSERT INTO form_cart_display_amendment
     (tenant_id,submission_id,original_item_id,replacement_item_id,original_name,replacement_name,reason,approved_by)
     VALUES($1,$2,$3,$4,'Silver Sponsor - Stand 48','Silver Sponsor - Stand 49',
     'Owner-approved stand correction; Xero and stock adjusted separately by owner.','Project owner approval in chat')`,
     [tenant,submission,oldId,newId]);
  } else {
   assert.equal(existing.length,1);assert.equal(existing[0].original_item_id,oldId);assert.equal(existing[0].replacement_item_id,newId);
  }
  await db.query('UPDATE form_submission SET submission_data=submission_data WHERE id=$1 AND tenant_id=$2',[submission,tenant]);
  const after=(await read('SELECT to_jsonb(s) row FROM form_submission s WHERE id=$1',[submission]))[0];
  const corrected=after.submission_data.__cart_receipt.lines[0];
  assert.equal(corrected.id,newId);assert.equal(corrected.name,'Silver Sponsor - Stand 49');
  assert.equal(corrected.amendment.originalItemId,oldId);
  const expected=structuredClone(receipts[0].terms);
  expected.lines[0]={...expected.lines[0],id:newId,name:'Silver Sponsor - Stand 49',amendment:corrected.amendment};
  assert.deepEqual(after.submission_data.__cart_receipt,expected);
  // Preserve every field except the display projection and generic update timestamp.
  for (const key of ['updated_at','updated_date']) { delete before[key];delete after[key]; }
  before.submission_data.__cart_receipt=after.submission_data.__cart_receipt;
  assert.deepEqual(after,before);
  assert.deepEqual(await read('SELECT to_jsonb(r) row FROM form_cart_receipt r WHERE submission_id=$1 AND tenant_id=$2',[submission,tenant]),receipts);
  assert.deepEqual(await read('SELECT to_jsonb(q) row FROM accounting_request_queue q WHERE source_id=$1 AND tenant_id=$2',[submission,tenant]),invoice);
  assert.deepEqual(await read('SELECT to_jsonb(s) row FROM form_bundle_stock s WHERE tenant_id=$1 AND bundle_id=ANY($2::uuid[]) ORDER BY bundle_id',[tenant,[oldId,newId]]),stock);
  // Confirm ordinary later updates do not restore the old display.
  await db.query('UPDATE form_submission SET submission_data=submission_data WHERE id=$1',[submission]);
  assert.deepEqual((await read('SELECT to_jsonb(s.submission_data) row FROM form_submission s WHERE id=$1',[submission]))[0],after.submission_data);
  const grants=(await db.query(`SELECT has_table_privilege('authenticated','public.form_cart_display_amendment','INSERT') bad,
    has_table_privilege('service_role','public.form_cart_display_amendment','UPDATE') bad_service`)).rows[0];
  assert.equal(grants.bad,false);assert.equal(grants.bad_service,false);
  await db.query(apply?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({applied:apply,rehearsed:!apply,sha256:hash,display:'Stand 49',originalEvidencePreserved:true,stockAndInvoiceUnchanged:true}));
 } catch(e) { await db.query('ROLLBACK').catch(()=>{});throw e; }
}
try {
 await db.connect();assert.ok(db.connection.stream.authorized);
 await run(false);
 if(args[0]==='--apply') await run(true);
} catch(e) { console.error(JSON.stringify({error:e.message,code:e.code}));process.exitCode=1; }
finally { await db.end(); }
