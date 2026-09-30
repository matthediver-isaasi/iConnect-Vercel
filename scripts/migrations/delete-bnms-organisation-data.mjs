#!/usr/bin/env node

/**
 * Remove all Organisation and Organisation Group data from BNMS.
 *
 * Members are retained. Their organization_id is cleared. Member Groups and
 * Member Group assignments are read and verified but never mutated.
 *
 * Usage:
 *   node scripts/migrations/delete-bnms-organisation-data.mjs
 *   node scripts/migrations/delete-bnms-organisation-data.mjs --apply --i-have-reviewed-the-dry-run
 *
 * This script intentionally accepts DEST_SUPABASE_URL and DEST_SUPABASE_KEY
 * only. It does not fall back to the workspace's legacy Supabase variables.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const TENANT_SLUG = 'bnms';
const DEST_PROJECT_REF = 'lvmzliemqnieeoruhkik';
const PAGE_SIZE = 500;
const MUTATION_BATCH_SIZE = 150;
const MANIFEST_DIR = path.resolve('.local/task-artifacts');
const BEFORE_MANIFEST = path.join(MANIFEST_DIR, 'bnms-organisation-cleanup-before.json');
const AFTER_MANIFEST = path.join(MANIFEST_DIR, 'bnms-organisation-cleanup-after.json');
const APPROVED_CROSS_TENANT_EXCEPTION = {
  table: 'booking',
  column: 'organization_id',
  id: '2d81e61f-ab8e-43ef-b811-53ba464457f1',
  tenantId: 'fd82da65-aab7-4a5c-85b8-b2febeb2003d',
  tenantSlug: 'gfi',
  organizationId: 'd2bbe3f3-64ff-47e7-bec2-a66b8a69f0f5',
};

const SET_NULL_REFERENCES = [
  ['booking', 'organization_id'],
  ['complex_event_booking', 'organization_id'],
  ['contract_instance', 'organization_id'],
  ['form_submission', 'organization_id'],
  ['form_submission', 'created_organization_id'],
  ['fundraising_team_member', 'organization_id'],
  ['gocardless_customers', 'organization_id'],
  ['i_edit_page', 'organization_id'],
  ['i_edit_page_element', 'organization_id'],
  ['job_posting', 'posted_by_organization_id'],
  ['member', 'organization_id'],
  ['member_group_classification', 'organization_id'],
  ['membership_billing_agreements', 'organization_id'],
  ['membership_dd_cancellation_requests', 'organization_id'],
  ['membership_payment_plans', 'organization_id'],
  ['membership_tier_reminder_send', 'organization_id'],
  ['organisation_award_assignment', 'organization_id'],
  ['speaker_award_grant', 'organization_id'],
  ['team_member_invitation', 'organization_id'],
  ['training_fund_transaction', 'organization_id'],
  ['voucher_transaction', 'organization_id'],
];

// These records cannot remain meaningful or safely usable after their
// Organisation is removed. The order handles child rows before parents.
const DELETE_REFERENCES = [
  ['discount_code_usage', 'organization_id'],
  ['discount_code', 'organization_id'],
  ['guest_approval_token', 'organization_id'],
  ['membership_dd_invitations', 'organization_id'],
  ['membership_fee_token', 'organization_id'],
  ['membership_invoice_download_token', 'organization_id'],
  ['organisation_membership_history', 'organization_id'],
  ['organisation_membership_invoicing', 'organization_id'],
  ['organisation_membership_override', 'organization_id'],
  ['organization_contact', 'organization_id'],
  ['organization_note', 'organization_id'],
  ['organization_preference_value', 'organization_id'],
  ['program_ticket_transaction', 'organization_id'],
  ['training_fund_purchase', 'organization_id'],
  ['voucher_monthly_snapshot', 'organization_id'],
  ['voucher', 'organization_id'],
];

const PRESERVED_ENTITY_TABLES = [
  'member',
  'member_group',
  'member_group_assignment',
];

const CROSS_TENANT_CONTROL_TABLES = [
  'organization',
  'organization_group',
  ...PRESERVED_ENTITY_TABLES,
];

function fail(message) {
  throw new Error(message);
}

function parseArgs() {
  const args = {
    apply: false,
    verify: false,
    reviewed: false,
    help: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--i-have-reviewed-the-dry-run') args.reviewed = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`Unknown option: ${arg}`);
  }
  if (args.apply && args.verify) fail('--apply and --verify cannot be used together.');
  return args;
}

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required. SOURCE and bare SUPABASE credentials are not permitted.');
  }
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    fail('DEST_SUPABASE_URL is not a valid URL.');
  }
  if (hostname !== `${DEST_PROJECT_REF}.supabase.co`) {
    fail(`Destination project mismatch. Expected ${DEST_PROJECT_REF}.supabase.co; found ${hostname}.`);
  }
  return {
    url,
    client: createClient(url, key, { auth: { persistSession: false } }),
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/openapi+json',
    },
  };
}

function hashIds(ids) {
  const sorted = [...new Set(ids.map(String))].sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex');
}

function summarizeIds(ids) {
  return { count: ids.length, idHash: hashIds(ids) };
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function loadSchema(url, headers) {
  const response = await fetch(`${url}/rest/v1/`, { headers });
  if (!response.ok) fail(`Could not read destination API schema: HTTP ${response.status}.`);
  const schema = await response.json();
  const definitions = schema.definitions || schema.components?.schemas;
  if (!definitions) fail('Destination API schema did not contain table definitions.');
  return definitions;
}

function referenceKey(table, column) {
  return `${table}.${column}`;
}

function auditReferenceSchema(definitions) {
  const expected = new Set([
    ...SET_NULL_REFERENCES.map(([table, column]) => referenceKey(table, column)),
    ...DELETE_REFERENCES.map(([table, column]) => referenceKey(table, column)),
  ]);
  const live = new Set();

  for (const [table, definition] of Object.entries(definitions)) {
    for (const [column, property] of Object.entries(definition.properties || {})) {
      const isOrganizationForeignKey = String(property.description || '')
        .includes("<fk table='organization' column='id'/>");
      const isOrganizationSoftReference = /(?:^|_)organi[sz]ation_id$/i.test(column);
      if (!isOrganizationForeignKey && !isOrganizationSoftReference) continue;
      if (column === 'zoho_organization_id') continue;
      live.add(referenceKey(table, column));
    }
  }

  const missingPolicies = [...live].filter((key) => !expected.has(key)).sort();
  const stalePolicies = [...expected].filter((key) => !live.has(key)).sort();
  if (missingPolicies.length || stalePolicies.length) {
    const lines = ['Organisation reference policy does not match the live destination schema.'];
    if (missingPolicies.length) lines.push(`Missing policies: ${missingPolicies.join(', ')}`);
    if (stalePolicies.length) lines.push(`Stale policies: ${stalePolicies.join(', ')}`);
    fail(lines.join(' '));
  }

  const groupReferences = [];
  for (const [table, definition] of Object.entries(definitions)) {
    for (const [column, property] of Object.entries(definition.properties || {})) {
      const isGroupForeignKey = String(property.description || '')
        .includes("<fk table='organization_group' column='id'/>");
      const isGroupSoftReference = column === 'organization_group_id';
      if (isGroupForeignKey || isGroupSoftReference) {
        groupReferences.push(referenceKey(table, column));
      }
    }
  }
  const expectedGroupReferences = [
    'organization.organization_group_id',
    'organization_group_preference_value.organization_group_id',
  ];
  if (JSON.stringify(groupReferences.sort()) !== JSON.stringify(expectedGroupReferences.sort())) {
    fail(`Unexpected Organisation Group references in live schema: ${groupReferences.sort().join(', ') || '(none)'}.`);
  }

  return {
    organizationReferences: [...live].sort(),
    organizationGroupReferences: groupReferences.sort(),
  };
}

function tableHasColumn(definitions, table, column) {
  return Object.hasOwn(definitions[table]?.properties || {}, column);
}

function isApprovedCrossTenantException(table, column, row) {
  return (
    table === APPROVED_CROSS_TENANT_EXCEPTION.table
    && column === APPROVED_CROSS_TENANT_EXCEPTION.column
    && row.id === APPROVED_CROSS_TENANT_EXCEPTION.id
    && row.tenant_id === APPROVED_CROSS_TENANT_EXCEPTION.tenantId
    && row[column] === APPROVED_CROSS_TENANT_EXCEPTION.organizationId
  );
}

async function fetchTenantRows(client, table, columns, tenantId = TENANT_ID) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

async function fetchOtherTenantIds(client, table) {
  const ids = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select('id')
      .neq('tenant_id', TENANT_ID)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(`Could not read cross-tenant control ${table}: ${error.message}`);
    ids.push(...(data || []).map((row) => row.id));
    if ((data || []).length < PAGE_SIZE) return ids;
  }
}

async function fetchAllRows(client, table, columns, configure = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await configure(
      client
        .from(table)
        .select(columns)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1),
    );
    if (error) fail(`Could not read global verification rows from ${table}: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

async function fetchReferenceRows(client, definitions, table, column, organizationIds) {
  const byId = new Map();
  const hasTenantId = tableHasColumn(definitions, table, 'tenant_id');
  const columns = ['id', column, ...(hasTenantId ? ['tenant_id'] : [])].join(', ');

  for (const organizationIdChunk of chunks(organizationIds, MUTATION_BATCH_SIZE)) {
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = client
        .from(table)
        .select(columns)
        .in(column, organizationIdChunk)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) fail(`Could not inventory ${table}.${column}: ${error.message}`);
      for (const row of data || []) byId.set(String(row.id), row);
      if ((data || []).length < PAGE_SIZE) break;
    }
  }

  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function assertReferenceOwnership(definitions, table, column, rows) {
  if (!tableHasColumn(definitions, table, 'tenant_id')) return;
  const foreignRows = rows.filter(
    (row) => (
      row.tenant_id !== TENANT_ID
      && !isApprovedCrossTenantException(table, column, row)
    ),
  );
  if (foreignRows.length) {
    fail(
      `${table}.${column} has ${foreignRows.length} row(s) pointing at BNMS data `
      + 'without BNMS tenant ownership. No changes were made.',
    );
  }
}

async function resolveTenant(client) {
  const { data, error } = await client
    .from('tenant')
    .select('id, slug')
    .eq('id', TENANT_ID)
    .maybeSingle();
  if (error) fail(`Could not resolve BNMS tenant: ${error.message}`);
  if (!data || data.id !== TENANT_ID || data.slug !== TENANT_SLUG) {
    fail(`Tenant identity mismatch. Expected ${TENANT_ID} / ${TENANT_SLUG}; found ${data?.id || '(none)'} / ${data?.slug || '(none)'}.`);
  }
  return data;
}

async function buildSnapshot(
  client,
  definitions,
  schemaAudit,
  { requireApprovedException = true } = {},
) {
  const tenant = await resolveTenant(client);
  const organizations = await fetchTenantRows(client, 'organization', 'id, tenant_id, organization_group_id');
  const organizationGroups = await fetchTenantRows(client, 'organization_group', 'id, tenant_id');
  const members = await fetchTenantRows(client, 'member', 'id, tenant_id, organization_id');
  const memberGroups = await fetchTenantRows(client, 'member_group', 'id, tenant_id');
  const memberGroupAssignments = await fetchTenantRows(client, 'member_group_assignment', 'id, tenant_id');
  const organizationIds = organizations.map((row) => row.id);
  const organizationGroupIds = organizationGroups.map((row) => row.id);
  const organizationIdSet = new Set(organizationIds);
  const linkedMembers = members.filter((row) => row.organization_id != null);
  const foreignLinkedMembers = linkedMembers.filter((row) => !organizationIdSet.has(row.organization_id));

  const dependencies = {};
  const dependencyRows = {};
  const allTenantReferenceControls = {};
  for (const [action, references] of [
    ['SET NULL', SET_NULL_REFERENCES],
    ['DELETE', DELETE_REFERENCES],
  ]) {
    for (const [table, column] of references) {
      const key = referenceKey(table, column);
      if (key === 'member.organization_id') {
        const capturedParentRows = await fetchReferenceRows(
          client,
          definitions,
          table,
          column,
          organizationIds,
        );
        assertReferenceOwnership(definitions, table, column, capturedParentRows);
        allTenantReferenceControls[key] = summarizeIds(capturedParentRows.map((row) => row.id));
      }
      // Clear every Organisation link on BNMS Members. This also safely repairs
      // a cross-tenant link without modifying the Organisation it points to.
      const rows = key === 'member.organization_id'
        ? linkedMembers
        : await fetchReferenceRows(client, definitions, table, column, organizationIds);
      assertReferenceOwnership(definitions, table, column, rows);
      dependencyRows[key] = rows;
      dependencies[key] = {
        action,
        ownership: tableHasColumn(definitions, table, 'tenant_id')
          ? 'tenant_id verified as BNMS'
          : 'derived from captured BNMS Organisation ID',
        ...summarizeIds(rows.map((row) => row.id)),
      };
    }
  }

  const groupPreferenceRows = await fetchReferenceRows(
    client,
    definitions,
    'organization_group_preference_value',
    'organization_group_id',
    organizationGroupIds,
  );
  assertReferenceOwnership(
    definitions,
    'organization_group_preference_value',
    'organization_group_id',
    groupPreferenceRows,
  );
  dependencyRows['organization_group_preference_value.organization_group_id'] = groupPreferenceRows;
  dependencies['organization_group_preference_value.organization_group_id'] = {
    action: 'DELETE',
    ownership: 'tenant_id verified as BNMS',
    ...summarizeIds(groupPreferenceRows.map((row) => row.id)),
  };

  const crossTenantControls = {};
  for (const table of CROSS_TENANT_CONTROL_TABLES) {
    crossTenantControls[table] = summarizeIds(await fetchOtherTenantIds(client, table));
  }

  const approvedExceptionRows = dependencyRows['booking.organization_id']
    .filter((row) => isApprovedCrossTenantException('booking', 'organization_id', row));
  const { data: approvedTenant, error: approvedTenantError } = await client
    .from('tenant')
    .select('id, slug')
    .eq('id', APPROVED_CROSS_TENANT_EXCEPTION.tenantId)
    .maybeSingle();
  if (approvedTenantError) {
    fail(`Could not validate approved exception tenant: ${approvedTenantError.message}`);
  }
  if (
    !approvedTenant
    || approvedTenant.id !== APPROVED_CROSS_TENANT_EXCEPTION.tenantId
    || approvedTenant.slug !== APPROVED_CROSS_TENANT_EXCEPTION.tenantSlug
  ) {
    fail('Approved cross-tenant exception tenant identity does not match GFI.');
  }
  if (requireApprovedException && approvedExceptionRows.length !== 1) {
    fail(`Expected exactly one approved GFI booking exception; found ${approvedExceptionRows.length}.`);
  }

  const snapshot = {
    tenant,
    schema: schemaAudit,
    bnms: {
      organizations: summarizeIds(organizationIds),
      organizationGroups: summarizeIds(organizationGroupIds),
      members: summarizeIds(members.map((row) => row.id)),
      linkedMembers: summarizeIds(linkedMembers.map((row) => row.id)),
      membersLinkedOutsideBnms: summarizeIds(foreignLinkedMembers.map((row) => row.id)),
      memberGroups: summarizeIds(memberGroups.map((row) => row.id)),
      memberGroupAssignments: summarizeIds(memberGroupAssignments.map((row) => row.id)),
    },
    dependencies,
    allTenantReferenceControls,
    approvedCrossTenantException: {
      table: APPROVED_CROSS_TENANT_EXCEPTION.table,
      column: APPROVED_CROSS_TENANT_EXCEPTION.column,
      tenantId: approvedTenant.id,
      tenantSlug: approvedTenant.slug,
      bookingIdHash: hashIds(approvedExceptionRows.map((row) => row.id)),
      organizationIdHash: hashIds(approvedExceptionRows.map((row) => row.organization_id)),
      matched: approvedExceptionRows.length,
    },
    crossTenantControls,
  };

  return {
    snapshot,
    working: {
      organizationIds,
      organizationGroupIds,
      dependencyRows,
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function printSnapshot(snapshot, digest, mode) {
  console.log('BNMS Organisation cleanup');
  console.log(`Mode: ${mode}`);
  console.log(`Tenant: ${snapshot.tenant.id} / ${snapshot.tenant.slug}`);
  console.log('');
  console.log('Preserved entities');
  console.log(`  Members:                  ${snapshot.bnms.members.count}`);
  console.log(`  Members with Organisation:${String(snapshot.bnms.linkedMembers.count).padStart(6)}`);
  if (snapshot.bnms.membersLinkedOutsideBnms.count) {
    console.log(`    linked outside BNMS:    ${String(snapshot.bnms.membersLinkedOutsideBnms.count).padStart(6)} (Member link only will be cleared)`);
  }
  console.log(`  Member Groups:            ${String(snapshot.bnms.memberGroups.count).padStart(6)}`);
  console.log(`  Member Group assignments: ${String(snapshot.bnms.memberGroupAssignments.count).padStart(6)}`);
  console.log('');
  console.log('Entities to remove');
  console.log(`  Organisations:            ${String(snapshot.bnms.organizations.count).padStart(6)}`);
  console.log(`  Organisation Groups:      ${String(snapshot.bnms.organizationGroups.count).padStart(6)}`);
  console.log('');
  console.log('Dependent rows');
  for (const [key, value] of Object.entries(snapshot.dependencies)) {
    if (value.count) console.log(`  ${value.action.padEnd(8)} ${key}: ${value.count}`);
  }
  if (snapshot.approvedCrossTenantException.matched) {
    console.log(
      `  APPROVED cross-tenant link cleanup: ${snapshot.approvedCrossTenantException.matched} `
      + `${snapshot.approvedCrossTenantException.tenantSlug} booking`,
    );
  }
  console.log('');
  console.log(`Review digest: ${digest}`);
}

function assertSame(label, before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail(`${label} changed unexpectedly. Before=${JSON.stringify(before)} After=${JSON.stringify(after)}.`);
  }
}

async function setReferencesNull(client, definitions, table, column, rows) {
  if (!rows.length) return 0;
  const hasTenantId = tableHasColumn(definitions, table, 'tenant_id');
  let changed = 0;

  const normalRows = rows.filter((row) => !isApprovedCrossTenantException(table, column, row));
  const approvedRows = rows.filter((row) => isApprovedCrossTenantException(table, column, row));
  for (const [scope, scopedRows] of [
    ['BNMS_OR_NULL', normalRows],
    ['APPROVED_EXCEPTION', approvedRows],
  ]) {
    for (const rowChunk of chunks(scopedRows, MUTATION_BATCH_SIZE)) {
      let query = client
        .from(table)
        .update({ [column]: null })
        .in('id', rowChunk.map((row) => row.id))
        .in(column, [...new Set(rowChunk.map((row) => row[column]))]);
      if (hasTenantId) {
        query = scope === 'APPROVED_EXCEPTION'
          ? query.eq('tenant_id', APPROVED_CROSS_TENANT_EXCEPTION.tenantId)
          : query.eq('tenant_id', TENANT_ID);
      }
      const { data, error } = await query.select('id');
      if (error) fail(`Could not clear ${table}.${column}: ${error.message}`);
      if ((data || []).length !== rowChunk.length) {
        fail(`Clearing ${table}.${column} expected ${rowChunk.length} rows but changed ${(data || []).length}.`);
      }
      changed += data.length;
    }
  }
  return changed;
}

async function deleteRows(
  client,
  definitions,
  table,
  rows,
  { referenceColumn = null } = {},
) {
  if (!rows.length) return 0;
  const hasTenantId = tableHasColumn(definitions, table, 'tenant_id');
  let deleted = 0;
  for (const rowChunk of chunks(rows, MUTATION_BATCH_SIZE)) {
    let query = client
      .from(table)
      .delete()
      .in('id', rowChunk.map((row) => row.id));
    if (referenceColumn) {
      query = query.in(referenceColumn, [...new Set(rowChunk.map((row) => row[referenceColumn]))]);
    }
    if (hasTenantId) query = query.eq('tenant_id', TENANT_ID);
    const { data, error } = await query.select('id');
    if (error) fail(`Could not delete ${table} rows: ${error.message}`);
    if ((data || []).length !== rowChunk.length) {
      fail(`Deleting ${table} expected ${rowChunk.length} rows but deleted ${(data || []).length}.`);
    }
    deleted += data.length;
  }
  return deleted;
}

async function applyCleanup(client, definitions, working) {
  console.log('\nApplying guarded, restartable cleanup stages');

  for (const [table, column] of SET_NULL_REFERENCES) {
    const key = referenceKey(table, column);
    const changed = await setReferencesNull(client, definitions, table, column, working.dependencyRows[key]);
    if (changed) console.log(`  SET NULL ${key}: ${changed}`);
  }

  for (const [table, column] of DELETE_REFERENCES) {
    const key = referenceKey(table, column);
    const deleted = await deleteRows(
      client,
      definitions,
      table,
      working.dependencyRows[key],
      { referenceColumn: column },
    );
    if (deleted) console.log(`  DELETE ${table}: ${deleted}`);
  }

  const organizations = working.organizationIds.map((id) => ({ id }));
  const organizationsDeleted = await deleteRows(client, definitions, 'organization', organizations);
  console.log(`  DELETE organization: ${organizationsDeleted}`);

  const groupPreferenceKey = 'organization_group_preference_value.organization_group_id';
  const groupPreferencesDeleted = await deleteRows(
    client,
    definitions,
    'organization_group_preference_value',
    working.dependencyRows[groupPreferenceKey],
    { referenceColumn: 'organization_group_id' },
  );
  if (groupPreferencesDeleted) {
    console.log(`  DELETE organization_group_preference_value: ${groupPreferencesDeleted}`);
  }

  const groups = working.organizationGroupIds.map((id) => ({ id }));
  const groupsDeleted = await deleteRows(client, definitions, 'organization_group', groups);
  console.log(`  DELETE organization_group: ${groupsDeleted}`);
}

async function findOriginalReferenceResidue(client, definitions, working) {
  const residue = {};
  for (const [table, column] of [...SET_NULL_REFERENCES, ...DELETE_REFERENCES]) {
    const key = referenceKey(table, column);
    const rows = await fetchReferenceRows(
      client,
      definitions,
      table,
      column,
      working.organizationIds,
    );
    residue[key] = summarizeIds(rows.map((row) => row.id));
  }
  const groupRows = await fetchReferenceRows(
    client,
    definitions,
    'organization_group_preference_value',
    'organization_group_id',
    working.organizationGroupIds,
  );
  residue['organization_group_preference_value.organization_group_id'] = summarizeIds(
    groupRows.map((row) => row.id),
  );
  return residue;
}

async function findGlobalDanglingReferences(client, definitions, reviewedSnapshot) {
  const organizationIds = new Set(
    (await fetchAllRows(client, 'organization', 'id')).map((row) => String(row.id)),
  );
  const organizationGroupIds = new Set(
    (await fetchAllRows(client, 'organization_group', 'id')).map((row) => String(row.id)),
  );
  const dangling = {};
  const bnmsOwnedDangling = {};

  for (const [table, column] of [...SET_NULL_REFERENCES, ...DELETE_REFERENCES]) {
    const hasTenantId = tableHasColumn(definitions, table, 'tenant_id');
    const rows = await fetchAllRows(
      client,
      table,
      `id, ${column}${hasTenantId ? ', tenant_id' : ''}`,
      (query) => query.not(column, 'is', null),
    );
    const missing = rows.filter((row) => !organizationIds.has(String(row[column])));
    const key = referenceKey(table, column);
    dangling[key] = summarizeIds(missing.map((row) => row.id));
    const bnmsMissing = hasTenantId
      ? missing.filter((row) => row.tenant_id === TENANT_ID)
      : reviewedSnapshot.dependencies[key]?.count
        ? missing
        : [];
    bnmsOwnedDangling[key] = summarizeIds(bnmsMissing.map((row) => row.id));
  }

  const organizationsWithGroups = await fetchAllRows(
    client,
    'organization',
    'id, tenant_id, organization_group_id',
    (query) => query.not('organization_group_id', 'is', null),
  );
  const missingOrganizationGroups = organizationsWithGroups.filter(
    (row) => !organizationGroupIds.has(String(row.organization_group_id)),
  );
  dangling['organization.organization_group_id'] = summarizeIds(
    missingOrganizationGroups.map((row) => row.id),
  );
  bnmsOwnedDangling['organization.organization_group_id'] = summarizeIds(
    missingOrganizationGroups
      .filter((row) => row.tenant_id === TENANT_ID)
      .map((row) => row.id),
  );

  const groupPreferences = await fetchAllRows(
    client,
    'organization_group_preference_value',
    'id, tenant_id, organization_group_id',
    (query) => query.not('organization_group_id', 'is', null),
  );
  const missingPreferenceGroups = groupPreferences.filter(
    (row) => !organizationGroupIds.has(String(row.organization_group_id)),
  );
  dangling['organization_group_preference_value.organization_group_id'] = summarizeIds(
    missingPreferenceGroups.map((row) => row.id),
  );
  bnmsOwnedDangling['organization_group_preference_value.organization_group_id'] = summarizeIds(
    missingPreferenceGroups
      .filter((row) => row.tenant_id === TENANT_ID)
      .map((row) => row.id),
  );

  const failures = Object.entries(bnmsOwnedDangling).filter(([, value]) => value.count !== 0);
  if (failures.length) {
    fail(
      `BNMS-owned dangling-reference verification failed: ${
        failures.map(([key, value]) => `${key}=${value.count}`).join(', ')
      }.`,
    );
  }
  return {
    allTenants: dangling,
    bnmsOwned: bnmsOwnedDangling,
    outsideBnmsCount: Object.values(dangling).reduce((sum, value) => sum + value.count, 0),
  };
}

async function verifyApprovedCrossTenantException(client) {
  const { data: tenant, error: tenantError } = await client
    .from('tenant')
    .select('id, slug')
    .eq('id', APPROVED_CROSS_TENANT_EXCEPTION.tenantId)
    .maybeSingle();
  if (tenantError) fail(`Could not verify approved exception tenant: ${tenantError.message}`);
  if (!tenant || tenant.slug !== APPROVED_CROSS_TENANT_EXCEPTION.tenantSlug) {
    fail('Approved cross-tenant exception tenant identity changed.');
  }

  const { data: booking, error: bookingError } = await client
    .from('booking')
    .select('id, tenant_id, organization_id')
    .eq('id', APPROVED_CROSS_TENANT_EXCEPTION.id)
    .maybeSingle();
  if (bookingError) fail(`Could not verify approved booking exception: ${bookingError.message}`);
  if (
    !booking
    || booking.tenant_id !== APPROVED_CROSS_TENANT_EXCEPTION.tenantId
    || booking.organization_id !== null
  ) {
    fail('Approved GFI booking was not preserved with only its Organisation link cleared.');
  }
  return {
    bookingPreserved: true,
    tenantIdUnchanged: true,
    organizationLinkCleared: true,
  };
}

function verifyAfter(before, after, originalReferenceResidue) {
  if (after.bnms.organizations.count !== 0) fail(`Expected zero BNMS Organisations; found ${after.bnms.organizations.count}.`);
  if (after.bnms.organizationGroups.count !== 0) fail(`Expected zero BNMS Organisation Groups; found ${after.bnms.organizationGroups.count}.`);
  if (after.bnms.linkedMembers.count !== 0) fail(`Expected zero linked BNMS Members; found ${after.bnms.linkedMembers.count}.`);

  assertSame('BNMS Member IDs', before.bnms.members, after.bnms.members);
  assertSame('BNMS Member Group IDs', before.bnms.memberGroups, after.bnms.memberGroups);
  assertSame(
    'BNMS Member Group assignment IDs',
    before.bnms.memberGroupAssignments,
    after.bnms.memberGroupAssignments,
  );
  assertSame('Cross-tenant entity controls', before.crossTenantControls, after.crossTenantControls);

  for (const [key, dependency] of Object.entries(originalReferenceResidue)) {
    if (dependency.count !== 0) {
      fail(`Reference ${key} still contains ${dependency.count} link(s) to the original Organisation or Organisation Group IDs.`);
    }
  }
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage:
  node scripts/migrations/delete-bnms-organisation-data.mjs
  node scripts/migrations/delete-bnms-organisation-data.mjs --apply --i-have-reviewed-the-dry-run
  node scripts/migrations/delete-bnms-organisation-data.mjs --verify

Dry-run is the default. Apply mode requires a reviewed dry-run manifest whose
digest still matches the live destination data. Verify mode recovers and writes
the after manifest if the apply process times out after its mutation stages.`);
    return;
  }
  if (args.apply && !args.reviewed) {
    fail('--apply requires --i-have-reviewed-the-dry-run.');
  }

  const { client, url, headers } = getSupabase();
  const definitions = await loadSchema(url, headers);
  const schemaAudit = auditReferenceSchema(definitions);

  if (args.verify) {
    if (!fs.existsSync(BEFORE_MANIFEST)) {
      fail(`Reviewed manifest is missing: ${BEFORE_MANIFEST}.`);
    }
    const reviewed = JSON.parse(fs.readFileSync(BEFORE_MANIFEST, 'utf8'));
    const after = await buildSnapshot(
      client,
      definitions,
      schemaAudit,
      { requireApprovedException: false },
    );
    verifyAfter(reviewed.snapshot, after.snapshot, {});
    const globalDanglingReferences = await findGlobalDanglingReferences(
      client,
      definitions,
      reviewed.snapshot,
    );
    const approvedCrossTenantExceptionVerification = await verifyApprovedCrossTenantException(client);
    const afterDigest = stableDigest(after.snapshot);
    writeJson(AFTER_MANIFEST, {
      generatedAt: new Date().toISOString(),
      recoveredAfterApplyTimeout: true,
      beforeReviewDigest: reviewed.reviewDigest,
      afterDigest,
      snapshot: after.snapshot,
      globalDanglingReferences,
      approvedCrossTenantExceptionVerification,
    });
    console.log('Post-cleanup verification passed');
    console.log(`  Organisations:            ${after.snapshot.bnms.organizations.count}`);
    console.log(`  Organisation Groups:      ${after.snapshot.bnms.organizationGroups.count}`);
    console.log(`  Members preserved:        ${after.snapshot.bnms.members.count}`);
    console.log(`  Member Groups preserved:  ${after.snapshot.bnms.memberGroups.count}`);
    console.log(`  Group assignments kept:   ${after.snapshot.bnms.memberGroupAssignments.count}`);
    console.log(`  BNMS-owned dangling refs: 0`);
    console.log(`  Existing outside BNMS:    ${globalDanglingReferences.outsideBnmsCount}`);
    console.log(`  After manifest: ${AFTER_MANIFEST}`);
    return;
  }

  const before = await buildSnapshot(client, definitions, schemaAudit);
  const reviewDigest = stableDigest(before.snapshot);
  printSnapshot(before.snapshot, reviewDigest, args.apply ? 'APPLY' : 'DRY-RUN');

  if (!args.apply) {
    writeJson(BEFORE_MANIFEST, {
      generatedAt: new Date().toISOString(),
      reviewDigest,
      snapshot: before.snapshot,
    });
    console.log(`\nNo changes made. Review manifest written to ${BEFORE_MANIFEST}.`);
    return;
  }

  if (!fs.existsSync(BEFORE_MANIFEST)) {
    fail(`Reviewed manifest is missing: ${BEFORE_MANIFEST}. Run the dry-run first.`);
  }
  const reviewed = JSON.parse(fs.readFileSync(BEFORE_MANIFEST, 'utf8'));
  if (reviewed.reviewDigest !== reviewDigest) {
    fail('Live destination data changed since the reviewed dry-run. Run and review a fresh dry-run before applying.');
  }

  await applyCleanup(client, definitions, before.working);

  const after = await buildSnapshot(
    client,
    definitions,
    schemaAudit,
    { requireApprovedException: false },
  );
  const originalReferenceResidue = await findOriginalReferenceResidue(
    client,
    definitions,
    before.working,
  );
  verifyAfter(before.snapshot, after.snapshot, originalReferenceResidue);
  const approvedCrossTenantExceptionVerification = await verifyApprovedCrossTenantException(client);
  const afterDigest = stableDigest(after.snapshot);
  writeJson(AFTER_MANIFEST, {
    generatedAt: new Date().toISOString(),
    beforeReviewDigest: reviewDigest,
    afterDigest,
    snapshot: after.snapshot,
    originalReferenceResidue,
    approvedCrossTenantExceptionVerification,
  });

  console.log('\nCleanup verified successfully');
  console.log(`  Organisations:            ${before.snapshot.bnms.organizations.count} -> 0`);
  console.log(`  Organisation Groups:      ${before.snapshot.bnms.organizationGroups.count} -> 0`);
  console.log(`  Members preserved:        ${after.snapshot.bnms.members.count}`);
  console.log(`  Member Groups preserved:  ${after.snapshot.bnms.memberGroups.count}`);
  console.log(`  Group assignments kept:   ${after.snapshot.bnms.memberGroupAssignments.count}`);
  console.log(`  After manifest: ${AFTER_MANIFEST}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
});