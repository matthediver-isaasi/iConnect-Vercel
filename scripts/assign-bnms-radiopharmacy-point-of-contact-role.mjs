#!/usr/bin/env node
/**
 * Dry-run-first assignment of the existing BNMS Point of Contact role to the
 * exact 55 Members created by the pinned Radiopharmacy import.
 *
 * Usage:
 *   node scripts/assign-bnms-radiopharmacy-point-of-contact-role.mjs
 *   node scripts/assign-bnms-radiopharmacy-point-of-contact-role.mjs --apply
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  ROW_COUNT,
  SHARON_MEMBER_ID,
  TENANT_ID,
  readSource,
} from './import-bnms-radiopharmacy-members.mjs';

export const ROLE_ID = '0c329e46-898f-4660-acaf-c0d3d49993c0';
export const ROLE_NAME = 'Point of Contact';

export function fail(message) { throw new Error(message); }
function check(error, context) { if (error) fail(`${context}: ${error.message}`); }
function emailKey(value) { return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-GB'); }

function destinationClient() {
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required; SOURCE and bare SUPABASE credentials are forbidden.');
  }
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false },
  });
}

async function fetchAll(db, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    let query = db.from(table).select(columns).order('id', { ascending: true }).range(from, from + 499);
    query = configure(query);
    const { data, error } = await query;
    check(error, `Could not read ${table}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

async function auditRole(db) {
  const { data: tenant, error: tenantError } = await db.from('tenant')
    .select('id, name').eq('id', TENANT_ID).maybeSingle();
  check(tenantError, 'Could not resolve pinned BNMS tenant');
  if (tenant?.id !== TENANT_ID || !/\bbnms\b|british nuclear medicine society/i.test(tenant.name || '')) {
    fail(`Pinned tenant is not BNMS (${tenant?.name || 'not found'}).`);
  }
  const roles = await fetchAll(db, 'role',
    'id, tenant_id, name, is_admin, is_tenant_admin, requires_effective_from_date',
    (query) => query.eq('tenant_id', TENANT_ID).ilike('name', ROLE_NAME));
  if (roles.length !== 1) fail(`Expected exactly one BNMS role named "${ROLE_NAME}"; found ${roles.length}.`);
  const role = roles[0];
  if (role.id !== ROLE_ID || role.name !== ROLE_NAME || role.tenant_id !== TENANT_ID
    || role.is_admin || role.is_tenant_admin || role.requires_effective_from_date) {
    fail(`BNMS "${ROLE_NAME}" role no longer matches the approved non-admin role contract.`);
  }
  return { tenant, role };
}

async function auditDepartmentModel(db) {
  const objects = await fetchAll(db, 'custom_object_definition', 'id',
    (query) => query.eq('tenant_id', TENANT_ID).eq('object_key', 'org_department').eq('status', 'active'));
  if (objects.length !== 1) fail(`Expected exactly one active BNMS Department object; found ${objects.length}.`);
  const definitions = await fetchAll(db, 'custom_object_relationship_definition',
    'id, relationship_key, source_kind, source_custom_object_id, target_kind, target_custom_object_id, cardinality, is_required',
    (query) => query.eq('tenant_id', TENANT_ID).eq('status', 'active'));
  const parents = definitions.filter((row) => row.relationship_key === 'organisation'
    && row.source_kind === 'custom_object' && row.source_custom_object_id === objects[0].id
    && row.target_kind === 'organization' && row.target_custom_object_id === null
    && row.cardinality === 'many_to_one' && row.is_required);
  const members = definitions.filter((row) => row.relationship_key === 'members'
    && row.source_kind === 'custom_object' && row.source_custom_object_id === objects[0].id
    && row.target_kind === 'member' && row.target_custom_object_id === null
    && row.cardinality === 'many_to_many' && !row.is_required);
  if (parents.length !== 1 || members.length !== 1) {
    fail(`BNMS Department relationship model is unavailable (${parents.length} parent, ${members.length} member definitions).`);
  }
  return { parentDefinitionId: parents[0].id, memberDefinitionId: members[0].id };
}

async function loadState(db, source, model) {
  const memberIds = source.rows.map((row) => row.memberId);
  const [allMembers, importedMembers, parentEdges, memberEdges] = await Promise.all([
    fetchAll(db, 'member', 'id, role_id', (query) => query.eq('tenant_id', TENANT_ID)),
    fetchAll(db, 'member',
      'id, tenant_id, email, first_name, last_name, organization_id, role_id, role_effective_from, login_enabled, show_in_directory, is_guest',
      (query) => query.eq('tenant_id', TENANT_ID).in('id', memberIds)),
    fetchAll(db, 'custom_object_relationship',
      'id, source_record_id, target_record_id, archived_at',
      (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.parentDefinitionId)
        .is('archived_at', null)),
    fetchAll(db, 'custom_object_relationship',
      'id, source_record_id, target_record_id, archived_at',
      (query) => query.eq('tenant_id', TENANT_ID).eq('relationship_definition_id', model.memberDefinitionId)
        .in('target_record_id', memberIds)),
  ]);
  if (allMembers.length !== 56) fail(`BNMS must contain exactly 56 Members including Sharon; found ${allMembers.length}.`);
  const sharon = allMembers.find((row) => row.id === SHARON_MEMBER_ID);
  if (!sharon) fail('Sharon recovery Member is missing.');
  if (importedMembers.length !== ROW_COUNT) fail(`Expected all ${ROW_COUNT} imported Members; found ${importedMembers.length}.`);
  return { allMembers, importedMembers, parentEdges, memberEdges, sharon };
}

export function makePlan(source, state) {
  const byId = new Map(state.importedMembers.map((row) => [row.id, row]));
  const items = source.rows.map((row) => {
    const member = byId.get(row.memberId);
    if (!member || member.tenant_id !== TENANT_ID
      || emailKey(member.email) !== emailKey(row.email)
      || member.first_name !== row.firstName
      || member.last_name !== row.lastName
      || member.login_enabled !== true
      || member.show_in_directory !== true
      || member.is_guest !== false) {
      fail(`Imported Member invariant failed at source row ${row.sourceRow}.`);
    }
    const related = state.memberEdges.filter((edge) => edge.target_record_id === member.id && edge.archived_at === null);
    const byDepartment = new Map();
    for (const edge of related) {
      if (edge.tenant_id != null && edge.tenant_id !== TENANT_ID) {
        fail(`Department-to-Member invariant failed at source row ${row.sourceRow}: wrong tenant.`);
      }
      const matches = byDepartment.get(edge.source_record_id) || [];
      matches.push(edge);
      byDepartment.set(edge.source_record_id, matches);
      if (matches.length > 1) {
        fail(`Department-to-Member invariant failed at source row ${row.sourceRow}: duplicate assignment.`);
      }
      const parents = state.parentEdges.filter((parent) => parent.source_record_id === edge.source_record_id
        && parent.archived_at === null);
      if (parents.length !== 1 || parents[0].target_record_id !== member.organization_id) {
        fail(`Department-to-Organisation invariant failed at source row ${row.sourceRow}.`);
      }
    }
    if ((byDepartment.get(row.departmentId) || []).length !== 1) {
      fail(`Department-to-Member invariant failed at source row ${row.sourceRow}.`);
    }
    if (member.role_id !== null && member.role_id !== ROLE_ID) {
      fail(`Imported Member at source row ${row.sourceRow} already has another role.`);
    }
    if (member.role_effective_from !== null) {
      fail(`Imported Member at source row ${row.sourceRow} unexpectedly has a role effective-from date.`);
    }
    return { row, member, action: member.role_id === ROLE_ID ? 'unchanged' : 'assign' };
  });
  const assignments = items.filter((item) => item.action === 'assign').length;
  if (![0, ROW_COUNT].includes(assignments)) {
    fail(`Mixed role state detected: ${assignments}/${ROW_COUNT} Members require assignment.`);
  }
  return { items, assignments, unchanged: ROW_COUNT - assignments };
}

function report(source, audit, state, plan) {
  console.log('\n--- Validated source and destination ---');
  console.log(`  Workbook SHA-256:                 ${source.fingerprint}`);
  console.log(`  Tenant:                           ${audit.tenant.name} (${TENANT_ID})`);
  console.log(`  Role:                             ${audit.role.name} (${audit.role.id})`);
  console.log(`  Exact imported Members:           ${state.importedMembers.length}/${ROW_COUNT}`);
  console.log(`  Required source Department links: ${ROW_COUNT}/${ROW_COUNT}`);
  console.log(`  Total active Department links:    ${state.memberEdges.filter((row) => row.archived_at === null).length}`);
  console.log(`  Total BNMS Members incl. Sharon:  ${state.allMembers.length}/56`);
  console.log('\n--- Planned totals ---');
  console.log(`  Role assignments:                 ${plan.assignments}`);
  console.log(`  Already assigned:                 ${plan.unchanged}`);
}

async function applyPlan(db, plan) {
  if (!plan.assignments) return 0;
  const ids = plan.items.map((item) => item.member.id);
  const { data, error } = await db.from('member')
    .update({ role_id: ROLE_ID })
    .eq('tenant_id', TENANT_ID)
    .is('role_id', null)
    .in('id', ids)
    .select('id, tenant_id, role_id');
  check(error, 'Atomic Point of Contact role assignment failed');
  if ((data || []).length !== ROW_COUNT
    || data.some((row) => row.tenant_id !== TENANT_ID || row.role_id !== ROLE_ID || !ids.includes(row.id))) {
    fail(`Role assignment returned an unexpected result (${(data || []).length}/${ROW_COUNT} rows).`);
  }
  return data.length;
}

async function verify(db, source, model, sharonRoleBefore) {
  const state = await loadState(db, source, model);
  const plan = makePlan(source, state);
  if (plan.assignments !== 0 || plan.unchanged !== ROW_COUNT) {
    fail('Post-assignment verification failed or a second run would still write.');
  }
  if (state.sharon.role_id !== sharonRoleBefore) fail('Sharon role changed unexpectedly.');
  console.log('\n--- Post-assignment verification ---');
  console.log(`  Point of Contact assignments:     ${plan.unchanged}/${ROW_COUNT}`);
  console.log(`  Member profile invariants:         ${ROW_COUNT}/${ROW_COUNT}`);
  console.log(`  Organisation assignments:         ${ROW_COUNT}/${ROW_COUNT}`);
  console.log(`  Required Department relationships:${ROW_COUNT}/${ROW_COUNT} (additional valid links preserved)`);
  console.log('  Sharon role:                       unchanged');
  console.log('  Total BNMS Members incl. Sharon:   56/56');
  console.log('  Idempotent re-run:                 0 writes');
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) {
    fail('Only --apply is supported; no flag performs a dry run.');
  }
  console.log('\n=== BNMS Radiopharmacy Point of Contact assignment ===');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`);
  const source = readSource();
  const db = destinationClient();
  const audit = await auditRole(db);
  const model = await auditDepartmentModel(db);
  const state = await loadState(db, source, model);
  const plan = makePlan(source, state);
  report(source, audit, state, plan);
  if (!apply) {
    console.log('\n=== DRY RUN complete: no database rows modified ===\n');
    return;
  }
  const sharonRoleBefore = state.sharon.role_id;
  const updated = await applyPlan(db, plan);
  console.log(`\nApplied: ${updated} Point of Contact role assignments.`);
  await verify(db, source, model, sharonRoleBefore);
  console.log('\n=== Assignment complete ===\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nERROR: ${error.message}`);
    process.exit(1);
  });
}
