// Explicitly approved BNMS recovery. Defaults to a no-write scope check.
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {connectDestination}=await import('./lib/member-index-destination.mjs');
const {supabase}=await import('../api/_lib/database.js');
const {bnmsOctoberRecovery}=await import('../api/_lib/accountingBnmsOctoberRecovery.js');
const {processAccountingRequest}=await import('../api/_lib/accountingRequestQueue.js');
const sql=await connectDestination();
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const apply=process.argv.includes('--apply');
const limit=Number(process.argv.find(x=>x.startsWith('--limit='))?.split('=')[1]||4);
if(!Number.isInteger(limit)||limit<1||limit>264)throw Error('Invalid limit');
try{
  const rows=(await sql.query(`SELECT to_jsonb(q) data FROM accounting_request_queue q
    WHERE tenant_id=$1 AND state='review' AND preparation_status='pending'
      AND invoice_status='pending' AND payment_status='pending' AND link_status='pending'
      AND invoice_result IS NULL AND payment_result IS NULL AND resolved_snapshot IS NULL
      AND last_error='ACCOUNTING_PREPARATION_NOT_COMPLETED'
    ORDER BY CASE WHEN id='657b8d61-2566-44c3-8305-201acdd1425f' THEN 0
      WHEN source_type='stripe_member_quote' THEN 1 ELSE 2 END,created_at,id`,[tenant])).rows.map(x=>x.data);
  const eligible=[],held={};
  for(const row of rows){
    try{
      if(row.provider!=='xero'||row.operation!=='invoice')throw Error('NOT_SUPPORTED');
      if(row.source_type!=='stripe_member_quote'){
        const recovery=bnmsOctoberRecovery(row);
        if(!recovery)throw Error('NO_APPROVED_IMPORTED_AUTHORITY');
        const prior=await sql.query(`SELECT id FROM ${recovery.prefix}_invoice_operations WHERE tenant_id=$1 AND payment_id=$2`,
          [tenant,recovery.payment.gocardless_payment_id]);
        if(prior.rowCount)throw Error('PRIOR_OPERATION_REQUIRES_REVIEW');
      }
      eligible.push(row);
    }catch(e){const key=e.code||e.message;held[key]=(held[key]||0)+1;}
  }
  console.log(JSON.stringify({mode:apply?'apply':'preview',eligible:eligible.length,held}));
  if(apply)for(const row of eligible.slice(0,limit)){
    let claimed;
    await sql.query('BEGIN');
    try{
      await sql.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`);
      const changed=await sql.query(`UPDATE accounting_request_queue SET state='pending',next_attempt_at=now(),last_error=NULL,updated_at=now()
        WHERE id=$1 AND state='review' AND updated_at=$2::timestamptz
        AND invoice_result IS NULL AND payment_result IS NULL AND resolved_snapshot IS NULL RETURNING id`,[row.id,row.updated_at]);
      if(changed.rowCount!==1)throw Error('Record changed; not released');
      claimed=(await sql.query('SELECT to_jsonb(public.accounting_request_claim($1::uuid)) data',[row.id])).rows[0].data;
      if(!claimed?.id){await sql.query('ROLLBACK');console.log(JSON.stringify({id:row.id,status:'not_claimable_cooldown_or_busy'}));break;}
      await sql.query('COMMIT');
    }catch(e){await sql.query('ROLLBACK');throw e;}
    let consumed=false;
    const db={from:supabase.from.bind(supabase),rpc(name,args){
      if(name==='accounting_request_claim'&&!consumed){consumed=true;return Promise.resolve({data:claimed,error:null});}
      return supabase.rpc(name,args);
    }};
    let result=await processAccountingRequest({db,requestId:row.id});
    for(let attempt=0;result?.state==='retry'&&attempt<3;attempt++){
      const binding=(await sql.query('SELECT cooldown_until FROM accounting_request_binding WHERE provider=$1 AND company_id=$2',
        [row.provider,row.company_id])).rows[0];
      const until=Math.max(Date.parse(result.next_attempt_at)||0,Date.parse(binding?.cooldown_until)||0);
      const wait=Math.max(1000,until-Date.now()+500);
      if(wait>120000)break;
      await new Promise(resolve=>setTimeout(resolve,wait));
      result=await processAccountingRequest({db:supabase,requestId:row.id});
    }
    console.log(JSON.stringify({id:row.id,state:result?.state,error:result?.last_error,
      invoice:result?.invoice_result?.invoiceNumber||null}));
    if(result?.state==='retry'||result?.state==='unknown')break;
  }
}finally{await sql.end();}
