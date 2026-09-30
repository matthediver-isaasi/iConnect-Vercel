// Explicitly read-only verification through the actual shared runtime projection.
import { open } from 'node:fs/promises';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const { destinationConnection }=await import('./run-bnms-dd-pilot-history.mjs');
const { createClient }=await import('@supabase/supabase-js');
const { loadDirectDebitMembershipPresentations,directDebitCollectionPresentation }=
  await import('../api/_lib/directDebitMembershipPresentation.js');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const asOf=new Date().toISOString().slice(0,10);
const report=await open(`exports/bnms-beta-pilot-recognition-runtime-verification-${asOf}.json`,'wx',0o600);
let c;
try {
  c=await destinationConnection(); await c.connect(); await c.query('BEGIN READ ONLY');
  const plans=(await c.query(`WITH cohort AS (
    SELECT plan_id FROM bnms_dd_alpha_adoption WHERE tenant_id=$1
    UNION ALL SELECT plan_id FROM bnms_dd_beta_adoption WHERE tenant_id=$1
    UNION ALL SELECT plan_id FROM bnms_dd_pilot_adoption WHERE tenant_id=$1)
    SELECT to_jsonb(p) plan FROM cohort a JOIN membership_payment_plans p ON p.id=a.plan_id
    WHERE p.tenant_id=$1 ORDER BY p.id`,[tenant])).rows.map(r=>r.plan);
  const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false}});
  const presentations=await loadDirectDebitMembershipPresentations(db,tenant,plans,asOf);
  const values=[...presentations.values()];
  const result={target:'lvmzliemqnieeoruhkik',asOf,plans:plans.length,
    current:values.filter(p=>p.displayStatus==='current').length,
    pending:values.filter(p=>p.pendingActivation).length,
    unverified:values.filter(p=>p.displayStatus==='membership_unverified').length,
    held:plans.filter(p=>directDebitCollectionPresentation(p).held).length,
    unheld:plans.filter(p=>!directDebitCollectionPresentation(p).held).length,
    recognitionEvidence:values.filter(p=>p.evidence?.source==='administrative_recognition').length,
    databaseWrites:0,providerRequests:0,deployed:false};
  await c.query('ROLLBACK');
  await report.writeFile(JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(result.plans!==260||result.current!==260||result.held!==259||result.unheld!==1
    ||result.pending||result.unverified||result.recognitionEvidence!==260) process.exitCode=1;
} catch(error) {
  await c?.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({error:'Read-only runtime recognition verification failed',code:error.code}));
  process.exitCode=1;
} finally { await report.close(); await c?.end(); }