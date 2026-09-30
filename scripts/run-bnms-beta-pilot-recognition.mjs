// Destination-only administrative operation. No provider requests.
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const { destinationConnection } = await import('./run-bnms-dd-pilot-history.mjs');
const { recognitionCatalog, normalizedRecognitionCatalog, verifyRecognitionSchema } =
  await import('./run-bnms-alpha-membership-recognition.mjs');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const table='bnms_membership_recognition_beta_pilot';
const authorization='explicit-user-approval:exact-10-beta-1-pilot:2026-09-21-through-2027-09-30:preserve-collection-controls';
const scopeHash='24f504d58be98163858ebeaf91d796074a50c27f4013d07169ef31e83d9a2c64';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const args=process.argv.slice(2);
const apply=args.includes('--apply');
const hash=args.find(a=>/^--review-sha256=[a-f0-9]{64}$/.test(a))?.split('=')[1];
const outIndex=args.indexOf('--out');
const out=args[outIndex+1];
if (outIndex<0 || !out || !resolve(out).startsWith(`${resolve('exports')}/`)
    || args.length!==(apply?4:2) || (apply&&!hash) || (!apply&&hash)) {
  throw Error('Use --out exports/NEW.json [--apply --review-sha256=HASH]');
}
const sql=await readFile(new URL('../supabase/migrations/20261120_bnms_membership_recognition_beta_pilot.sql',import.meta.url),'utf8');
const financialTables=['member_membership_history','membership_billing_agreements','membership_payment_plans',
  'gocardless_collection_reservations','gocardless_payments','bnms_dd_historical_payment',
  'membership_instalment_invoices','membership_payment_status_history',
  'bnms_dd_alpha_adoption','bnms_dd_alpha_membership_recognition','bnms_dd_alpha_release',
  'bnms_dd_beta_adoption','bnms_dd_beta_invoice_link','bnms_dd_pilot_adoption','bnms_dd_pilot_release'];
