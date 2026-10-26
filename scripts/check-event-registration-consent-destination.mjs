// Read-only DEST preflight. Does not apply migrations or access customer rows.
import pg from 'pg';
const project = 'lvmzliemqnieeoruhkik';
let client;
try {
  if (new URL(process.env.DEST_SUPABASE_URL).hostname !== `${project}.supabase.co`) throw new Error('Destination mismatch');
  const url = new URL(process.env.DEST_DATABASE_URL);
  if (!['aws-1-eu-central-1.pooler.supabase.com',`db.${project}.supabase.co`].includes(url.hostname)
      || (url.port && url.port !== '5432')
      || (url.hostname.includes('.pooler.') && !decodeURIComponent(url.username).endsWith(`.${project}`)))
    throw new Error('Destination mismatch');
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('CA unavailable');
  const ca = await response.text();
  client = new pg.Client({ connectionString:url.toString(),connectionTimeoutMillis:15000,
    ssl:{rejectUnauthorized:true,ca,servername:url.hostname} });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const result = await client.query(`select
    to_regclass('public.event_registration_communication') is not null as configuration_exists,
    to_regclass('public.event_registration_consent') is not null as consent_exists,
    to_regprocedure('public.set_email_preference_category_state(uuid,text,uuid,uuid,boolean,uuid)') is not null as atomic_consent_exists,
    to_regclass('public.communication_category_role') is not null as role_rules_exist,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='communication_category' and column_name='system_key') as special_category_column_exists`);
  await client.query('ROLLBACK');
  console.log(JSON.stringify({ project,readOnly:true,writesPerformed:false,...result.rows[0] },null,2));
} catch (error) {
  console.error(JSON.stringify({project,readOnly:true,writesPerformed:false,error:'Destination preflight unavailable',code:error.code || null}));
  process.exitCode=1;
} finally { await client?.end(); }
