import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {connectDestination,PROJECT} from './annual-meeting-destination.mjs';
import {loadPublicPoBilling,generatePublicPoInvoice} from '../api/_lib/publicInvoicePoBilling.js';
const file='supabase/migrations/202612090007_public_po_approval_guard.sql';
const migration=await readFile(file,'utf8');
const digest=createHash('sha256').update(migration).digest('hex');
const args=process.argv.slice(2);
if(!args.includes('--apply')){
 console.log(JSON.stringify({destination:PROJECT,file,digest,writesPerformed:false}));process.exit(0);
}
assert.equal(args.length,4);
assert.ok(args.includes(`--review-sha256=${digest}`));
const tenant=args.find(a=>a.startsWith('--tenant='))?.slice(9);
const booking=args.find(a=>a.startsWith('--booking='))?.slice(10);
assert.match(tenant||'',/^[0-9a-f-]{36}$/);assert.match(booking||'',/^[0-9a-f-]{36}$/);
const sql=await connectDestination();
let committed=false;
try{
 // Capture the real application payload, but intercept every write.
 const real=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false}});
 let payload;
 const readonly={
  from(table){const q=real.from(table);
   for(const action of ['insert','update','upsert','delete'])q[action]=()=>{throw Error('REST writes forbidden during verification')};
   return q;
  },
  async rpc(name,p){assert.equal(name,'public_invoice_po_bill');payload=p;return {data:{status:'pending',queued:true},error:null}}
 };
 const preview=await loadPublicPoBilling(readonly,tenant,booking,false);
 assert.equal(preview.operation,null);assert.equal(preview.public.canGenerate,true);
 await generatePublicPoInvoice(readonly,tenant,'rollback-only-schema-verification',{
  bookingId:booking,isComplex:false,fingerprint:preview.public.fingerprint});
 assert.ok(payload);assert.equal(payload.p_provider,'xero');
 await sql.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
 const signature='public.public_invoice_po_bill(uuid,text,text,uuid,text,jsonb,numeric,text,text,jsonb)';
 const guard='public.guard_public_invoice_po_booking()';
 const before=(await sql.query(`SELECT oid::text,proacl::text,prosecdef,proconfig FROM pg_proc
   WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid`,[signature,guard])).rows;
 await sql.query(migration.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''));
 const after=(await sql.query(`SELECT oid::text,proacl::text,prosecdef,proconfig FROM pg_proc
   WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid`,[signature,guard])).rows;
 assert.deepEqual(after,before);
 const permissions=(await sql.query(`SELECT NOT has_function_privilege('anon',$1,'EXECUTE') a,
   NOT has_function_privilege('authenticated',$1,'EXECUTE') b,
   has_function_privilege('service_role',$1,'EXECUTE') c`,[signature])).rows[0];
 assert.ok(Object.values(permissions).every(Boolean));
 // Rehearse the exact failed approval without publishing a queue entry.
 // SQL changes are invisible to workers and rolled back before schema commit.
 await sql.query('SAVEPOINT rehearsal; SET LOCAL ROLE service_role');
 const values=[payload.p_tenant,payload.p_source,payload.p_group,payload.p_member,payload.p_actor,
  JSON.stringify(payload.p_original),payload.p_amount,payload.p_currency,payload.p_provider,JSON.stringify(payload.p_snapshot)];
 const invoke='SELECT public.public_invoice_po_bill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
 const result=(await sql.query(invoke,values)).rows[0].result;
 assert.equal(result.queued,true);
 assert.equal((await sql.query(invoke,values)).rows[0].result.id,result.id);
 const converted=(await sql.query('SELECT to_jsonb(b) row FROM booking b WHERE id=$1',[booking])).rows[0].row;
 assert.equal(converted.payment_method,'invoice');
 assert.equal(converted.public_invoice_po_billing_id,result.id);
 assert.deepEqual(converted.purchaser_context,preview.rows[0].purchaser_context);
 assert.equal(converted.payment_status,preview.rows[0].payment_status);
 const queue=(await sql.query(`SELECT status,snapshot->'settlement' settlement FROM event_invoice_recovery
  WHERE tenant_id=$1 AND source=$2 AND booking_group_reference=$3`,[tenant,payload.p_source,payload.p_group])).rows;
 assert.equal(queue.length,1);assert.equal(queue[0].status,'pending');assert.equal(queue[0].settlement,null);
 await sql.query('ROLLBACK TO SAVEPOINT rehearsal');
 const restored=(await sql.query('SELECT to_jsonb(b) row FROM booking b WHERE id=$1',[booking])).rows[0].row;
 assert.deepEqual(restored,preview.rows[0]);
 assert.equal((await sql.query('SELECT id FROM public_invoice_po_billing WHERE tenant_id=$1 AND source=$2 AND booking_group_reference=$3',
  [tenant,payload.p_source,payload.p_group])).rowCount,0);
 await sql.query("NOTIFY pgrst,'reload schema'; COMMIT");committed=true;
 console.log(JSON.stringify({applied:true,destination:PROJECT,digest,permissionsPreserved:true,
  realXeroQueuePayloadVerified:true,duplicateApprovalVerified:true,purchaserContextPreserved:true,
  rehearsalRolledBack:true,businessChangesCommitted:false,externalInvoicesCreated:false},null,2));
}catch(error){
 await sql.query('ROLLBACK').catch(()=>{});
 console.error(JSON.stringify({applied:committed,error:error.message,code:error.code,context:error.where}));
 process.exitCode=1;
}finally{await sql.end();}
