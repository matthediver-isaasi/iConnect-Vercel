import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliverFunnelCreditEmails} from './eventFunnelCreditEmail.js';
export async function exerciseFunnelCreditEmails({db}){
  for(const provider of ['xero','quickbooks']){
    const job=(await db.query(`SELECT * FROM event_funnel_credit_work WHERE status='complete'
      AND snapshot->>'provider'=$1 LIMIT 1`,[provider])).rows[0];
    assert.ok(job,`An issued ${provider} credit fixture is required`);
    // Earlier tests created accepted financial-only cancellation fixtures.
    // Attach explicit reviewer email authority only inside this rolled-back
    // fixture transaction. Never infer or backfill real approval recipients.
    await db.query('BEGIN');
    try{
      await db.query(`UPDATE event_funnel_reversal SET requires_cleanup=true,state='reserved',
        refund_options='{"voucherReplacements":[]}',lease_id=NULL,lease_until=NULL,next_attempt_at=now()
        WHERE id=$1`,[job.reversal_id]);
      await db.query(`INSERT INTO event_funnel_cancellation_cleanup(tenant_id,order_id,reversal_id,snapshot)
        VALUES($1,$2,$3,$4)`,[job.tenant_id,job.order_id,job.reversal_id,
        {authority:{suppressEmails:true,creditNoteEmail:'approved@example.test'}}]);
      await db.query('SET LOCAL ROLE service_role');
      const claim=(await db.query('SELECT event_funnel_reversal_claim($1,$2) r',[job.tenant_id,job.reversal_id])).rows[0].r;
      assert.ok(claim);
      const call=async(action,id=null,payload=null,token=claim.lease_id)=>(await db.query(
        'SELECT event_funnel_credit_email_operation($1,$2,$3,$4,$5,$6,$7) r',
        [job.tenant_id,job.order_id,job.reversal_id,token,action,id,payload])).rows[0].r;
      const plan=await call('read');assert.ok(plan.jobs.length);
      const message=plan.jobs[0];assert.equal(message.recipient,'approved@example.test');
      assert.equal(message.snapshot.receipt.creditNoteId,job.receipt.creditNoteId);
      await db.query('SAVEPOINT invalid_lease');
      await assert.rejects(call('read',null,null,randomUUID()),{code:'PT409'});
      await db.query('ROLLBACK TO SAVEPOINT invalid_lease');
      const envelope={tenantId:job.tenant_id,to:message.recipient,subject:'Fixture',html:'Fixture',
        attachments:[{filename:'fixture.pdf',base64:Buffer.from('%PDF-1.4\nFixture').toString('base64'),contentType:'application/pdf'}]};
      assert.equal((await call('begin',message.id,envelope)).status,'send');
      await call('finish',message.id,{outcome:'unknown'});
      assert.equal((await call('begin',message.id,envelope)).status,'needs_review');
      assert.equal((await call('read')).status,'needs_review');
    }finally{await db.query('ROLLBACK');}
    // Exercise the real delivery adapter against the SQL journal, starting
    // again from the rolled-back fixture rather than resetting uncertain sends.
    await db.query('BEGIN');
    try{
      await db.query(`UPDATE event_funnel_reversal SET requires_cleanup=true,state='processing',
        refund_options='{"voucherReplacements":[]}',lease_id=$2,lease_until=now()+interval '2 minutes'
        WHERE id=$1`,[job.reversal_id,randomUUID()]);
      await db.query(`INSERT INTO event_funnel_cancellation_cleanup(tenant_id,order_id,reversal_id,snapshot)
        VALUES($1,$2,$3,$4)`,[job.tenant_id,job.order_id,job.reversal_id,
        {authority:{suppressEmails:true,creditNoteEmail:'approved@example.test'}}]);
      const operation=(await db.query('SELECT * FROM event_funnel_reversal WHERE id=$1',[job.reversal_id])).rows[0];
      const adapter={rpc:async(name,args)=>{
        assert.equal(name,'event_funnel_credit_email_operation');
        return {data:(await db.query('SELECT event_funnel_credit_email_operation($1,$2,$3,$4,$5,$6,$7) r',
          [args.p_tenant,args.p_order,args.p_reversal,args.p_lease,args.p_action,args.p_message,args.p_payload])).rows[0].r};
      }};
      let sends=0;
      await db.query('SET LOCAL ROLE service_role');
      const args={db:adapter,context:{order:{id:job.order_id,tenant_id:job.tenant_id},operation},
        loadPdf:async()=>Buffer.from('%PDF-1.4\nIsolated fixture'),
        send:async()=>{sends++;return {success:true,messageId:'fixture-mail'};}};
      assert.equal((await deliverFunnelCreditEmails(args)).status,'complete');
      assert.equal((await deliverFunnelCreditEmails(args)).status,'complete');
      assert.equal(sends,1);
      await db.query('RESET ROLE');
      assert.equal((await db.query('SELECT event_funnel_credit_email_ready($1) ok',[job.reversal_id])).rows[0].ok,true);
    }finally{await db.query('ROLLBACK');}
  }
}
