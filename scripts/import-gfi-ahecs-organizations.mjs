#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from 'csv-parse/sync';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

export const TENANT = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
export const GROUP = '841c4f58-1b6b-4f60-b94a-55a3de124cc7';
export const FIELD = 'e201a90e-840b-4555-8cd3-c50aa8d9b19f';
const INPUT = 'attached_assets/ahecs_unique_organisations_domains_1790841127063.csv';
const PLAN = 'attached_assets/gfi-ahecs-reviewed-plan.json';
const REPORT = 'attached_assets/gfi-ahecs-import-activity.csv';
const RUNNER = 'scripts/import-gfi-ahecs-organizations.mjs';
const TABLES = [
  'organization', 'organization_preference_value', 'organization_group',
  'preference_field', 'member_group', 'system_settings', 'workflow',
  'workflow_log', 'workflow_delivery_claim',
  'form_due_diligence_field_mapping_workflow_outbox', 'member_login_session_revocation',
];
// Reviewed aliases are only accepted with a unique, independently matching domain.
const ALIASES = {
  'atu.ie': ['c0bf1dd8-6ecd-49ef-9a9f-c1df6156df88', 'ATU '],
  'qub.ac.uk': ['7fa62175-4bb3-41a8-b301-b59c4d739246', "Queen's University of Belfast"],
  'rcsi.ie': ['0be5036d-7afb-4135-a474-47d2058e5630', 'Royal College of Surgeons in Ireland (RCSI)'],
  'setu.ie': ['fc032ca1-a1a1-48c3-b3b1-60a4036188b4', 'South East Technological University (SETU)'],
  'tus.ie': ['08214b75-9b13-450b-af69-09e64d53e902', 'TUS: Technological University of the Shannon'],
};
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
};
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const normalizeName = value => value.normalize('NFKC').toLowerCase()
  .replace(/[‘’]/gu, "'").replace(/\s+/gu, ' ').trim();
