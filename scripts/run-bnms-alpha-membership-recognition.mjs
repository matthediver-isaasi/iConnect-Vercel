// Review/apply ONLY administrative membership recognition. No provider calls.
// --manifest FILE --out exports/NEW.json [--apply --review-sha256=HASH]
import { readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { validateAlphaReleaseScope } from './bnms-dd-alpha-release.mjs';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const AUTHORIZATION = 'inv_1d1b4UGozTvT5r7of2u3Uvbb0XRz7dMAfv:call_RFFMeS7rqBb8mg73E44LS2B6:yes-current-membership-collections-held';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Fingerprint is generated from the reviewed migration in disposable PostgreSQL,
// not trusted from a comment or mutable production baseline.
export const RECOGNITION_CATALOG_SHA256 = 'a63b1429c4507d0b38f7eef2dc61987b40b3f0cd4b356807f76c535d3468b6ca';
export function normalizedRecognitionCatalog(catalog) {
  if (!catalog) return catalog;
  // PostgreSQL 17 adds the owner's implicit MAINTAIN privilege. Owners already
  // control the relation. Ignore only this exact non-grantable owner self-entry;
  // never ignore MAINTAIN (or any other privilege) granted to a client role.
  return { ...catalog, acl: catalog.acl?.filter(entry => !(catalog.owner === 'postgres'
    && entry.grantee === 'postgres' && entry.grantor === 'postgres'
    && entry.privilege === 'MAINTAIN' && entry.grantable === false)) };
}
const SAFE_STAGES = new Set(['connect', 'transaction', 'canonical-read', 'financial-hold-read',
  'review-hash', 'schema-install', 'schema-verify', 'existing-recognition', 'recognition-insert', 'commit', 'report']);
const SAFE_MESSAGES = new Set([
  'Recognition schema/security differs from reviewed catalog',
  'Reviewed recognition hash mismatch; no changes applied',
  'Canonical Alpha membership or financial hold drift',
  'Alpha must remain wholly held and unreserved without managed payments',
  'Existing recognition drift; no changes applied',
  'Partial recognition cohort requires investigation',
  'Exact 249 recognition rows required; rolling back',
  'Exact immutable 249-member alpha scope required',
  'Alpha adoption identity/provenance drift',
]);
export function safeRecognitionFailure(error) {
  return {
    error: SAFE_MESSAGES.has(error?.message) ? error.message : 'Recognition operation failed',
    stage: SAFE_STAGES.has(error?.recognitionStage) ? error.recognitionStage : 'setup',
    ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
      ? { code: error.code } : {}),
    providerRequests: 0,
    instruction: 'Verify database state before retry; do not automatically reapply.',
  };
}
export async function recognitionCatalog(client) {
  return (await client.query(`SELECT jsonb_build_object(
    'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'rls',c.relrowsecurity,
    'forceRls',c.relforcerowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(k.oid),
      'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid),
    'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
      ORDER BY x.grantee=0,pg_get_userbyid(x.grantee),x.privilege_type)
      FROM aclexplode(c.relacl) x),
    'columnAcl',(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL),
    'policies',(SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid),
    'foreignKeyTriggers',(SELECT jsonb_agg(jsonb_build_object('function',p.proname,
      'enabled',t.tgenabled,'events',t.tgtype) ORDER BY p.proname,t.tgtype,t.tgenabled)
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid AND t.tgisinternal),
    'triggers',(SELECT jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid),
      'enabled',t.tgenabled,'functionOwner',pg_get_userbyid(p.proowner),'body',p.prosrc,
      'securityDefiner',p.prosecdef,'config',p.proconfig,'language',l.lanname,
      'returnType',format_type(p.prorettype,NULL),'functionKind',p.prokind)
      ORDER BY t.tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_language l ON l.oid=p.prolang WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) catalog FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='bnms_dd_alpha_membership_recognition'`)).rows[0]?.catalog;
}
export async function verifyRecognitionSchema(client) {
  const catalog = await recognitionCatalog(client);
  if (!catalog || digest(normalizedRecognitionCatalog(catalog)) !== RECOGNITION_CATALOG_SHA256) {
    throw new Error('Recognition schema/security differs from reviewed catalog');
  }
}
export function validateRecognitionRows(manifest, rows) {
  validateAlphaReleaseScope(manifest, rows.map(row => row.adoption));
  for (const { adoption: a, history: h, plan: p, agreement: b } of rows) {
    if (!h || !p || !b || h.id !== a.history_id || p.id !== a.plan_id || b.id !== a.agreement_id
        || [h, p, b].some(r => r.tenant_id !== TENANT || r.member_id !== a.member_id)
        || h.billing_agreement_id !== b.id || p.billing_agreement_id !== b.id
        || h.status !== 'pending_payment_setup' || h.payment_status !== 'unpaid'
        || h.term_start_date !== '2026-10-01' || h.term_end_date !== '2027-09-30'
        || h.membership_renewal_date !== '2027-10-01'
        || p.status !== 'first_payment_pending' || b.status !== 'first_payment_pending'
        || !p.collection_stopped_at || p.metadata?.bnms_release_required !== true) {
      throw new Error('Canonical Alpha membership or financial hold drift');
    }
  }
}
export function parseRecognitionArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply' && !opts.apply) opts.apply = true;
    else if (/^--review-sha256=[a-f0-9]{64}$/.test(arg) && !opts.hash) opts.hash = arg.split('=')[1];
    else if (['--manifest', '--out'].includes(arg) && !opts[arg.slice(2)]
        && args[i + 1] && !args[i + 1].startsWith('--')) opts[arg.slice(2)] = args[++i];
    else throw new Error('Unsupported argument; cohort, date and identity overrides forbidden');
  }
  if (!opts.manifest || !opts.out || !resolve(opts.out).startsWith(`${resolve('exports')}/`)
      || (opts.apply && !opts.hash) || (!opts.apply && opts.hash)) {
    throw new Error('Pinned manifest, new private exports report and exact apply review hash required');
  }
  return opts;
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseRecognitionArgs(args);
  destinationTarget(env);
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  const sql = await readFile(new URL('../supabase/migrations/20261119_bnms_dd_alpha_membership_recognition.sql', import.meta.url), 'utf8');
  // Reserve a private report before writing to the database.
  const report = await open(opts.out, 'wx', 0o600);
  let client;
  let stage = 'connect';
  try {
    client = await destinationConnection(env);
    await client.connect();
    stage = 'transaction';
    await client.query(opts.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    if (opts.apply) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-alpha-membership-recognition'))");
      await client.query('LOCK TABLE bnms_dd_alpha_adoption, member_membership_history, membership_payment_plans, membership_billing_agreements, bnms_dd_alpha_release, gocardless_collection_reservations, gocardless_payments IN SHARE ROW EXCLUSIVE MODE');
    }
    stage = 'canonical-read';
    const rows = (await client.query(`SELECT to_jsonb(a) adoption, to_jsonb(h) history,
      to_jsonb(p) plan, to_jsonb(b) agreement
      FROM bnms_dd_alpha_adoption a
      LEFT JOIN member_membership_history h ON h.id=a.history_id
      LEFT JOIN membership_payment_plans p ON p.id=a.plan_id
      LEFT JOIN membership_billing_agreements b ON b.id=a.agreement_id
      WHERE a.tenant_id=$1 ORDER BY a.member_id`, [TENANT])).rows;
    validateRecognitionRows(manifest, rows);
    stage = 'financial-hold-read';
    const unsafe = (await client.query(`SELECT
      (SELECT count(*) FROM bnms_dd_alpha_release WHERE tenant_id=$1)::int releases,
      (SELECT count(*) FROM gocardless_collection_reservations r JOIN bnms_dd_alpha_adoption a
        ON r.plan_id=a.plan_id OR r.billing_agreement_id=a.agreement_id WHERE a.tenant_id=$1)::int reservations,
      (SELECT count(*) FROM gocardless_payments p JOIN bnms_dd_alpha_adoption a
        ON (p.plan_id=a.plan_id OR p.gocardless_mandate_id=a.mandate_id)
        AND p.tenant_id=a.tenant_id WHERE a.tenant_id=$1)::int payments`,
    [TENANT])).rows[0];
    if (unsafe.releases || unsafe.reservations || unsafe.payments) throw new Error('Alpha must remain wholly held and unreserved without managed payments');
    const review = { schema: sql, catalogSha256: RECOGNITION_CATALOG_SHA256,
      authorization: AUTHORIZATION, from: '2026-09-21', until: '2027-10-01', rows };
    const reviewSha256 = digest(review);
    stage = 'review-hash';
    if (opts.apply && opts.hash !== reviewSha256) throw new Error('Reviewed recognition hash mismatch; no changes applied');
    const exists = (await client.query("SELECT to_regclass('public.bnms_dd_alpha_membership_recognition') IS NOT NULL present")).rows[0].present;
    stage = 'schema-install';
    if (opts.apply && !exists) await client.query(sql);
    if (exists || opts.apply) {
      stage = 'schema-verify';
      if (opts.apply) await client.query('LOCK TABLE public.bnms_dd_alpha_membership_recognition IN SHARE ROW EXCLUSIVE MODE');
      await verifyRecognitionSchema(client);
    }
    let existing = [];
    stage = 'existing-recognition';
    if (exists) existing = (await client.query('SELECT to_jsonb(r) record FROM bnms_dd_alpha_membership_recognition r ORDER BY member_id')).rows.map(row => row.record);
    for (const record of existing) {
      const a = rows.find(row => row.adoption.id === record.adoption_id)?.adoption;
      if (!a || record.tenant_id !== TENANT || record.member_id !== a.member_id
          || record.history_id !== a.history_id || record.plan_id !== a.plan_id || record.agreement_id !== a.agreement_id
          || record.effective_from !== '2026-09-21' || record.effective_until !== '2027-10-01'
          || record.revoked_at || record.authorization_reference !== AUTHORIZATION
          || record.review_sha256 !== reviewSha256) throw new Error('Existing recognition drift; no changes applied');
    }
    // Only permit an empty cohort or exact complete replay, not partial success.
    if (existing.length !== 0 && existing.length !== 249) throw new Error('Partial recognition cohort requires investigation');
    if (opts.apply && !existing.length) {
      stage = 'recognition-insert';
      const inserted = await client.query(`INSERT INTO bnms_dd_alpha_membership_recognition
        (adoption_id,tenant_id,member_id,history_id,agreement_id,plan_id,effective_from,effective_until,authorization_reference,review_sha256)
        SELECT id,tenant_id,member_id,history_id,agreement_id,plan_id,'2026-09-21','2027-10-01',$2,$3
        FROM bnms_dd_alpha_adoption WHERE tenant_id=$1`, [TENANT, AUTHORIZATION, reviewSha256]);
      if (inserted.rowCount !== 249) throw new Error('Exact 249 recognition rows required; rolling back');
    }
    const result = { mode: opts.apply ? (existing.length ? 'recognition_replay' : 'recognition_applied') : 'recognition_review',
      reviewSha256, members: rows.length, recognizedFrom: '2026-09-21', recognizedUntilExclusive: '2027-10-01',
      inserted: opts.apply ? 249 - existing.length : 0, financialWrites: 0, providerRequests: 0,
      collections: 'held', contractStart: '2026-10-01', authorizationReference: AUTHORIZATION };
    stage = 'commit';
    await client.query(opts.apply ? 'COMMIT' : 'ROLLBACK');
    stage = 'report';
    await report.writeFile(JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    error.recognitionStage = stage;
    throw error;
  } finally {
    await report.close();
    await client?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify(safeRecognitionFailure(error))); process.exitCode = 1; });
}