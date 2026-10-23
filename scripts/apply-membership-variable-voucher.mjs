// External DEST only. Offline hash by default; preflight is strictly read-only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '202610230001_membership_variable_voucher.sql';
export const CONTRACTS = {
  attach_gocardless_dynamic_payment: 'e391f9b7d31a48471d9d50227672a351',
  complete_gocardless_dynamic_term: 'b1d467b0155603ce3b04eb5454f4bb4a',
  gocardless_manual_collection_due_date: '3aa78c5070486394e43164067ead4370',
  reserve_gocardless_dynamic_collection: '915edf695e8fee75a2e62dcee937ae9b',
  voucher_credit_refund_allocation: '6613624d7e4ef1d9498051879a18099b',
  voucher_credit_transition: '6c82e54cafc71b576e055f712759f845',
};
export async function main(args=process.argv.slice(2)) {
  if (args.some(a=>!['--apply','--preflight'].includes(a)&&!/^--review-sha256=[a-f0-9]{64}$/.test(a))
      || (args.includes('--apply')&&args.includes('--preflight'))) throw new Error('Invalid migration arguments');
  const text=await readFile(new URL(`../supabase/migrations/${MIGRATION}`,import.meta.url),'utf8');
  const hash=createHash('sha256').update(text).digest('hex');
  if (!args.includes('--apply')&&!args.includes('--preflight')) {
    console.log(JSON.stringify({mode:'offline',migration:MIGRATION,sha256:hash,writesPerformed:false})); return;
  }
  if(args.includes('--apply')&&!args.includes(`--review-sha256=${hash}`)) throw new Error('Exact reviewed migration hash required');
  const target=destinationTarget(process.env);
  const response=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if(!response.ok) throw new Error('Provider TLS CA unavailable');
  const ca=await response.text();
  const db=new pg.Client({connectionString:target.toString(),ssl:{rejectUnauthorized:true,ca,servername:target.hostname}});
  try {
    await db.connect();
    await db.query(args.includes('--apply')?'BEGIN':'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    const installed=await db.query("SELECT to_regclass('public.membership_variable_voucher_period') AS installed");
    if(installed.rows[0].installed) {
      const comment=await db.query("SELECT obj_description('public.membership_variable_voucher_period'::regclass) AS checksum");
      if(comment.rows[0].checksum!==hash) throw new Error('Installed migration differs from reviewed hash');
      await db.query('ROLLBACK');
      console.log(JSON.stringify({mode:'already-applied',migration:MIGRATION,sha256:hash,writesPerformed:false}));return;
    }
    const result=await db.query(`SELECT proname,md5(pg_get_functiondef(p.oid)) AS hash
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname=ANY($1::text[])`,[Object.keys(CONTRACTS)]);
    if(result.rows.length!==Object.keys(CONTRACTS).length || result.rows.some(r=>CONTRACTS[r.proname]!==r.hash)) {
      throw new Error('Live financial function contract changed; migration refused');
    }
    if(!args.includes('--apply')) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({mode:'preflight',target:'lvmzliemqnieeoruhkik',contracts:result.rows,sha256:hash,writesPerformed:false}));return;
    }
    await db.query(text);
    const access=await db.query(`SELECT bool_and(
      NOT has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('service_role',oid,'INSERT,UPDATE,DELETE') AND relrowsecurity) AS safe
      FROM pg_class WHERE oid IN ('public.membership_variable_voucher_period'::regclass,'public.membership_variable_voucher_slice'::regclass)`);
    const rpc=await db.query(`SELECT bool_and(
      NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AS safe
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND proname LIKE 'membership_variable_voucher_%'`);
    if(access.rows[0].safe!==true||rpc.rows[0].safe!==true) throw new Error('Variable voucher access verification failed');
    await db.query(`COMMENT ON TABLE public.membership_variable_voucher_period IS '${hash}'`);
    await db.query('COMMIT');
    console.log(JSON.stringify({mode:'applied',migration:MIGRATION,target:'lvmzliemqnieeoruhkik',sha256:hash,writesPerformed:true}));
  } finally { await db.end(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error('Variable voucher migration did not complete. Check arguments, pinned contracts and verified DEST access.');process.exitCode=1;});
}
