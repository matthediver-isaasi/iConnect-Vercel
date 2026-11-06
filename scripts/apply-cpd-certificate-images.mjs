// Destination-only schema runner. Default read-only; explicit hash approval
// required to apply. Does not create templates, certificates or customer data.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isApprovedDestinationSupabaseTarget, DESTINATION_PROJECT_REF } from './lib/destinationSupabaseTarget.mjs';
const lifecycle=process.argv.includes('--lifecycle');
const file=`supabase/migrations/${lifecycle ? '202701190003_cpd_certificate_image_cleanup.sql' : '202701190002_cpd_certificate_images.sql'}`;
const migration=await readFile(file,'utf8');
const sha=createHash('sha256').update(migration).digest('hex');
console.log(JSON.stringify({file,sha256:sha}));
if (process.argv.includes('--offline')) process.exit(0);
if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL,process.env.DEST_SUPABASE_URL)) throw new Error('Refusing unverified destination');
const url=new URL(process.env.DEST_DATABASE_URL);
for(const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
const ca=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if(!ca.ok) throw new Error('Public CA unavailable');
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000,
  ssl:{rejectUnauthorized:true,ca:await ca.text(),servername:url.hostname}});
try {
  await db.connect();
  await db.query("SET statement_timeout='30s'; SET lock_timeout='5s'");
  const before=await db.query(`SELECT ${lifecycle ? "to_regprocedure('public.cleanup_deleted_cpd_template_images()')" : "to_regclass('public.cpd_certificate_image')"} IS NOT NULL AS ready,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM cpd_certificate_template t) templates,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'')) FROM cpd_certificate_placeholder p) fields`);
  console.log(JSON.stringify({project:DESTINATION_PROJECT_REF,alreadyApplied:before.rows[0].ready}));
  if(process.argv.includes('--apply') && !before.rows[0].ready) {
    if(!process.argv.includes(`--review-sha256=${sha}`)) throw new Error('Exact reviewed migration hash required');
    await db.query(migration);
  }
  if (before.rows[0].ready || process.argv.includes('--apply')) {
    const verified=await db.query(`SELECT
      NOT has_table_privilege('authenticated','public.cpd_certificate_image','SELECT') AS private_assets,
      NOT has_function_privilege('anon','public.upload_cpd_certificate_image(uuid,uuid,integer,text,text,integer,integer,text)','EXECUTE') AS private_upload,
      has_function_privilege('service_role','public.save_cpd_certificate_template_images_checked(uuid,uuid,integer,text,text,jsonb,text)','EXECUTE') AS service_save,
      position('field.image_asset_id' in pg_get_functiondef('public.save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure))>0 AS saves_image,
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM cpd_certificate_template t) templates,
      (SELECT md5(coalesce(jsonb_agg(${lifecycle ? 'to_jsonb(p)' : "to_jsonb(p)-'image_asset_id'-'image_sha256'"} ORDER BY id)::text,'')) FROM cpd_certificate_placeholder p) fields`);
    const row=verified.rows[0];
    if(!row.private_assets||!row.private_upload||!row.service_save||!row.saves_image) throw new Error('Schema verification failed');
    if(!before.rows[0].ready && (row.templates!==before.rows[0].templates || row.fields!==before.rows[0].fields)) throw new Error('Unexpected template data change');
    console.log(JSON.stringify({verified:true,privateAssets:true,templateContentChanged:false}));
  }
} catch(error) {
  console.error(JSON.stringify({error:'Certificate image schema operation failed',code:error.code||null,message: /^[A-Za-z ]+$/.test(error.message) ? error.message : undefined}));
  process.exitCode=1;
} finally { await db.end(); }
