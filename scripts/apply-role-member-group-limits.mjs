import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const sql = await readFile('supabase/migrations/20261209_role_member_group_limits.sql', 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ sha256, dryRun: true, destination: 'lvmzliemqnieeoruhkik' }));
} else {
  const inspect = args.length === 1 && args[0] === '--inspect';
  if (!inspect && (args.length !== 2 || !args.includes('--apply') || !args.includes(`--review-sha256=${sha256}`))) throw new Error('Exact reviewed hash required');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(), ssl: {
    rejectUnauthorized: true, ca: await response.text(), servername: target.hostname,
  } });
  try {
    await client.connect();
    await client.query(inspect ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    const columns = (await client.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('member_group_assignment','vacancy','vacancy_award','member_group_role_invitation')
      AND column_name IN ('expires_at','source_id','positions_available','member_group_id','term_length_value','max_terms') ORDER BY 1,2`)).rows;
    if (inspect) console.log(JSON.stringify({ destination:'lvmzliemqnieeoruhkik',columns }));
    else {
      await client.query(sql);
      const grants = (await client.query(`SELECT
        NOT has_table_privilege('service_role','public.member_group_automatic_write_context','INSERT') private_context,
        NOT has_function_privilege('service_role','public.reconcile_automatic_membership_inner(uuid,uuid,text,uuid[],uuid[],boolean,text,integer,bigint,text)','EXECUTE') private_worker,
        NOT has_function_privilege('authenticated','public.apply_group_invitation_decision(uuid,text,jsonb)','EXECUTE') private_invite`)).rows[0];
      if (Object.values(grants).some(v=>v!==true)) throw new Error('Privilege verification failed');
      await client.query("NOTIFY pgrst, 'reload schema'");
      console.log(JSON.stringify({ applied:true,sha256,destination:'lvmzliemqnieeoruhkik',grants,sourceUntouched:true }));
    }
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error(`Migration/inspection failed (${error.code || 'validation'}); transaction not committed.`);
    process.exitCode=1;
  } finally { await client.end(); }
}
