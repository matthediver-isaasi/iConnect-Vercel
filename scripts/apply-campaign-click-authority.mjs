import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

const migration='supabase/migrations/20261211_campaign_click_authority.sql';
const sql=await readFile(migration,'utf8');
const sha256=createHash('sha256').update(sql).digest('hex');
const args=process.argv.slice(2);
if(!args.length) {
  console.log(JSON.stringify({dryRun:true,migration,sha256,destination:'lvmzliemqnieeoruhkik'}));
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
  try {
    await db.connect();
    await db.query(inspect?'BEGIN READ ONLY':'BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const before=(await db.query(`SELECT
      (SELECT count(*) FROM public.email_campaign_recipient) AS recipients,
      (SELECT count(*) FROM public.email_link_click) AS link_evidence,
      (SELECT count(*) FROM public.email_event WHERE event_type='clicked') AS provider_evidence`)).rows[0];
    if(inspect) {
      const triggers=(await db.query(`SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger
        WHERE tgrelid='public.email_campaign_recipient'::regclass AND NOT tgisinternal`)).rows;
      console.log(JSON.stringify({destination:'lvmzliemqnieeoruhkik',before,triggers}));
    }
    else {
      // Keep verification and migration in the same outer transaction.
      await db.query(sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''));
      const checks=(await db.query(`SELECT
        NOT EXISTS (SELECT 1 FROM public.email_campaign_recipient r LEFT JOIN
          (SELECT recipient_id,count(*) n FROM public.email_counted_link_click GROUP BY recipient_id) l
          ON l.recipient_id=r.id WHERE r.click_count IS DISTINCT FROM coalesce(l.n,0)) AS recipient_counts,
        NOT EXISTS (SELECT 1 FROM public.email_campaign c LEFT JOIN
          (SELECT campaign_id,count(*) n FROM public.email_campaign_recipient WHERE click_count>0 GROUP BY campaign_id) r
          ON r.campaign_id=c.id WHERE c.clicked_count IS DISTINCT FROM coalesce(r.n,0)) AS unique_counts,
        NOT has_table_privilege('anon','public.email_counted_link_click','SELECT') AS view_private,
        NOT has_table_privilege('authenticated','public.email_link_click','INSERT') AS writes_private,
        has_table_privilege('service_role','public.email_counted_link_click','SELECT') AS service_read,
        (SELECT count(*) FROM public.email_link_click)=$1::bigint AS raw_links_preserved,
        (SELECT count(*) FROM public.email_event WHERE event_type='clicked')=$2::bigint AS raw_provider_preserved`,
        [before.link_evidence,before.provider_evidence])).rows[0];
      if(Object.values(checks).some(v=>v!==true))throw new Error('Click authority verification failed');
      console.log(JSON.stringify({applied:true,sha256,destination:'lvmzliemqnieeoruhkik',before,checks,sourceUntouched:true}));
    }
    await db.query('COMMIT');
  } catch(error) {
    await db.query('ROLLBACK').catch(()=>{});
    console.error(`Destination operation failed (${error.code||'validation'}); transaction not committed.`);
    process.exitCode=1;
  } finally {await db.end();}
}