const normalizeDomain = value => value.normalize('NFKC').trim().toLowerCase();
export function parseDomains(raw) {
  if (raw == null || raw.trim() === '') return [];
  let values;
  try { values = JSON.parse(raw); } catch { throw new Error('EXISTING_DOMAIN_VALUE_NOT_JSON'); }
  assert(Array.isArray(values) && values.every(v => typeof v === 'string' && v.trim()), 'EXISTING_DOMAIN_VALUE_NOT_STRING_ARRAY');
  // Preserve legacy URL-looking entries exactly; this import is not a cleanup.
  return values;
}
export function loadInput() {
  const bytes = readFileSync(INPUT);
  const rows = parse(bytes, { bom: true, columns: true, skip_empty_lines: true });
  assert(rows.length === 22, 'EXPECTED_22_ROWS');
  const names = new Set(), domains = new Set();
  for (const row of rows) {
    assert(Object.keys(row).join(',') === 'Organisation,Domain', 'CSV_HEADER_MISMATCH');
    assert(row.Organisation.trim() && row.Organisation === row.Organisation.trim(), 'INVALID_INPUT_NAME');
    assert(row.Domain === normalizeDomain(row.Domain) && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(row.Domain), 'INVALID_INPUT_DOMAIN');
    assert(!names.has(normalizeName(row.Organisation)) && !domains.has(row.Domain), 'DUPLICATE_INPUT');
    names.add(normalizeName(row.Organisation)); domains.add(row.Domain);
  }
  return { rows, inputSha256: createHash('sha256').update(bytes).digest('hex') };
}
function newId(name, domain) {
  const h = hash([PROJECT, TENANT, GROUP, FIELD, name, domain]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function preservedOrg(org) {
  const { updated_at, organization_group_id, ...rest } = org;
  return hash(rest);
}
export function buildMatches(inputs, organizations, preferences) {
  const used = new Set();
  const prefs = new Map();
  for (const pref of preferences) {
    assert(!prefs.has(pref.organization_id), 'DUPLICATE_DOMAIN_PREFERENCE');
    prefs.set(pref.organization_id, pref);
  }
  const domainMap = new Map();
  for (const org of organizations) {
    for (const domain of parseDomains(prefs.get(org.id)?.value)) {
      const key = normalizeDomain(domain);
      if (!domainMap.has(key)) domainMap.set(key, new Set());
      domainMap.get(key).add(org.id);
    }
  }
  return inputs.map(input => {
    const nameMatches = organizations.filter(o => normalizeName(o.name) === normalizeName(input.Organisation));
    const domainIds = [...(domainMap.get(input.Domain) || [])];
    assert(nameMatches.length <= 1 && domainIds.length <= 1, `AMBIGUOUS_MATCH:${input.Domain}`);
    assert(!nameMatches.length || !domainIds.length || nameMatches[0].id === domainIds[0], `NAME_DOMAIN_CONFLICT:${input.Domain}`);
    const org = nameMatches[0] || organizations.find(o => o.id === domainIds[0]);
    if (org && !nameMatches.length) {
      const alias = ALIASES[input.Domain];
      assert(alias && alias[0] === org.id && alias[1] === org.name, `UNREVIEWED_DOMAIN_ALIAS:${input.Domain}`);
    }
    assert(!org || !org.organization_group_id || org.organization_group_id === GROUP, `EXISTING_GROUP_CONFLICT:${input.Domain}`);
    const id = org?.id || newId(input.Organisation, input.Domain);
    assert(!used.has(id), `DUPLICATE_TARGET:${input.Domain}`); used.add(id);
    const pref = prefs.get(id);
    const existing = parseDomains(pref?.value);
    const desired = existing.some(v => normalizeDomain(v) === input.Domain) ? existing : [...existing, input.Domain];
    return {
      inputName: input.Organisation, domain: input.Domain, id,
      existingName: org?.name ?? null, match: org ? (nameMatches.length ? 'normalized-name' : 'reviewed-domain-alias') : 'create',
      beforeOrgHash: org ? hash(org) : null, preservedOrgHash: org ? preservedOrg(org) : null,
      beforeGroup: org?.organization_group_id ?? null,
      beforePreferenceHash: pref ? hash(pref) : null,
      beforeValue: pref?.value ?? null, preferenceExisted: !!pref,
      desiredValue: existing.some(v => normalizeDomain(v) === input.Domain) ? pref.value : JSON.stringify(desired),
      existingDomains: existing, desiredDomains: desired,
      groupChange: !org || org.organization_group_id !== GROUP,
      domainChange: !pref || !existing.some(v => normalizeDomain(v) === input.Domain),
    };
  });
}
async function rows(c, sql, parameters = []) { return (await c.query(sql, parameters)).rows; }

async function guard(c) {
  const columns = await rows(c, `select table_name,column_name,data_type,udt_name,is_nullable,column_default,
    is_identity,is_generated,generation_expression from information_schema.columns
    where table_schema='public' and table_name=any($1) order by table_name,ordinal_position`, [TABLES]);
  const triggers = await rows(c, `select n.nspname,c.relname,t.tgname,t.tgenabled,t.tgfoid,
    pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1)
    order by c.relname,t.tgname`, [TABLES]);
  const constraints = await rows(c, `select c.relname,x.conname,pg_get_constraintdef(x.oid) definition
    from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1) order by c.relname,x.conname`, [TABLES]);
  const indexes = await rows(c, `select tablename,indexname,indexdef from pg_indexes
    where schemaname='public' and tablename=any($1) order by tablename,indexname`, [TABLES]);
  const rules = await rows(c, `select tablename,rulename,definition from pg_rules
    where schemaname='public' and tablename=any($1) order by tablename,rulename`, [TABLES]);
  assert(!rules.length, 'UNREVIEWED_RULE');
  // Collect every public trigger function and its transitive public function calls,
  // including non-executed branches. Dynamic SQL in reviewed reachable functions is absent.
  const allFunctions = await rows(c, `select p.oid,p.proname,pg_get_functiondef(p.oid) definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind in ('f','p') order by p.oid`);
  const wanted = new Set(triggers.map(t => t.tgfoid));
  let changed = true;
  while (changed) {
    changed = false;
    const bodies = allFunctions.filter(f => wanted.has(f.oid)).map(f => f.definition).join('\n');
    for (const f of allFunctions) {
      if (!wanted.has(f.oid) && new RegExp(`\\b${f.proname}\\s*\\(`, 'i').test(bodies)) {
        wanted.add(f.oid); changed = true;
      }
    }
  }
  const functions = allFunctions.filter(f => wanted.has(f.oid));
  const policies = await rows(c, `select * from pg_policies where schemaname='public'
    and tablename=any($1) order by tablename,policyname`, [TABLES]);
  const relations = await rows(c, `select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relkind
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1) order by c.relname`, [TABLES]);
  const defaults = columns.filter(v => ['organization', 'organization_preference_value'].includes(v.table_name) && v.column_default);
  assert(defaults.every(v => !v.column_default.includes('(') || ['gen_random_uuid()', 'now()'].includes(v.column_default)), 'UNREVIEWED_FUNCTION_DEFAULT');
  return { hash: hash({ columns, triggers, constraints, indexes, rules, functions, policies, relations }),
    functions: functions.map(f => f.proname), triggerCount: triggers.length,
    defaults: defaults.map(({ table_name, column_name, column_default }) => ({ table_name, column_name, column_default })) };
}

async function configuration(c) {
  const tenant = await rows(c, 'select id,name from public.tenant where id=$1', [TENANT]);
  assert(tenant.length === 1 && tenant[0].name === 'Graduate Futures Institute', 'TENANT_PIN_FAILED');
  const group = await rows(c, 'select * from public.organization_group where id=$1', [GROUP]);
  assert(group.length === 1 && group[0].tenant_id === TENANT &&
    group[0].name === 'AHECS – Association of Higher Education Career Services Company', 'GROUP_PIN_FAILED');
  const field = await rows(c, 'select * from public.preference_field where id=$1', [FIELD]);
  assert(field.length === 1 && field[0].tenant_id === TENANT && field[0].name === 'verified_domains' &&
    field[0].is_active === true && field[0].entity_scope === 'organization' &&
    field[0].custom_object_id === null && field[0].field_type === 'list', 'FIELD_PIN_FAILED');
  const workflows = await rows(c, 'select * from public.workflow where tenant_id=$1 and is_active order by id', [TENANT]);
  assert(workflows.every(w => w.trigger_type === 'field_change'), 'NON_FIELD_CHANGE_WORKFLOW_ACTIVE');
  const orgWorkflows = workflows.filter(w => w.entity_type === 'organization');
  assert(orgWorkflows.length === 4 && orgWorkflows.every(w =>
    w.trigger_config?.field_type === 'custom' &&
    w.trigger_config?.field_id === '1c395ccf-7df2-4818-917d-1cd672216f71'), 'ORGANIZATION_WORKFLOW_CONFIG_CHANGED');
  const groups = await rows(c, 'select * from public.member_group where tenant_id=$1 order by id', [TENANT]);
  assert(groups.every(g => !g.automatic_membership_enabled), 'AUTOMATIC_MEMBERSHIP_ENABLED');
  const loginGate = await rows(c, `select setting_value from public.system_settings where tenant_id=$1
    and setting_key='organization_login_gate'`, [TENANT]);
  assert(loginGate.length === 0, 'LOGIN_GATE_REQUIRES_REVIEW');
  return { hash: hash({ tenant, group, field, workflows, groups, loginGate }),
    activeWorkflows: workflows.length, organizationFieldChangeWorkflows: orgWorkflows.length,
    automaticMembershipEnabled: 0, memberGroups: groups.length, loginGateSettings: 0 };
}
async function evidence(c) {
  const result = {};
  for (const table of ['workflow_log', 'workflow_delivery_claim', 'form_due_diligence_field_mapping_workflow_outbox']) {
    // Only counts and content fingerprints leave the database, never delivery payloads.
    result[table] = (await rows(c, `select count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) fingerprint
      from public.${table} t where tenant_id=$1`, [TENANT]))[0];
  }
  result.member_group = (await rows(c, `select count(*)::int count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by id),'')) fingerprint
    from public.member_group t where tenant_id=$1`, [TENANT]))[0];
  result.member_login_session_revocation = (await rows(c, `select count(*)::int count,
    md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by member_id),'')) fingerprint
    from public.member_login_session_revocation t where tenant_id=$1`, [TENANT]))[0];
  return result;
}
async function data(c) {
  return {
    organizations: await rows(c, 'select * from public.organization where tenant_id=$1 order by id', [TENANT]),
    preferences: await rows(c, `select p.* from public.organization_preference_value p
      join public.organization o on o.id=p.organization_id
      where o.tenant_id=$1 and p.field_id=$2 order by p.organization_id`, [TENANT, FIELD]),
    // This fingerprint guards all unrelated preference fields (including application_status).
    otherPreferences: (await rows(c, `select count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.id),'')) fingerprint
      from public.organization_preference_value p join public.organization o on o.id=p.organization_id
      where o.tenant_id=$1 and p.field_id<>$2`, [TENANT, FIELD]))[0],
  };
}
const counts = matches => ({
  rows: matches.length, create: matches.filter(m => m.match === 'create').length,
  reuse: matches.filter(m => m.match !== 'create').length,
  domainAliases: matches.filter(m => m.match === 'reviewed-domain-alias').length,
  groupLinks: matches.filter(m => m.groupChange).length,
  domainWrites: matches.filter(m => m.domainChange).length,
  existingDomainValuesPreserved: matches.filter(m => m.match !== 'create' && !m.domainChange).length,
});
function complete(plan, state) {
  return plan.matches.every(m => {
    const org = state.organizations.find(o => o.id === m.id);
    const pref = state.preferences.find(p => p.organization_id === m.id);
    return org?.tenant_id === TENANT && org.organization_group_id === GROUP &&
      org.name === (m.existingName ?? m.inputName) && pref?.value === m.desiredValue &&
      (!m.preservedOrgHash || preservedOrg(org) === m.preservedOrgHash);
  });
}
function report(plan, state, result) {
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['input_name', 'domain', 'organization_id', 'action', 'stored_name', 'group_id', 'domains_verified', 'result']];
  for (const m of plan.matches) {
    const org = state?.organizations.find(o => o.id === m.id);
    const pref = state?.preferences.find(p => p.organization_id === m.id);
    lines.push([m.inputName, m.domain, m.id, state ? (m.match === 'create' ? 'created' : 'reused') : m.match,
      org?.name ?? m.existingName ?? m.inputName, GROUP,
      state ? String(org?.organization_group_id === GROUP && pref?.value === m.desiredValue) : 'planned', result]);
  }
  writeFileSync(REPORT, '\ufeff' + lines.map(r => r.map(escape).join(',')).join('\r\n') + '\r\n', { mode: 0o600 });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const approvedHash = args.find(a => a.startsWith('--approved-hash='))?.split('=')[1];
  assert(args.every(a => a === '--dry-run' || a === '--apply' || /^--approved-hash=[a-f0-9]{64}$/.test(a)), 'UNKNOWN_ARGUMENT');
  assert(!(apply && args.includes('--dry-run')), 'CONFLICTING_MODES');
  assert(!apply || approvedHash, 'REVIEWED_PLAN_HASH_REQUIRED');
  const input = loadInput();
  const runnerSha256 = createHash('sha256').update(readFileSync(RUNNER)).digest('hex');
  const approved = apply ? JSON.parse(readFileSync(PLAN, 'utf8')) : null;
  if (apply) {
    const { approvedHash: savedHash, ...body } = approved;
    assert(savedHash === approvedHash && hash(body) === approvedHash, 'APPROVED_PLAN_HASH_MISMATCH');
    assert(approved.inputSha256 === input.inputSha256 && approved.project === PROJECT &&
      approved.tenant === TENANT && approved.group === GROUP && approved.field === FIELD, 'APPROVED_PLAN_PINS_MISMATCH');
    assert(approved.runnerSha256 === runnerSha256, 'REVIEWED_RUNNER_CHANGED');
  }
  const c = await connectDestination();
  let committed = false;
  let commitAttempted = false;
  try {
    await c.query(apply ? 'begin' : 'begin isolation level repeatable read read only');
    await c.query("set local statement_timeout='15s'");
    await c.query("set local lock_timeout='5s'");
    await c.query("set local idle_in_transaction_session_timeout='20s'");
    await c.query("set local search_path=public,pg_catalog");
    if (apply) {
      // Predicate-safe: prevent inserts/name/domain races, config changes and asynchronous
      // workflow writes during the short atomic transaction; never disable triggers.
      await c.query(`lock table public.organization,public.organization_preference_value,public.member_group
        in share row exclusive mode`);
      await c.query(`lock table public.organization_group,public.preference_field,public.system_settings,
        public.workflow,public.workflow_log,public.workflow_delivery_claim,
        public.form_due_diligence_field_mapping_workflow_outbox,public.member_login_session_revocation in share mode`);
      await c.query('select id from public.organization_group where id=$1 for share', [GROUP]);
      await c.query('select id from public.preference_field where id=$1 for share', [FIELD]);
    }
    const schema = await guard(c);
    const config = await configuration(c);
    const beforeEvidence = await evidence(c);
    const before = await data(c);
    if (!apply) {
      const matches = buildMatches(input.rows, before.organizations, before.preferences);
      const plan = { version: 1, project: PROJECT, tenant: TENANT, group: GROUP, field: FIELD,
        inputSha256: input.inputSha256, runnerSha256, schema, config, matches, counts: counts(matches) };
      plan.approvedHash = hash(plan);
      await c.query('rollback');
      mkdirSync('attached_assets', { recursive: true });
      writeFileSync(PLAN, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
      report(plan, null, 'dry-run; no database writes');
      console.log(JSON.stringify({ mode: 'dry-run', counts: plan.counts, schemaHash: schema.hash,
        configuration: config, evidence: beforeEvidence, approvedHash: plan.approvedHash,
        plan: PLAN, activity: REPORT }));
      return;
    }
    assert(schema.hash === approved.schema.hash, 'SCHEMA_OR_FUNCTION_GUARD_CHANGED');
    assert(config.hash === approved.config.hash, 'CONFIGURATION_GUARD_CHANGED');
    if (complete(approved, before)) {
      await c.query('rollback');
      report(approved, before, 'idempotent replay; no database writes');
      console.log(JSON.stringify({ mode: 'idempotent-replay', rows: 22, writes: 0, evidence: beforeEvidence }));
      return;
    }
    const matches = buildMatches(input.rows, before.organizations, before.preferences);
    assert(hash(matches) === hash(approved.matches), 'REVIEWED_MATCH_PLAN_CHANGED');
    const started = Date.now();
    let created = 0, groupUpdates = 0, domainWrites = 0;
    for (const m of matches) {
      assert(Date.now() - started < 60000, 'TRANSACTION_TIME_BUDGET_EXCEEDED');
      if (m.match === 'create') {
        const result = await c.query(`insert into public.organization(id,name,tenant_id,organization_group_id)
          values($1,$2,$3,$4)`, [m.id, m.inputName, TENANT, GROUP]);
        assert(result.rowCount === 1, 'ORGANIZATION_INSERT_COUNT'); created++;
      } else if (m.groupChange) {
        const result = await c.query(`update public.organization set organization_group_id=$1
          where id=$2 and tenant_id=$3 and organization_group_id is null`, [GROUP, m.id, TENANT]);
        assert(result.rowCount === 1, 'GROUP_UPDATE_COUNT'); groupUpdates++;
      }
      if (m.domainChange) {
        const result = m.preferenceExisted
          ? await c.query(`update public.organization_preference_value set value=$1,updated_at=now()
              where organization_id=$2 and field_id=$3 and value is not distinct from $4`,
            [m.desiredValue, m.id, FIELD, m.beforeValue])
          : await c.query(`insert into public.organization_preference_value(organization_id,field_id,value)
              values($1,$2,$3)`, [m.id, FIELD, m.desiredValue]);
        assert(result.rowCount === 1, 'DOMAIN_WRITE_COUNT'); domainWrites++;
      }
    }
    const after = await data(c);
    assert(complete(approved, after), 'FINAL_ROW_VERIFICATION_FAILED');
    assert(after.organizations.length === before.organizations.length + created, 'ORGANIZATION_COUNT_MISMATCH');
    assert(after.preferences.length === before.preferences.length + matches.filter(m => m.domainChange && !m.preferenceExisted).length, 'PREFERENCE_COUNT_MISMATCH');
    assert(hash(after.otherPreferences) === hash(before.otherPreferences), 'UNRELATED_PREFERENCES_CHANGED');
    const targets = new Set(matches.map(m => m.id));
    assert(hash(before.organizations.filter(o => !targets.has(o.id))) ===
      hash(after.organizations.filter(o => !targets.has(o.id))), 'UNRELATED_ORGANIZATIONS_CHANGED');
    assert(hash(before.preferences.filter(p => !targets.has(p.organization_id))) ===
      hash(after.preferences.filter(p => !targets.has(p.organization_id))), 'UNRELATED_DOMAINS_CHANGED');
    const afterEvidence = await evidence(c);
    assert(hash(afterEvidence) === hash(beforeEvidence), 'WORKFLOW_QUEUE_OR_LOGIN_SIDE_EFFECT');
    assert((await guard(c)).hash === schema.hash, 'SCHEMA_OR_FUNCTION_CHANGED_DURING_IMPORT');
    assert((await configuration(c)).hash === config.hash, 'CONFIG_CHANGED_DURING_IMPORT');
    assert(Date.now() - started < 90000, 'TRANSACTION_TIME_BUDGET_EXCEEDED');
    commitAttempted = true;
    await c.query('commit'); committed = true;
    report(approved, after, 'committed and verified');
    const result = { mode: 'applied', approvedHash, created, reused: 22 - created, groupUpdates, domainWrites,
      beforeEvidence, afterEvidence, schemaHash: schema.hash, activity: REPORT };
    writeFileSync('attached_assets/gfi-ahecs-import-result.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!committed) await c.query('rollback').catch(() => {});
    // Do not print database errors, query values, credentials, or stack traces.
    console.error(JSON.stringify({ status: committed ? 'COMMITTED_REPORT_WRITE_FAILED' :
      commitAttempted ? 'COMMIT_OUTCOME_UNKNOWN_RECHECK_BEFORE_RETRY' : 'NOT_COMMITTED',
      error: error.code || (/^[A-Z_]+(?::[a-z0-9.-]+)?$/.test(error.message) ? error.message : 'IMPORT_FAILED') }));
    process.exitCode = 1;
  } finally { await c.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'NOT_STARTED', error: error.code ||
      (/^[A-Z_]+$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED') }));
    process.exitCode = 1;
  });
}