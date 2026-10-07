import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

const sql=await readFile('supabase/migrations/20261210_form_submission_alerts.sql','utf8');
const sha256=createHash('sha256').update(sql).digest('hex');
const args=process.argv.slice(2);
if(!args.length) {
  console.log(JSON.stringify({dryRun:true,sha256,destination:'lvmzliemqnieeoruhkik'}));
} else {
  const inspect=args.length===1&&args[0]==='--inspect';
  if(!inspect && (args.length!==2||!args.includes('--apply')||!args.includes(`--review-sha256=${sha256}`))) {
    throw new Error('Review the current offline SHA before applying; no database was changed');
  }
  const target=destinationTarget(process.env);
  const ca=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if(!ca.ok)throw new Error('Verified destination certificate unavailable');
  const db=new pg.Client({connectionString:target.toString(),ssl:{rejectUnauthorized:true,
    ca:await ca.text(),servername:target.hostname}});
  let result;
  try {
    await db.connect();
    await db.query(inspect?'BEGIN READ ONLY':'BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const columns=(await db.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('form','form_submission','survey_version','form_due_diligence_one_off_ready')
      AND column_name IN ('id','tenant_id','form_id','form_submission_id','fields','name','survey_settings','created_date',
        'payment_meta','payment_status','submission_email_state','survey_version_id','survey_assignment_id')
      ORDER BY 1,2`)).rows;
    if(inspect)result={destination:'lvmzliemqnieeoruhkik',columns};
    else {
      await db.query(sql);
      const grants=(await db.query(`SELECT
        NOT has_table_privilege('anon','public.form_alert_delivery','SELECT') AS anonymous_private,
        NOT has_table_privilege('authenticated','public.form_alert_settings','SELECT') AS settings_private,
        NOT has_table_privilege('authenticated','public.form_alert_submission_snapshot','SELECT') AS snapshot_private,
        NOT has_function_privilege('authenticated','public.claim_form_submission_alert(uuid,uuid,text)','EXECUTE') AS claims_private,
        NOT has_function_privilege('anon','public.revoke_form_submission_alerts(uuid,uuid,uuid)','EXECUTE') AS revoke_private,
        has_function_privilege('service_role','public.limit_form_alert_reads(text)','EXECUTE') AS service_rate_limit`)).rows[0];
      // Four private tables are created; keep verification explicit rather than
      // depending on a project's default privilege settings.
      grants.rls=(await db.query(`SELECT count(*)=4 AS ok FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('form_alert_settings','form_alert_delivery',
          'form_alert_submission_snapshot','form_alert_read_limit') AND c.relrowsecurity`)).rows[0].ok;
      if(Object.values(grants).some(value=>value!==true))throw new Error('Private-grant verification failed');
      await db.query("NOTIFY pgrst, 'reload schema'");
      result={applied:true,sha256,destination:'lvmzliemqnieeoruhkik',grants,sourceUntouched:true};
    }
    await db.query('COMMIT');
    console.log(JSON.stringify(result));
  } catch(error) {
    await db.query('ROLLBACK').catch(()=>{});
    console.error(`Destination operation failed (${error.code||'validation'}); transaction not committed.`);
    process.exitCode=1;
  } finally {await db.end();}
}
