#!/usr/bin/env node
import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const ROLE = 'b640bd84-3d84-4cde-9f27-c3e80edb762f';
const FIELD = '87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function main(args = process.argv.slice(2)) {
  assert(args.every(arg => arg === '--apply' || /^--review-sha256=[a-f0-9]{64}$/.test(arg)), 'Invalid arguments');
  const apply = args.includes('--apply');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'Provider CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  await client.connect();
  let directory;
  try {
    await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE ${apply ? '' : 'READ ONLY'}`);
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    const read = async (sql, params = []) => (await client.query(sql, params)).rows;
    const tenant = await read('SELECT name FROM public.tenant WHERE id=$1', [TENANT]);
    assert(tenant.length === 1 && tenant[0].name === 'BNMS', 'Tenant identity mismatch');
    const roles = await read(`SELECT * FROM public.role WHERE tenant_id=$1 ORDER BY id ${apply ? 'FOR SHARE' : ''}`, [TENANT]);
    const matches = roles.filter(role => role.name === 'CPD Guest');
    assert(matches.length === 1 && matches[0].id === ROLE, 'Target role ambiguous');
    const role = matches[0];
    assert(!role.is_admin && !role.is_tenant_admin && !role.requires_effective_from_date
      && role.max_members == null && role.excluded_features.includes('admin'), 'Target role constraints changed');
    const fields = await read(`SELECT id FROM public.preference_field
      WHERE tenant_id=$1 AND name='member_class' AND entity_scope='member' AND is_active=true
      ${apply ? 'FOR SHARE' : ''}`, [TENANT]);
    assert(fields.length === 1 && fields[0].id === FIELD, 'Class field ambiguous');
    assert(!(await read("SELECT to_regclass('public.member_role') relation"))[0].relation, 'Secondary role schema requires review');
    const members = await read(`SELECT m.id,m.tenant_id,m.role_id,m.role_effective_from,m.updated_at
      FROM public.member m WHERE m.tenant_id=$1 AND EXISTS (
        SELECT 1 FROM public.member_preference_value v
        WHERE v.member_id=m.id AND v.field_id=$2 AND v.value='CPD Guest')
      ORDER BY m.id ${apply ? 'FOR UPDATE OF m' : ''}`, [TENANT, FIELD]);
    const values = await read(`SELECT member_id,value FROM public.member_preference_value
      WHERE field_id=$1 AND member_id=ANY($2::uuid[]) ORDER BY member_id
      ${apply ? 'FOR SHARE' : ''}`, [FIELD, members.map(member => member.id)]);
    assert(members.length === 2340 && values.length === members.length
      && new Set(values.map(value => value.member_id)).size === members.length
      && values.every(value => value.value === 'CPD Guest'), 'Class population changed or ambiguous');
    assert(members.every(member => member.role_id == null || roles.some(role =>
      role.id === member.role_id && !role.is_admin && !role.is_tenant_admin)), 'Privileged or foreign prior role needs review');
    // The normal member-role PATCH does not revoke sessions: getSessionMember
    // reads the persisted member and auth/me resolves the current role each time.
    // Keep session/login state unchanged, matching that established behavior.
    const groups = await read(`SELECT id FROM public.member_group mg
      WHERE tenant_id=$1 AND automatic_membership_enabled=true
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(mg.automatic_membership_filter_groups) g,
        jsonb_array_elements(g->'conditions') c WHERE c->>'entity_scope'='member'
        AND c->>'field_type'='core' AND c->>'field_key'='role_id')`, [TENANT]);
    assert(groups.length === 0, 'Role-based automatic group side effects require review');
    const changed = members.filter(member => member.role_id !== ROLE);
    const plan = { tenant: TENANT, role: ROLE, field: FIELD, members };
    const planSha256 = hash(plan);
    const priorRoles = members.reduce((counts, member) => {
      const name = roles.find(role => role.id === member.role_id)?.name ?? '(no role)';
      counts[name] = (counts[name] || 0) + 1;
      return counts;
    }, {});
    const summary = { target: 'verified DEST production', tenant: 'BNMS', memberClass: 'CPD Guest',
      targetRole: 'CPD Guest', total: members.length, changed: changed.length,
      alreadyCorrect: members.length - changed.length, priorRoles, planSha256 };
    if (!apply) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ...summary, dryRun: true }, null, 2));
      return;
    }
    assert(args.includes(`--review-sha256=${planSha256}`), 'Reviewed snapshot changed');
    directory = path.join(homedir(), '.private-recovery', 'bnms-cpd-guest-role', new Date().toISOString().replaceAll(':', '-'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, 'before.json'), JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
    const unaffectedSql = `SELECT md5(COALESCE(string_agg(id::text || ':' || COALESCE(role_id::text,'null'),
      ',' ORDER BY id),'')) fingerprint FROM public.member WHERE NOT (tenant_id=$1 AND id=ANY($2::uuid[]))`;
    const ids = changed.map(member => member.id);
    const before = await read(unaffectedSql, [TENANT, ids]);
    const result = await client.query(`UPDATE public.member m SET role_id=$1
      FROM jsonb_to_recordset($2::jsonb) AS old(id uuid,role_id uuid)
      WHERE m.id=old.id AND m.tenant_id=$3 AND m.role_id IS NOT DISTINCT FROM old.role_id
      AND m.role_id IS DISTINCT FROM $1
      AND EXISTS (SELECT 1 FROM public.member_preference_value v
        WHERE v.member_id=m.id AND v.field_id=$4 AND v.value='CPD Guest')
      RETURNING m.id`, [ROLE, JSON.stringify(changed), TENANT, FIELD]);
    assert(result.rowCount === changed.length, 'Conditional update count mismatch');
    assert(JSON.stringify(before) === JSON.stringify(await read(unaffectedSql, [TENANT, ids])), 'Unrelated role changed');
    const verificationSql = `SELECT count(*)::int total,
      count(*) FILTER (WHERE m.role_id=$3)::int correct
      FROM public.member m WHERE m.tenant_id=$1 AND EXISTS
        (SELECT 1 FROM public.member_preference_value v WHERE v.member_id=m.id
         AND v.field_id=$2 AND v.value='CPD Guest')`;
    const verify = async () => (await read(verificationSql, [TENANT, FIELD, ROLE]))[0];
    const inTransaction = await verify();
    assert(inTransaction.total === members.length && inTransaction.correct === members.length, 'Verification mismatch');
    await client.query('COMMIT');
    const verification = await verify();
    const report = { ...summary, committed: true, verification,
      unrelatedMemberRolesUnchanged: true, sessionsUnchanged: true, evidenceDirectory: directory };
    writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Never print database errors or connection values.
    console.error(JSON.stringify({ failed: true, code: error.code || 'GUARD_FAILED',
      message: error.code ? 'Database operation failed; inspect private evidence before retrying.' : error.message,
      evidenceDirectory: directory }));
    process.exitCode = 1;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Destination operation failed; no credentials logged.'); process.exitCode = 1; });
}