import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { main, runTransaction } from './apply-simple-event-total-capacity.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {
  migrationPath,reviewedHash,migrationBody,preservation,state,expectedPatches,
} from './lib/simpleEventCapacityRollout.mjs';

const sql = await readFile(migrationPath,'utf8');
const env = {
  DEST_SUPABASE_URL:'https://lvmzliemqnieeoruhkik.supabase.co',
  DEST_DATABASE_URL:'postgresql://postgres.lvmzliemqnieeoruhkik:fixture@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require',
};

test('exact merged SQL is pinned; only its outer transaction can be removed', () => {
  const body = migrationBody(sql);
  assert.doesNotMatch(body,/^BEGIN;|^COMMIT;$/m);
  assert.equal(`BEGIN;\n${body}`.includes('NOTIFY pgrst,\'reload schema\';'),true);
  assert.match(body,/DO \$patch\$/);
  assert.match(body,/DO \$locks\$/);
  assert.match(body,/BEGIN\n/);
  assert.throws(() => migrationBody(sql+'\nCOMMIT;'),/Reviewed migration changed/);
  assert.throws(() => migrationBody(sql.replace('BEGIN;','COMMIT;')),/Reviewed migration changed/);
});

test('offline and hash/argument rejection never reach credentials or networking',async () => {
  const output = [];
  const previous = console.log;
  console.log = line => output.push(JSON.parse(line));
  try { await main([],{}); } finally { console.log=previous; }
  assert.equal(output[0].sha256,reviewedHash);
  assert.equal(output[0].writesPerformed,false);
  await assert.rejects(main(['--apply'],env),/Reviewed migration SHA-256 required/);
  await assert.rejects(main(['--rehearse',`--review-sha256=${'0'.repeat(64)}`],env),/Reviewed migration SHA-256 required/);
  await assert.rejects(main(['--apply','--verify'],env),/Invalid arguments/);
  await assert.rejects(main(['--apply','--apply'],env),/Invalid arguments/);
  await assert.rejects(main(['--unrelated'],env),/Invalid arguments/);
  await assert.rejects(main(['--apply',`--review-sha256=${reviewedHash}`],{}),/Pinned destination credentials/);
});

test('destination pins reject source fallback, overriding parameters and unapproved ports', () => {
  assert.equal(destinationTarget(env).search,'');
  for (const change of [
    {DEST_SUPABASE_URL:'https://other.supabase.co'},
    {DEST_DATABASE_URL:env.DEST_DATABASE_URL.replace('5432','6543')},
    {DEST_DATABASE_URL:env.DEST_DATABASE_URL+'&host=other.example'},
    {DEST_DATABASE_URL:env.DEST_DATABASE_URL.replace('postgres.lvmzliemqnieeoruhkik','postgres.other')},
  ]) assert.throws(() => destinationTarget({...env,...change}));
  assert.throws(() => destinationTarget({DATABASE_URL:env.DEST_DATABASE_URL}));
});

test('preservation checks all existing capacity values and row versions without conversion', () => {
  const before=[{id:'fixture',available_seats:'146',pricing_config:{ticket_classes:[]},
    is_unlimited_registration:false,capacity_mode:null,total_capacity:null,row_version:'42'}];
  const after=before.map(r => ({...r,capacity_mode:'legacy'}));
  assert.equal(preservation(before,after,true).unchanged,true);
  for (const patch of [
    {available_seats:'145'}, {row_version:'43'}, {capacity_mode:'total'},
    {total_capacity:146}, {pricing_config:{}}, {is_unlimited_registration:true},
  ]) assert.throws(() => preservation(before,[{...after[0],...patch}],true),/Existing event settings/);
  assert.equal(preservation(after,after,false).events,1);
});

test('absent, present and partial states cannot cause blind replay',async () => {
  const fake = (columns, fns=[], triggers=[]) => ({
    query:async query => ({rows: query.includes('information_schema') ? columns :
      query.includes('FROM pg_proc') ? fns : triggers}),
  });
  assert.equal(await state(fake([])),'absent');
  await assert.rejects(state(fake([{column_name:'capacity_mode'}])),/Partial/);
  await assert.rejects(state(fake([],[{name:'sales_capacity_state',source:'PERFORM capacity_event.id'}])),/Partial/);
  const queries=[];
  const db={query:async query => { queries.push(query); return {rows:
    query.includes('information_schema') ? [{column_name:'capacity_mode'}] : []}; }};
  await assert.rejects(runTransaction(db,'--apply',sql),/Partial/);
  assert.equal(queries.at(-1),'ROLLBACK');
  assert.ok(!queries.some(q => q.includes('ALTER TABLE')));
  assert.ok(!queries.includes('COMMIT'));
});

test('missing and overloaded patch targets fail before DDL', () => {
  assert.throws(() => expectedPatches(sql,[]),/missing\/overloaded/);
  assert.throws(() => expectedPatches(sql,[
    {name:'sales_capacity_state'},{name:'sales_capacity_state'},
  ]),/missing\/overloaded/);
});

test('runner never submits the embedded COMMIT or invokes a live booking writer',async () => {
  const script=await readFile('scripts/apply-simple-event-total-capacity.mjs','utf8');
  assert.match(script,/rejectUnauthorized:true,ca,servername:target.hostname/);
  assert.match(script,/stream.encrypted && db.connection.stream.authorized/);
  assert.match(script,/runTransaction\(db, '--rehearse', sql\)/);
  assert.match(script,/db.query\(migrationBody\(sql\)\)/);
  assert.doesNotMatch(script,/db.query\(sql\)/);
  assert.match(script,/LOCK TABLE public.event IN ACCESS EXCLUSIVE MODE/);
  assert.match(script,/lock_timeout='5s'/);
  assert.match(script,/statement_timeout='60s'/);
  assert.doesNotMatch(script,/SOURCE_|process.env.DATABASE_URL|INSERT INTO public|UPDATE public|DELETE FROM public/);
  assert.doesNotMatch(script,/SELECT public\.(insert_|confirm_|claim_|cancel_|reserve_)/);
});