const report=await open(out,'wx',0o600);
let c,stage='connect';
try {
  c=await destinationConnection(); await c.connect();
  await c.query(apply?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
  if(apply) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('bnms-beta-pilot-recognition'))");
    await c.query(`LOCK TABLE ${financialTables.map(t=>`public.${t}`).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  }
  stage='source-verification';
  await verifyRecognitionSchema(c);
  const rows=(await c.query(`WITH cohort AS (
    SELECT 'beta' kind,id,tenant_id,member_id,agreement_id,plan_id,history_id
      FROM public.bnms_dd_beta_adoption WHERE tenant_id=$1
    UNION ALL SELECT 'pilot',id,tenant_id,member_id,agreement_id,plan_id,history_id
      FROM public.bnms_dd_pilot_adoption WHERE tenant_id=$1)
    SELECT to_jsonb(a) identity,to_jsonb(h) history,to_jsonb(p) plan,to_jsonb(b) agreement
      FROM cohort a LEFT JOIN public.member_membership_history h ON h.id=a.history_id
      LEFT JOIN public.membership_payment_plans p ON p.id=a.plan_id
      LEFT JOIN public.membership_billing_agreements b ON b.id=a.agreement_id ORDER BY a.kind,a.member_id`,[tenant])).rows;
  const identities=rows.map(({identity:a})=>[a.kind,a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id].join('|')).sort().join('\n');
  if(createHash('sha256').update(identities).digest('hex')!==scopeHash
      || rows.filter(r=>r.identity.kind==='beta').length!==10 || rows.filter(r=>r.identity.kind==='pilot').length!==1)
    throw Error('Exact recognition cohort drift');
  for(const {identity:a,history:h,plan:p,agreement:b} of rows) {
    const beta=a.kind==='beta',status=beta?'first_payment_pending':'mandate_pending';
    if([h,p,b].some(r=>!r||r.tenant_id!==tenant||r.member_id!==a.member_id)
      ||h.billing_agreement_id!==a.agreement_id||p.billing_agreement_id!==a.agreement_id
      ||h.status!=='pending_payment_setup'||h.payment_status!=='unpaid'||h.payment_method!=='direct_debit'
      ||h.term_start_date!=='2026-10-01'||h.term_end_date!=='2027-09-30'||h.membership_renewal_date!=='2027-10-01'
      ||p.provider!=='gocardless'||b.provider!=='gocardless'||p.status!==status||b.status!==status
      ||!!p.collection_stopped_at!==beta||p.metadata?.bnms_release_required!==beta)
      throw Error('Canonical eligibility or collection control drift');
  }
  async function snapshot() {
    const result={};
    for(const t of financialTables) result[t]=(await c.query(
      `SELECT count(*)::int count,encode(sha256(convert_to(COALESCE(
        string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''),'UTF8')),'hex') sha256
       FROM public.${t} t WHERE tenant_id=$1`,[tenant])).rows[0];
    return result;
  }
  const before=await snapshot();
  if(before.bnms_dd_alpha_membership_recognition.count!==249) throw Error('Alpha recognition count drift');
  const reviewSha256=digest({sql,authorization,scopeHash,rows,before});
  if(apply&&hash!==reviewSha256) throw Error('Reviewed recognition hash mismatch');
  const exists=(await c.query('SELECT to_regclass($1) IS NOT NULL present',[`public.${table}`])).rows[0].present;
  stage='schema';
  if(apply&&!exists) await c.query(sql);
  let catalogSha256=null;
  if(exists||apply) {
    const catalog=await recognitionCatalog({query:q=>c.query(q.replace("'bnms_dd_alpha_membership_recognition'",`'${table}'`))});
    catalogSha256=digest(normalizedRecognitionCatalog(catalog));
    if(catalogSha256!=='5962cfddfb9ec75941c434bf6da27baf7aa1b89d5864c0b04dc24c1878f62c0c') throw Error('Supplemental recognition schema differs from reviewed catalog');
    const grants=(await c.query(`SELECT
      has_function_privilege('anon','public.validate_bnms_supplemental_recognition()','EXECUTE') anon,
      has_function_privilege('authenticated','public.validate_bnms_supplemental_recognition()','EXECUTE') authenticated,
      has_function_privilege('service_role','public.validate_bnms_supplemental_recognition()','EXECUTE') service`)).rows[0];
    if(grants.anon||grants.authenticated||!grants.service) throw Error('Supplemental function grants drift');
  }
  stage='existing-recognition';
  const existing=exists?(await c.query(`SELECT to_jsonb(r) record FROM public.${table} r ORDER BY member_id`)).rows.map(r=>r.record):[];
  if(existing.length!==0&&existing.length!==11) throw Error('Partial recognition cohort');
  for(const r of existing) {
    const a=rows.find(row=>row.identity.id===r.adoption_id)?.identity;
    if(!a||r.tenant_id!==tenant||r.member_id!==a.member_id||r.history_id!==a.history_id
      ||r.plan_id!==a.plan_id||r.agreement_id!==a.agreement_id||r.cohort!==a.kind
      ||r.effective_from!=='2026-09-21'||r.effective_until!=='2027-10-01'||r.revoked_at
      ||r.authorization_reference!==authorization||r.review_sha256!==reviewSha256)
      throw Error('Existing recognition drift');
  }
  stage='insert';
  let inserted=0;
  if(apply&&!existing.length) for(const {identity:a} of rows) {
    inserted+=(await c.query(`INSERT INTO public.${table}
      (adoption_id,cohort,tenant_id,member_id,history_id,agreement_id,plan_id,effective_from,effective_until,authorization_reference,review_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,'2026-09-21','2027-10-01',$8,$9)`,
      [a.id,a.kind,tenant,a.member_id,a.history_id,a.agreement_id,a.plan_id,authorization,reviewSha256])).rowCount;
  }
  if(apply&&inserted+existing.length!==11) throw Error('Incomplete recognition cohort');
  const after=await snapshot();
  if(digest(before)!==digest(after)) throw Error('Financial or Alpha snapshot changed');
  const result={target:'lvmzliemqnieeoruhkik',mode:apply?(inserted?'applied':'zero-write-replay'):'review',
    reviewSha256,catalogSha256,inserted,cohort:11,before,after,financialSnapshotUnchanged:true,
    providerRequests:0,financialWrites:0,alphaRecognitionRows:249,betaHeld:10,pilotHeld:false};
  await report.writeFile(JSON.stringify({...result,manifest:rows.map(r=>r.identity)},null,2));
  stage='commit';
  await c.query(apply?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({...result,before:undefined,after:undefined}));
} catch(error) {
  await c?.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({error:'Recognition operation failed; inspect stage and database before retry',stage,code:error.code}));
  process.exitCode=1;
} finally {
  await report.close(); await c?.end();
}