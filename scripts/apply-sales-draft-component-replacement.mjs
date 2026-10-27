import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const file = 'supabase/migrations/202610270001_sales_draft_component_replacement.sql';
const sql = await readFile(file, 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ file, sha256, destination: PROJECT, applied: false }));
} else {
  const preflight = args.length === 1 && args[0] === '--preflight';
  if (!preflight && (args.length !== 3 || !args.includes('--apply')
    || !args.includes(`--reviewed-sha256=${sha256}`)
    || !args.includes(`--confirm-destination=${PROJECT}`))) throw new Error('Explicit reviewed digest and destination required');
  const db = await connectDestination();
  try {
    await db.query(preflight ? 'BEGIN READ ONLY' : 'BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
    const inspect = async () => (await db.query(`SELECT proname,proacl,pg_get_functiondef(oid) definition
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
      ('save_sales_quote_draft','guard_quote_child_immutable','guard_quote_component_immutable') ORDER BY proname`)).rows;
    const before = await inspect();
    if (before.length !== 3 || !before.find(r => r.proname === 'save_sales_quote_draft')?.definition.includes('sync_sales_exhibition')) {
      throw new Error('Expected exhibition wrapper and guards missing');
    }
    // Hash all persisted proposal evidence without exposing customer data.
    const evidence = async () => (await db.query(`SELECT md5(jsonb_build_object(
      'quote',to_jsonb(q),'versions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM sales_quote_version v WHERE v.quote_id=q.id),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_quote_line l JOIN sales_quote_version v ON v.id=l.quote_version_id WHERE v.quote_id=q.id),
      'components',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM sales_quote_bundle_component c JOIN sales_quote_line l ON l.id=c.quote_line_id JOIN sales_quote_version v ON v.id=l.quote_version_id WHERE v.quote_id=q.id)
      )::text) digest FROM sales_quote q WHERE q.id='600fa259-da54-4019-aeec-58e95a4776b6'`)).rows;
    const original = await evidence();
    if (!preflight) {
      await db.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
      if (JSON.stringify(before) !== JSON.stringify(await inspect())) throw new Error('Wrapper or guards changed');
      if (JSON.stringify(original) !== JSON.stringify(await evidence())) throw new Error('Reported proposal changed');
    }
    const { rows: [verification] } = await db.query(`SELECT
      position('DELETE FROM public.sales_quote_bundle_component c' IN pg_get_functiondef(
        'save_sales_quote_draft_before_exhibition(uuid,uuid,integer,jsonb,text,text)'::regprocedure))>0 patched,
      has_function_privilege('service_role','save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text)','EXECUTE') entry_allowed,
      has_function_privilege('service_role','save_sales_quote_draft_before_exhibition(uuid,uuid,integer,jsonb,text,text)','EXECUTE') helper_allowed,
      has_function_privilege('authenticated','save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text)','EXECUTE') browser_allowed`);
    if (!preflight && (!verification.patched || !verification.entry_allowed || verification.helper_allowed || verification.browser_allowed)) {
      throw new Error('Post-apply function verification failed');
    }
    await db.query(preflight ? 'ROLLBACK' : 'COMMIT');
    console.log(JSON.stringify({ file, sha256, destination: PROJECT, applied: !preflight,
      reportedProposalUnchanged: true, verification }));
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
