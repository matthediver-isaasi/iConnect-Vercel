#!/usr/bin/env node
// Dedicated READ-ONLY preflight. No apply path until this cohort's side effects
// have been reviewed and explicitly authorized. Earlier approvals cannot apply.
import { readFileSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination, schemaEvidence, digest, PROJECT } from './import-bnms-final-members.mjs';
import { FILE, TENANT_ID, FIELDS, parseSourceBytes, clean } from './bnms-september-source.mjs';
export const DIRECTORY = path.resolve('exports/bnms-september-import');
export const FOCUS = '9e6a7200-1194-4e75-98d1-25a29303e95e';
export const ASSIGNMENT_OBJECT = '1c1cdab9-5128-4e3d-b09e-b97088ae69ba';
export const ASSIGNMENT_MEMBER = '601544ca-9db9-498e-bd03-0af5e2c2e8a0';
export const ASSIGNMENT_ORG = '184b26ff-c918-4162-98c4-1e16fde737ad';
export function regionalEvidence(rows, state) {
  const memberField = '0e3e3b1f-5a3d-40b5-a4b5-f0761c115216';
  const orgField = '91e58f93-f78f-465e-948b-c4808aecd89c';
  const groups = state.automaticGroups.filter(g => g.automatic_membership_enabled);
  const supported = groups.every(g => g.automatic_membership_role === 'Member'
    && Array.isArray(g.automatic_membership_filter_groups) && g.automatic_membership_filter_groups.length === 2
    && g.automatic_membership_filter_groups.every(f => Object.keys(f).length === 1 && Array.isArray(f.conditions) && f.conditions.length === 1
      && f.conditions.every(c => Object.keys(c).sort().join(',') === 'data_type,entity_scope,field_key,field_type,operator,value'
        && c.operator === 'equals' && c.field_type === 'custom' && c.data_type === 'select' && typeof c.value === 'string'
        && ((c.entity_scope === 'member' && c.field_key === memberField) || (c.entity_scope === 'organization' && c.field_key === orgField))))
    && new Set(g.automatic_membership_filter_groups.map(f => f.conditions[0].entity_scope)).size === 2
    && new Set(g.automatic_membership_filter_groups.map(f => f.conditions[0].value)).size === 1);
  return { supported, enabledGroupCount: groups.length, globalQueueOnEveryMemberInsert: true,
    limitation: 'Predicted rule matches do not authorize group assignments. Every member insert queues all enabled tenant groups, including nonmatching rows.',
    rows: supported ? rows.map(row => {
      const prefs = state.orgPreferences.filter(p => p.organization_id === row.organizationId && p.field_id === orgField);
      return { sourceRow: row.sourceRow, ambiguousOrganizationRegion: prefs.length > 1, matchingGroupIds: groups.filter(g => g.automatic_membership_filter_groups.some(f => {
        const c = f.conditions[0]; return c.value === (c.entity_scope === 'member' ? row.values[16] : String(prefs[0]?.value ?? ''));
      })).map(g => g.id) };
    }) : [] };
}
export function savePrivate(name, data) {
  if (!/^[a-z-]+\.json$/.test(name)) throw Error('Invalid evidence filename');
  execFileSync('git', ['check-ignore', '-q', `${DIRECTORY}/${name}`]);
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 }); chmodSync(DIRECTORY, 0o700);
  const file = path.join(DIRECTORY, name);
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); chmodSync(file, 0o600);
}
export async function loadState(client) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;
  const tenant = await q('select id,name from public.tenant where id=$1', [TENANT_ID]);
  if (tenant.length !== 1 || tenant[0].name !== 'BNMS') throw Error('Pinned BNMS tenant mismatch');
  const state = {};
  for (const [key, table] of Object.entries({ fields: 'preference_field', categories: 'resource_category', groups: 'organization_group', organizations: 'organization', objects: 'custom_object_definition', departments: 'custom_object_record', definitions: 'custom_object_relationship_definition', edges: 'custom_object_relationship', automaticGroups: 'member_group' })) {
    state[key] = await q(`select * from public.${table} where tenant_id=$1 order by id`, [TENANT_ID]);
  }
  // Complete tenant identities plus globally scoped legacy field references.
  state.members = await q('select id,tenant_id,email,first_name,last_name,mobile,organization_id,organization_group_id from public.member where tenant_id=$1 order by id', [TENANT_ID]);
  state.legacy = await q('select id,member_id,value from public.member_preference_value where field_id=$1 order by id', [FIELDS[0].id]);
  state.preferences = await q('select p.* from public.member_preference_value p join public.member m on m.id=p.member_id where m.tenant_id=$1 order by p.id', [TENANT_ID]);
  state.memberCategories = await q('select p.* from public.member_resource_category p join public.member m on m.id=p.member_id where m.tenant_id=$1 order by p.id', [TENANT_ID]);
  state.orgPreferences = await q('select p.* from public.organization_preference_value p join public.organization o on o.id=p.organization_id where o.tenant_id=$1 order by p.id', [TENANT_ID]);
  return state;
}
export function makeReport(source, state, schema) {
  const mappings = FIELDS.map(contract => {
    const matches = state.fields.filter(f => f.id === contract.id || (f.entity_scope === 'member' && (f.name === contract.name || f.label === contract.label)));
    const f = matches[0];
    const verified = matches.length === 1 && f.id === contract.id && f.tenant_id === TENANT_ID && f.entity_scope === 'member' && f.name === contract.name && f.label === contract.label && f.field_type === contract.type && f.is_active === true && f.is_read_only !== true && f.is_writable !== false;
    return { ...contract, verified, options: f?.options };
  });
  const category = state.categories.filter(c => c.id === FOCUS || c.name === 'Focus Area');
  const categoryValid = category.length === 1 && category[0].id === FOCUS && category[0].tenant_id === TENANT_ID && category[0].is_active === true;
  const activeRules = state.automaticGroups.filter(g => g.automatic_membership_enabled);
  // The live audit must be reviewed, not equated with an old pinned schema hash.
  const queueTriggers = schema.triggers.filter(t => t.tgenabled !== 'D' && /queue|automatic_membership/i.test(`${t.definition} ${t.function}`));
  const safetyBlockers = queueTriggers.length ? ['Live member/preference triggers queue automatic-group reconciliation; this workbook has no approval for existing-assignment rechecks. No writes permitted pending review and explicit approval.'] : ['Live trigger/default and application side-effect audit requires review before enabling any apply path.'];
  const core = { 5: 'first_name', 6: 'last_name', 8: 'email', 10: 'mobile' };
  const rows = source.rows.map(row => {
    const reasons = [...row.reasons], changes = [];
    const emails = state.members.filter(m => clean(m.email).toLowerCase() === row.email);
    const legacy = state.legacy.filter(p => clean(p.value) === row.legacyId);
    const ids = [...new Set([...emails.map(m => m.id), ...legacy.map(p => p.member_id)])];
    if (emails.length > 1 || legacy.length > 1 || ids.length > 1) reasons.push('Ambiguous email/legacy identity; no merge authorized');
    if (ids.some(id => !state.members.some(m => m.id === id))) reasons.push('Missing or foreign legacy identity');
    const member = ids.length === 1 ? state.members.find(m => m.id === ids[0]) : null;
    const compare = (field, actual, desired) => {
      if (desired && clean(actual) !== desired) changes.push({ field, current: actual ?? null, desired });
    };
    for (const [c, field] of Object.entries(core)) {
      if (!schema.columns.some(col => col.table_name === 'member' && col.column_name === field && ['text', 'character varying'].includes(col.data_type))) reasons.push(`Missing text core field ${field}`);
      compare(field, field === 'email' ? clean(member?.[field]).toLowerCase() : member?.[field], row.values[c]);
    }
    for (const mapping of mappings) {
      const raw = row.values[mapping.column];
      if (!mapping.verified) reasons.push(`Unverified field ${mapping.label}`);
      if (raw && mapping.type === 'dropdown' && (!Array.isArray(mapping.options) || mapping.options.filter(o => o.value === raw).length !== 1)) reasons.push(`Unsupported option for ${mapping.label}`);
      const existing = state.preferences.filter(p => p.member_id === member?.id && p.field_id === mapping.id);
      if (existing.length > 1) reasons.push(`Duplicate destination ${mapping.label}`);
      compare(mapping.label, existing[0]?.value, raw);
    }
    if (row.focusAreas.length && !categoryValid) reasons.push('Unverified Focus Area category');
    for (const name of row.focusAreas) {
      if (!category[0]?.subcategories?.includes(name)) reasons.push('Unsupported Focus Area label');
      const existing = state.memberCategories.filter(c => c.member_id === member?.id && c.resource_category_id === FOCUS && c.subcategory_name === name);
      if (existing.length > 1) reasons.push('Duplicate destination Focus Area');
      compare(`Focus Area:${name}`, existing.length ? name : null, name);
    }
    let organizationId = row.values[12] || null;
    const departmentLinks = [];
    for (const [c, key] of [[11, 'groups'], [12, 'organizations']]) {
      if (row.values[c] && !state[key].some(t => t.id === row.values[c] && t.tenant_id === TENANT_ID && !t.archived_at)) reasons.push(`Missing, archived or foreign ${key} reference`);
    }
    for (const departmentId of row.departmentIds || []) {
      const department = state.departments.find(d => d.id === departmentId && d.tenant_id === TENANT_ID && !d.archived_at);
      if (!department) reasons.push('Missing, archived or foreign departments reference');
      const defs = state.definitions.filter(d => d.source_custom_object_id === department?.custom_object_id && d.status === 'active');
      const parentDefs = defs.filter(d => d.relationship_key === 'organisation' && d.source_kind === 'custom_object' && d.target_kind === 'organization' && d.cardinality === 'many_to_one');
      const memberDefs = defs.filter(d => d.relationship_key === 'members' && d.source_kind === 'custom_object' && d.target_kind === 'member' && d.cardinality === 'many_to_many');
      const parents = state.edges.filter(e => !e.archived_at && e.source_record_id === department?.id && e.relationship_definition_id === parentDefs[0]?.id);
      if (parentDefs.length !== 1 || memberDefs.length !== 1 || parents.length !== 1 || !state.organizations.some(o => o.id === parents[0]?.target_record_id && !o.archived_at)) reasons.push('Department relationship/parent contract unavailable');
      else departmentLinks.push({ departmentId, organizationId: parents[0].target_record_id, definitionId: memberDefs[0].id });
      // Current supported model requires both the Department member edge and
      // a live Organisation-assignment record with its two relationship edges.
      const assignmentMember = state.definitions.find(d => d.id === ASSIGNMENT_MEMBER);
      const assignmentOrg = state.definitions.find(d => d.id === ASSIGNMENT_ORG);
      const picker = memberDefs[0]?.configuration?.picker_scope;
      if (![assignmentMember, assignmentOrg].every(d => d?.tenant_id === TENANT_ID && d.status === 'active' && d.source_kind === 'custom_object' && d.source_custom_object_id === ASSIGNMENT_OBJECT && d.cardinality === 'many_to_one')
        || assignmentMember?.target_kind !== 'member' || assignmentOrg?.target_kind !== 'organization'
        || picker?.version !== 2 || picker.match !== 'intersects'
        || picker.source_path?.length !== 1 || picker.source_path[0]?.relationship_definition_id !== parentDefs[0]?.id || picker.source_path[0]?.from_side !== 'source'
        || picker.target_path?.length !== 2 || picker.target_path[0]?.relationship_definition_id !== ASSIGNMENT_MEMBER || picker.target_path[0]?.from_side !== 'target'
        || picker.target_path[1]?.relationship_definition_id !== ASSIGNMENT_ORG || picker.target_path[1]?.from_side !== 'source') reasons.push('Department Organisation-assignment/picker-scope model drifted');
      if (member && memberDefs.length === 1) {
        const departmentEdges = state.edges.filter(e => !e.archived_at && e.relationship_definition_id === memberDefs[0].id && e.source_record_id === department?.id && e.target_record_id === member.id);
        if (departmentEdges.length !== 1) reasons.push('Existing Department member edge absent or ambiguous; no updates authorized');
        const assignments = state.departments.filter(d => !d.archived_at && d.custom_object_id === ASSIGNMENT_OBJECT && state.edges.some(e => !e.archived_at && e.source_record_id === d.id && e.relationship_definition_id === ASSIGNMENT_MEMBER && e.target_record_id === member.id));
        const orgEdges = state.edges.filter(e => !e.archived_at && assignments.some(a => a.id === e.source_record_id) && e.relationship_definition_id === ASSIGNMENT_ORG && e.target_record_id === parents[0]?.target_record_id);
        if (orgEdges.length !== 1) reasons.push('Existing Organisation-assignment absent or ambiguous; no updates authorized');
      }
    }
    const parentOrganizationIds = [...new Set(departmentLinks.map(d => d.organizationId))].sort();
    if (parentOrganizationIds.length === 1) organizationId = parentOrganizationIds[0];
    // More than one parent: retain ALL assignments and leave the singular core
    // FK empty. Source order is never a primary-organisation instruction.
    if (row.departmentIds?.length && (!state.objects?.some(o => o.id === ASSIGNMENT_OBJECT && o.status === 'active')
      || departmentLinks.some(d => !state.objects?.some(o => o.id === state.departments.find(r => r.id === d.departmentId)?.custom_object_id && o.status === 'active')))) reasons.push('Department or assignment Custom Object unavailable');
    if (row.values[11]) {
      compare('organization_group_id', member?.organization_group_id, row.values[11]);
      if (member?.organization_id) reasons.push('Conflicting existing Organisation');
    }
    if (organizationId) {
      compare('organization_id', member?.organization_id, organizationId);
      if (member?.organization_group_id) reasons.push('Conflicting existing Group');
    }
    for (const field of ['organization_id', 'organization_group_id']) if (!schema.columns.some(c => c.table_name === 'member' && c.column_name === field && c.is_nullable === 'YES')) reasons.push(`Nullable ${field} not confirmed`);
    if (member && changes.length) reasons.push('Existing record differs or needs additions; no existing-member update authorized');
    return { ...row, memberIds: ids, changes, organizationId, departmentLinks, parentOrganizationIds, outcome: reasons.length ? 'held-validation' : member ? 'already-present-matching' : 'held-side-effects', reasons: [...new Set(reasons.length ? reasons : member ? [] : safetyBlockers)] };
  });
  for (const row of rows) if (row.memberIds.some(id => rows.some(other => other !== row && other.memberIds.includes(id)))) {
    row.outcome = 'held-validation'; row.reasons.push('Destination identity matched by multiple source rows');
  }
  return { project: PROJECT, tenant: TENANT_ID, fingerprint: source.fingerprint, generatedAt: new Date().toISOString(), schemaHash: digest(schema), snapshotHash: digest(state),
    sourceCounts: source.counts, counts: Object.fromEntries([...new Set(rows.map(r => r.outcome))].map(k => [k, rows.filter(r => r.outcome === k).length])), mappings,
    phoneSemantics: 'Opaque source Phone -> member.mobile: MembersList.jsx phone filter explicitly maps to mobile; landline is a distinct field. No numeric conversion, international inference, or lost leading zero.',
    safetyBlockers, automaticRules: activeRules, queueTriggers: queueTriggers.map(t => ({ table: t.relname, name: t.tgname })),
    safety: { readOnly: true, mutationStatements: 0, providerMutations: 0, imported: 0, migrationsNeeded: false, migrationsApplied: false }, rows };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length) throw Error('Read-only September preflight accepts no arguments; no apply authorized');
  const source = parseSourceBytes(readFileSync(FILE));
  const client = await connectDestination();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='60s'");
    if ((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw Error('Read-only guard failed');
    const schema = await schemaEvidence(client);
    const state = await loadState(client);
    // Department writes reach additional tables: retain their trigger/default evidence too.
    schema.departmentColumns = (await client.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name in ('custom_object_record','custom_object_record_history') order by table_name,ordinal_position")).rows;
    schema.departmentTriggers = (await client.query("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,pg_get_functiondef(t.tgfoid) function from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('custom_object_record','custom_object_record_history') and not t.tgisinternal order by c.relname,t.tgname")).rows;
    const report = makeReport(source, state, schema);
    report.regionalEvidence = regionalEvidence(report.rows, state);
    report.sourceProtection = { sha256: source.fingerprint, ignored: true,
      indexTracked: execFileSync('git', ['ls-files', '--', FILE], { encoding: 'utf8' }).trim() !== '',
      inheritedHistoryFound: execFileSync('git', ['log', '--all', '--format=%H', '--', FILE], { encoding: 'utf8' }).trim() !== '',
      limitation: 'Index and reachable Git refs checked; no claim of backup/cache purging.' };
    report.applicationSourceHashes = Object.fromEntries(['api/cron/process-automatic-memberships.js', 'api/_lib/automaticMembership.js', 'api/_lib/automaticMembershipQuery.js'].map(file => [file, digest(readFileSync(file, 'utf8'))]));
    report.auditConclusion = 'Live member INSERT trigger calls queue_automatic_memberships_for_source_changes with p_match_all=true. Helper resets generation/status/cursor for every enabled BNMS group. The scheduled reconciler operates on the complete target set and may remove stale automatic assignments on its final batch. This is a global approval blocker even for unassigned/nonmatching source rows. Full write-side-effect audit and transactional apply/replay remain intentionally unimplemented pending this decision.';
    savePrivate('schema.json', schema); savePrivate('snapshot.json', state); savePrivate('preflight.json', report);
    console.log(JSON.stringify({ counts: report.counts, sourceCounts: report.sourceCounts, safety: report.safety, schemaHash: report.schemaHash, safetyBlockers: report.safetyBlockers, directory: DIRECTORY }));
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('September preflight failed; no writes attempted. Check pinned connection/schema prerequisites without exposing credentials.'); process.exitCode = 1; });