// Default is a read-only preflight. --apply is an explicit operator action,
// after send workers have been quiesced and the rollout approved.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { DESTINATION_PROJECT_REF, isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

export const MIGRATION = 'supabase/migrations/20261018_campaign_inbox_delivery_mode.sql';

export async function run({ apply = false, env = process.env } = {}) {
  if (!isApprovedDestinationSupabaseTarget(env.DEST_DATABASE_URL, env.DEST_SUPABASE_URL)) {
    throw new Error('Destination pin mismatch; no database changed.');
  }
  const url = new URL(env.DEST_DATABASE_URL);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Could not download destination CA');
  const client = new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: url.hostname },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout='10s'; SET statement_timeout='120s'");
    await client.query('BEGIN READ ONLY');
    const schema = (await client.query(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='email_campaign' AND column_name='is_test_mode') AS campaign_flag,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
        AND table_name='email_campaign_recipient' AND column_name='delivery_is_test') AS recipient_mode,
      to_regclass('public.campaign_inbox_recipient') IS NOT NULL AS inbox_view,
      to_regprocedure('public.campaign_inbox_unread_summary(uuid,uuid)') IS NOT NULL AS unread_summary
    `)).rows[0];
    if (!schema.campaign_flag) throw new Error('Prerequisite email_campaign.is_test_mode is missing');
    const evidence = (await client.query(`SELECT
      count(*) FILTER (WHERE c.is_test_mode IS TRUE) AS current_test_flag,
      count(*) FILTER (WHERE c.is_test_mode IS FALSE) AS current_live_flag,
      count(*) FILTER (WHERE c.is_test_mode IS NULL) AS legacy_null_flag
      FROM public.email_campaign_recipient r JOIN public.email_campaign c ON c.id=r.campaign_id
      WHERE r.sent_at IS NOT NULL OR r.mailgun_message_id IS NOT NULL OR r.status='processing'
    `)).rows[0];
    const active = (await client.query("SELECT count(*) AS count FROM public.email_campaign WHERE status IN ('sending','preparing')")).rows[0];
    await client.query('COMMIT');
    console.log(JSON.stringify({ target: DESTINATION_PROJECT_REF, mode: apply ? 'apply' : 'read-only', schema, evidence, activeCampaigns: active.count }));
    if (apply) {
      if (Number(active.count)) throw new Error('Quiesce campaign send/preparation workers before applying');
      await client.query(await readFile(MIGRATION, 'utf8'));
      const verified = (await client.query(`SELECT
        has_table_privilege('service_role','public.campaign_inbox_recipient','SELECT') AS service_view,
        NOT has_table_privilege('authenticated','public.campaign_inbox_recipient','SELECT') AS browser_denied,
        has_function_privilege('service_role','public.campaign_inbox_unread_summary(uuid,uuid)','EXECUTE') AS service_summary,
        NOT has_function_privilege('authenticated','public.campaign_inbox_unread_summary(uuid,uuid)','EXECUTE') AS browser_summary_denied
      `)).rows[0];
      if (!Object.values(verified).every(Boolean)) throw new Error('Migration applied but grants verification failed');
      console.log(`Applied and verified ${MIGRATION} on pinned DEST ${DESTINATION_PROJECT_REF}. SOURCE unchanged.`);
    } else {
      console.log('Read-only preflight complete; no migration applied. Historical mode before flag edits cannot be inferred from these counts.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ apply: process.argv.includes('--apply') }).catch(error => {
    console.error('Campaign inbox migration stopped:', error.code || 'error', String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'));
    process.exitCode = 1;
  });
}
