// Owner-approved, request-scoped transition. Never edits financial queue evidence.
import {readFile} from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
import {bnmsOctoberRecovery} from '../api/_lib/accountingBnmsOctoberRecovery.js';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const company='3d57dce6-2205-462f-abf6-9c7cbf00be23';
const previous='cfcc622c-492c-440e-a7bc-1a5f4704c27e';
const current='ae863481-7552-454d-886a-d3fb54f9cbc0';
const db=await connectDestination();
try{
  await db.query('BEGIN');
  const connection=await db.query(`SELECT t.id FROM xero_token t JOIN tenant_accounting_settings s
    ON s.tenant_id=t.app_tenant_id WHERE t.app_tenant_id=$1 AND t.id::text=$2
    AND t.tenant_id::text=$3 AND s.active_provider='xero' FOR SHARE OF t,s`,[tenant,current,company]);
  if(connection.rowCount!==1)throw Error('Approved connection is not current');
  await db.query(await readFile('supabase/migrations/202612060001_accounting_reconnect_approval.sql','utf8'));
  const candidates=(await db.query(`SELECT to_jsonb(q) data FROM accounting_request_queue q
    WHERE tenant_id=$1 AND provider='xero' AND company_id=$2 AND connection_id=$3
      AND state='review' AND preparation_status='pending'
      AND invoice_status='pending' AND payment_status='pending' AND link_status='pending'
      AND invoice_result IS NULL AND payment_result IS NULL AND resolved_snapshot IS NULL
      AND last_error IN ('ACCOUNTING_PREPARATION_NOT_COMPLETED','ACCOUNTING_BINDING_OR_ADAPTER_UNAVAILABLE')
    FOR UPDATE`,[tenant,company,previous])).rows;
  let approved=0,held=0;
  for(const {data:row} of candidates){
    let eligible=false;
    if(row.operation==='invoice'&&row.source_type==='stripe_member_quote')eligible=true;
    else try{
      const r=bnmsOctoberRecovery(row);
      if(r){
        const prior=await db.query(`SELECT id FROM ${r.prefix}_invoice_operations WHERE tenant_id=$1 AND payment_id=$2`,
          [tenant,r.payment.gocardless_payment_id]);
        eligible=prior.rowCount===0;
      }
    }catch{/* Other ownership/uncertain-write cases remain held. */}
    if(!eligible){held++;continue;}
    const inserted=await db.query(`INSERT INTO accounting_reconnect_approval
      (request_id,tenant_id,provider,company_id,previous_connection_id,new_connection_id,reason)
      VALUES($1,$2,'xero',$3,$4,$5,$6) ON CONFLICT(request_id) DO NOTHING`,
      [row.id,tenant,company,previous,current,'Owner approved same-organisation reconnection and guarded recovery on 2026-11-04']);
    approved+=inserted.rowCount;
    const exact=await db.query(`SELECT request_id FROM accounting_reconnect_approval WHERE request_id=$1
      AND tenant_id=$2 AND company_id=$3 AND previous_connection_id=$4 AND new_connection_id=$5 AND revoked_at IS NULL`,
      [row.id,tenant,company,previous,current]);
    if(exact.rowCount!==1)throw Error('Conflicting prior approval');
  }
  for(const role of ['anon','authenticated','service_role']){
    const rights=(await db.query(`SELECT has_table_privilege($1,'public.accounting_reconnect_approval','SELECT') can_read,
      has_table_privilege($1,'public.accounting_reconnect_approval','INSERT,UPDATE,DELETE') can_write`,[role])).rows[0];
    if(rights.can_write||rights.can_read!==(role==='service_role'))throw Error('Unexpected approval privileges');
  }
  await db.query('COMMIT');
  console.log(JSON.stringify({approved,held,protectionsVerified:true}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
