import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import XLSX from 'xlsx';

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const DEPARTMENT_OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const DEFAULT_INPUT = 'attached_assets/Department_contacts_to_import_04.09.26_v2_1788793862211.xlsx';
const PAGE_SIZE = 1000;

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function excelDate(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString();
  }
  const parsed = new Date(String(value ?? '').trim());
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid registration date: ${value}`);
  return parsed.toISOString();
}

function chunks(values, size = 100) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

async function allRows(supabase, table, columns, applyFilters = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function exactlyOne(rows, label) {
  if (rows.length !== 1) throw new Error(`${label}: expected exactly one row, found ${rows.length}`);
  return rows[0];
}

function relationshipFields(definition) {
  const configuration = definition.configuration || {};
  return configuration.relationship_fields || configuration.relationshipFields || [];
}

function readWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const sourceRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const rows = sourceRows.map((row, index) => ({
    rowNumber: index + 2,
    websiteId: String(row['YM Website ID'] ?? '').trim(),
    departmentId: String(row.Department_UUID ?? '').trim(),
    firstName: String(row.First_Name ?? '').trim(),
    lastName: String(row.Last_Name ?? '').trim(),
    email: normalize(row.Email),
    registrationDate: excelDate(row.Registration_Date),
    organizationName: String(row.organisation ?? '').trim(),
    organizationKey: normalize(row.organisation),
  }));
  const errors = [];
  for (const row of rows) {
    for (const key of ['websiteId', 'departmentId', 'firstName', 'lastName', 'email', 'organizationName']) {
      if (!row[key]) errors.push(`Row ${row.rowNumber}: ${key} is blank`);
    }
  }
  const duplicateEmails = [...new Set(rows.map((row) => row.email)
    .filter((email, index, values) => values.indexOf(email) !== index))];
  if (duplicateEmails.length) errors.push(`Duplicate emails: ${duplicateEmails.join(', ')}`);
  if (rows.length !== 153) errors.push(`Expected 153 rows, found ${rows.length}`);
  if (errors.length) throw new Error(`Workbook validation failed:\n${errors.join('\n')}`);
  return rows;
}

async function buildPlan(supabase, workbookRows) {
  const [{ data: tenants, error: tenantError }, { data: objects, error: objectError }] = await Promise.all([
    supabase.from('tenant').select('id, slug, name').eq('id', TENANT_ID),
    supabase.from('custom_object_definition').select('*')
      .eq('id', DEPARTMENT_OBJECT_ID).eq('tenant_id', TENANT_ID).eq('status', 'active'),
  ]);
  if (tenantError) throw new Error(`Tenant read failed: ${tenantError.message}`);
  if (objectError) throw new Error(`Department object read failed: ${objectError.message}`);
  const tenant = exactlyOne(tenants || [], 'BNMS tenant');
  if (tenant.slug !== 'bnms') throw new Error(`Expected tenant slug bnms, found ${tenant.slug}`);
  exactlyOne(objects || [], 'BNMS Department object');

  const definitions = await allRows(
    supabase,
    'custom_object_relationship_definition',
    '*',
    (query) => query.eq('tenant_id', TENANT_ID).eq('status', 'active'),
  );
  const memberDefinition = exactlyOne(definitions.filter((definition) =>
    definition.relationship_key === 'members'
    && definition.source_kind === 'custom_object'
    && definition.source_custom_object_id === DEPARTMENT_OBJECT_ID
    && definition.target_kind === 'member'
    && !definition.target_custom_object_id
    && definition.cardinality === 'many_to_many'
  ), 'active Department-member relationship');
  const ownerDefinition = exactlyOne(definitions.filter((definition) =>
    definition.relationship_key === 'organisation'
    && definition.source_kind === 'custom_object'
    && definition.source_custom_object_id === DEPARTMENT_OBJECT_ID
    && definition.target_kind === 'organization'
    && !definition.target_custom_object_id
  ), 'active Department-organization relationship');
  const responderFields = relationshipFields(memberDefinition).filter((field) =>
    (field.type || field.field_type) === 'boolean'
    && /survey.*respond/i.test(`${field.key || field.name || ''} ${field.label || ''}`)
  );
  const responderField = exactlyOne(responderFields, 'Survey Responder relationship field');
  const responderKey = responderField.key || responderField.name;
  if (!responderKey) throw new Error('Survey Responder relationship field has no key');

  const departmentIds = [...new Set(workbookRows.map((row) => row.departmentId))];
  const departments = [];
  for (const ids of chunks(departmentIds)) {
    const { data, error } = await supabase.from('custom_object_record')
      .select('id, custom_object_id, archived_at')
      .eq('tenant_id', TENANT_ID).eq('custom_object_id', DEPARTMENT_OBJECT_ID)
      .in('id', ids);
    if (error) throw new Error(`Department read failed: ${error.message}`);
    departments.push(...(data || []));
  }
  const activeDepartmentIds = new Set(departments.filter((row) => !row.archived_at).map((row) => row.id));
  const missingDepartments = departmentIds.filter((id) => !activeDepartmentIds.has(id));
  if (missingDepartments.length) throw new Error(`Missing or archived Departments: ${missingDepartments.join(', ')}`);

  const ownerEdges = [];
  for (const ids of chunks(departmentIds)) {
    const { data, error } = await supabase.from('custom_object_relationship')
      .select('id, source_record_id, target_record_id, archived_at')
      .eq('tenant_id', TENANT_ID).eq('relationship_definition_id', ownerDefinition.id)
      .is('archived_at', null).in('source_record_id', ids);
    if (error) throw new Error(`Department owner read failed: ${error.message}`);
    ownerEdges.push(...(data || []));
  }
  const ownerByDepartment = new Map();
  for (const departmentId of departmentIds) {
    const matching = ownerEdges.filter((edge) => edge.source_record_id === departmentId);
    ownerByDepartment.set(departmentId, exactlyOne(matching, `Department ${departmentId} active owner`));
  }

  const [organizations, members] = await Promise.all([
    allRows(supabase, 'organization', 'id, name, status', (query) => query.eq('tenant_id', TENANT_ID)),
    allRows(
      supabase,
      'member',
      'id, email, first_name, last_name, organization_id, created_on, status',
      (query) => query.eq('tenant_id', TENANT_ID),
    ),
  ]);
  const organizationsByName = new Map();
  const organizationsById = new Map();
  for (const organization of organizations) {
    organizationsById.set(organization.id, organization);
    const key = normalize(organization.name);
    if (!organizationsByName.has(key)) organizationsByName.set(key, []);
    organizationsByName.get(key).push(organization);
  }
  const danglingDepartmentOwners = departmentIds
    .map((departmentId) => ({
      departmentId,
      ownerOrganizationId: ownerByDepartment.get(departmentId)?.target_record_id,
    }))
    .filter(({ ownerOrganizationId }) => !organizationsById.has(ownerOrganizationId));
  if (danglingDepartmentOwners.length) {
    throw new Error(
      `Departments have active owner links to missing organizations:\n${
        danglingDepartmentOwners.map(({ departmentId, ownerOrganizationId }) =>
          `${departmentId} -> ${ownerOrganizationId}`
        ).join('\n')
      }`
    );
  }
  const membersByEmail = new Map();
  for (const member of members) {
    const key = normalize(member.email);
    if (!key) continue;
    if (!membersByEmail.has(key)) membersByEmail.set(key, []);
    membersByEmail.get(key).push(member);
  }

  const existingMemberIds = workbookRows.flatMap((row) => membersByEmail.get(row.email) || [])
    .map((member) => member.id);
  const relationshipEdges = [];
  for (const ids of chunks(existingMemberIds)) {
    if (!ids.length) continue;
    const { data, error } = await supabase.from('custom_object_relationship')
      .select('id, source_record_id, target_record_id, field_values, archived_at, created_at')
      .eq('tenant_id', TENANT_ID).eq('relationship_definition_id', memberDefinition.id)
      .in('target_record_id', ids);
    if (error) throw new Error(`Existing Department-member edge read failed: ${error.message}`);
    relationshipEdges.push(...(data || []));
  }

  const planRows = workbookRows.map((row) => {
    const ownerEdge = ownerByDepartment.get(row.departmentId);
    const organization = organizationsById.get(ownerEdge.target_record_id);
    if (organization.status && organization.status !== 'active') {
      throw new Error(`Row ${row.rowNumber} Department owner "${organization.name}" is not active`);
    }
    const memberMatches = membersByEmail.get(row.email) || [];
    if (memberMatches.length > 1) throw new Error(`Row ${row.rowNumber} email ${row.email} is ambiguous`);
    const existingMember = memberMatches[0] || null;
    const memberId = existingMember?.id || randomUUID();
    const matchingEdges = relationshipEdges.filter((edge) =>
      edge.source_record_id === row.departmentId && edge.target_record_id === memberId
    ).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const activeEdges = matchingEdges.filter((edge) => !edge.archived_at);
    if (activeEdges.length > 1) {
      throw new Error(`Row ${row.rowNumber} has duplicate active Department-member relationships`);
    }
    const activeEdge = activeEdges[0] || null;
    const archivedEdge = activeEdge ? null : matchingEdges.find((edge) => edge.archived_at) || null;
    const effectiveOrganizationId = existingMember?.organization_id || organization.id;
    if (!activeEdge && effectiveOrganizationId !== organization.id) {
      throw new Error(
        `Row ${row.rowNumber} existing member organization does not match Department owner; no active edge can be safely reused`
      );
    }
    return {
      ...row,
      organizationId: organization.id,
      organizationLabelMatches: row.organizationKey === normalize(organization.name),
      authoritativeOrganizationName: organization.name,
      memberId,
      existingMember,
      activeEdge,
      archivedEdge,
    };
  });

  return { tenant, memberDefinition, ownerDefinition, responderField, responderKey, planRows };
}

function summary(plan) {
  const rows = plan.planRows;
  return {
    tenant: { id: plan.tenant.id, slug: plan.tenant.slug },
    workbookRows: rows.length,
    uniqueDepartments: new Set(rows.map((row) => row.departmentId)).size,
    uniqueOrganizations: new Set(rows.map((row) => row.organizationId)).size,
    organizationLabelMismatches: rows.filter((row) => !row.organizationLabelMatches).length,
    existingMembers: rows.filter((row) => row.existingMember).length,
    membersToCreate: rows.filter((row) => !row.existingMember).length,
    existingMembersToFillOrganization: rows.filter((row) =>
      row.existingMember && !row.existingMember.organization_id
    ).length,
    activeEdgesToUpdate: rows.filter((row) => row.activeEdge).length,
    archivedEdgesToRestore: rows.filter((row) => !row.activeEdge && row.archivedEdge).length,
    edgesToCreate: rows.filter((row) => !row.activeEdge && !row.archivedEdge).length,
    responderField: {
      id: plan.responderField.id || plan.responderField.field_id,
      key: plan.responderKey,
    },
  };
}

async function applyPlan(supabase, plan) {
  const createdMembers = plan.planRows.filter((row) => !row.existingMember).map((row) => ({
    id: row.memberId,
    tenant_id: TENANT_ID,
    email: row.email,
    first_name: row.firstName,
    last_name: row.lastName,
    organization_id: row.organizationId,
    created_on: row.registrationDate,
  }));
  if (createdMembers.length) {
    const { error } = await supabase.from('member').insert(createdMembers);
    if (error) throw new Error(`Member insert failed: ${error.message}`);
  }

  for (const row of plan.planRows.filter((item) => item.existingMember)) {
    const update = {};
    if (!row.existingMember.first_name) update.first_name = row.firstName;
    if (!row.existingMember.last_name) update.last_name = row.lastName;
    if (!row.existingMember.organization_id) update.organization_id = row.organizationId;
    if (!row.existingMember.created_on) update.created_on = row.registrationDate;
    if (!Object.keys(update).length) continue;
    const { error } = await supabase.from('member').update(update)
      .eq('tenant_id', TENANT_ID).eq('id', row.memberId);
    if (error) throw new Error(`Member ${row.memberId} safe-fill failed: ${error.message}`);
  }

  for (const row of plan.planRows) {
    const existingEdge = row.activeEdge || row.archivedEdge;
    const fieldValues = {
      ...(existingEdge?.field_values && typeof existingEdge.field_values === 'object'
        ? existingEdge.field_values
        : {}),
      [plan.responderKey]: true,
    };
    if (row.activeEdge) {
      const { error } = await supabase.from('custom_object_relationship')
        .update({ field_values: fieldValues })
        .eq('tenant_id', TENANT_ID).eq('id', row.activeEdge.id);
      if (error) throw new Error(`Row ${row.rowNumber} edge update failed: ${error.message}`);
    } else if (row.archivedEdge) {
      const { error } = await supabase.from('custom_object_relationship')
        .update({ field_values: fieldValues, archived_at: null, archived_by: null })
        .eq('tenant_id', TENANT_ID).eq('id', row.archivedEdge.id)
        .not('archived_at', 'is', null);
      if (error) throw new Error(`Row ${row.rowNumber} edge restore failed: ${error.message}`);
    } else {
      const { error } = await supabase.from('custom_object_relationship').insert({
        id: randomUUID(),
        tenant_id: TENANT_ID,
        relationship_definition_id: plan.memberDefinition.id,
        source_record_id: row.departmentId,
        target_record_id: row.memberId,
        field_values: fieldValues,
      });
      if (error) throw new Error(`Row ${row.rowNumber} edge insert failed: ${error.message}`);
    }
  }
}

function auditRows(plan) {
  return plan.planRows.map((row) => ({
    rowNumber: row.rowNumber,
    websiteId: row.websiteId,
    departmentId: row.departmentId,
    email: row.email,
    organizationName: row.organizationName,
    memberAction: row.existingMember ? 'reused' : 'created',
    memberId: row.memberId,
    edgeAction: row.activeEdge ? 'updated' : row.archivedEdge ? 'restored' : 'created',
  }));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const inputArg = process.argv.find((value) => value.startsWith('--input='));
  const auditArg = process.argv.find((value) => value.startsWith('--audit='));
  const input = path.resolve(inputArg ? inputArg.slice('--input='.length) : DEFAULT_INPUT);
  const auditPath = path.resolve(auditArg ? auditArg.slice('--audit='.length) : '/tmp/bnms-department-responder-import.json');
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw new Error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const workbookRows = readWorkbook(input);
  const before = await buildPlan(supabase, workbookRows);
  console.log(JSON.stringify({ phase: 'preflight', apply, ...summary(before) }, null, 2));
  if (apply) {
    await applyPlan(supabase, before);
    const after = await buildPlan(supabase, workbookRows);
    const afterSummary = summary(after);
    if (afterSummary.membersToCreate || afterSummary.archivedEdgesToRestore || afterSummary.edgesToCreate) {
      throw new Error(`Verification failed: ${JSON.stringify(afterSummary)}`);
    }
    const responderFailures = after.planRows.filter((row) =>
      row.activeEdge?.field_values?.[after.responderKey] !== true
    );
    if (responderFailures.length) {
      throw new Error(`Verification failed: ${responderFailures.length} relationships are not Survey Responders`);
    }
    const audit = {
      completedAt: new Date().toISOString(),
      input: path.basename(input),
      before: summary(before),
      after: afterSummary,
      verification: {
        expectedRows: workbookRows.length,
        activeSurveyResponderRelationships: workbookRows.length,
        noMembersToCreateOnReplay: afterSummary.membersToCreate === 0,
        noEdgesToCreateOrRestoreOnReplay:
          afterSummary.edgesToCreate === 0 && afterSummary.archivedEdgesToRestore === 0,
      },
      rows: auditRows(before),
    };
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(JSON.stringify({ phase: 'verified', auditPath, ...audit.verification }, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});