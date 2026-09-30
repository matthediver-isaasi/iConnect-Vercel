/**
 * Task #4349 incident recovery.
 *
 * This is deliberately pinned to one tenant, form, submission, Member and
 * organisation. It only replays the shared primary-pipeline Related Records
 * step; it never invokes the form handler or any primary, email, billing, or
 * structured-action processing.
 *
 * Default (real reads/validation, simulated relationship inserts):
 *   node scripts/recover-trainee-department-links.mjs
 *
 * Authorized offline admin operator only, after independently repairing the
 * organisation type from historical evidence:
 *   node scripts/recover-trainee-department-links.mjs --apply --operator-authorized
 *
 * Historical repair evidence (not proof of the value immediately before loss):
 * attached_assets/Organisation_data_updated_to_import_31.08.26_1788194727640.csv,
 * row 39, exact organisation UUID: Type = "Public hospital or clinical site".
 * SHA256: 022d30b52848ddbc6b8af9aeca98725adb080466e9d19825a4b26b23f3170eeb.
 * The older August 23 hospital spreadsheet uses different wording; do not use
 * that older category or change any other organisation fields. An authorized
 * administrator must restore the evidenced type, then review a fresh dry-run
 * before applying. Do not use the submissions screen's full processing replay
 * for this incident: this script intentionally runs the relationship step only.
 *
 * Initial production inspection on September 10, 2026: type absent, zero
 * Member relationship edges, original relationship-validation failure retained.
 * No production repair was executed by the agent.
 */

import { pathToFileURL } from 'node:url';
import { processPrimaryPipelineRelatedRecords } from '../api/_lib/formStructuredActions.js';
import { normalizeOrganizationPreferenceValues } from '../api/_lib/organizationEligibility.js';

export const INCIDENT = Object.freeze({
  tenantId: 'ff2df806-b321-4254-b651-3af11fccf1db',
  formId: '0bfa31b0-618f-4498-94bf-a9dbffd76165',
  submissionId: '7a070785-1b35-4299-8a4c-0f858c158729',
  memberId: 'e6da3468-63a0-4512-8d93-62d8e8ace37f',
  organizationId: '22813a71-ef75-497b-95a6-7616b2ba8bd2',
  organizationTypePreferenceId: 'fd8dab3a-29ab-41f0-a002-d9cf822c51bf',
  departmentFieldId: 'field_1788075892819',
  departmentObjectId: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
  organizationFieldId: 'field_1788075690796',
  organizationType: 'Public hospital or clinical site',
  departmentIds: Object.freeze([
    'c3ab9ee8-5392-4140-800d-e674fb2de6a7',
    'f294f444-e5f4-4f00-af12-597530d82096',
    'a3a8ded3-2493-4b6c-9550-f454398bc8cd',
  ]),
  memberDepartmentDefinitionId: '0fdede92-efa2-4d84-9b16-df1a88069486',
  organizationDepartmentDefinitionId: '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e',
});

const SUCCESS_NOTE_KIND = 'task4349_department_link_recovery_succeeded';
const EXPECTED_ORG_FILTER = Object.freeze({
  mode: 'include',
  type: 'custom',
  field: 'organisation_type',
  values: Object.freeze([
    'Hospital',
    'NHS/HSC hospital or clinical site',
    'Private hospital or imaging centre',
    'Public hospital or clinical site',
    'Commercial or industry organisation',
    'Research or charitable organisation',
  ]),
});
const EDGE_COLUMNS = Object.freeze([
  'relationship_definition_id', 'source_record_id', 'target_record_id', 'tenant_id',
]);
const MUTATION_METHODS = new Set(['update', 'upsert', 'delete']);
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value ?? null;
};
const canonical = value => JSON.stringify(stableValue(value));
const sameSet = (left, right) => left.length === right.length
  && [...left].sort().every((value, index) => value === [...right].sort()[index]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function one(db, table, filters, select = '*') {
  let query = db.from(table).select(select);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Unable to read ${table}: ${error.message || error}`);
  return data;
}

async function many(db, table, filters, select = '*') {
  let query = db.from(table).select(select);
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { data, error } = await query;
  if (error) throw new Error(`Unable to read ${table}: ${error.message || error}`);
  return data || [];
}

function edgeKey(payload) {
  return [
    payload.tenant_id,
    payload.relationship_definition_id,
    payload.source_record_id,
    payload.target_record_id,
  ].join(':');
}

/**
 * The dry-run database facade executes every real validator read but turns the
 * helper's exact canonical edge inserts into an in-memory plan. In apply mode
 * it permits only those precomputed missing edges. Every other mutation is a
 * hard failure.
 */
export function createWriteGuard(db, { apply, allowedEdges }) {
  const allowed = new Set(allowedEdges.map(edgeKey));
  const attempted = [];
  const unexpected = [];
  return {
    attempted,
    unexpected,
    db: {
      from(table) {
        const query = db.from(table);
        let proxy;
        proxy = new Proxy(query, {
          get(target, property) {
            if (property === 'insert') {
              return (payload) => {
                const rows = Array.isArray(payload) ? payload : [payload];
                for (const row of rows) {
                  const columns = Object.keys(row || {}).sort();
                  if (canonical(columns) !== canonical(EDGE_COLUMNS)) {
                    unexpected.push({ table, operation: 'insert', payload: row });
                    throw new Error('Blocked relationship insert with non-canonical columns');
                  }
                  const key = edgeKey(row);
                  if (table !== 'custom_object_relationship' || !allowed.has(key)) {
                    unexpected.push({ table, operation: 'insert', payload: row });
                    throw new Error(`Blocked unexpected insert into ${table}`);
                  }
                  if (attempted.some(candidate => edgeKey(candidate) === key)) {
                    throw new Error(`Blocked duplicate planned relationship insert ${key}`);
                  }
                  attempted.push(row);
                }
                return apply ? target.insert(payload) : Promise.resolve({ data: null, error: null });
              };
            }
            if (MUTATION_METHODS.has(property)) {
              return () => {
                unexpected.push({ table, operation: property });
                throw new Error(`Blocked unexpected ${String(property)} on ${table}`);
              };
            }
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function') return value;
            return (...args) => {
              const result = value.apply(target, args);
              return result === target ? proxy : result;
            };
          },
        });
        return proxy;
      },
    },
  };
}

function primaryMemberPipeline(form) {
  const pipelines = form?.entity_pipelines?.members;
  if (!Array.isArray(pipelines)) return null;
  return pipelines.find(pipeline => pipeline?.isPrimary || pipeline?.is_primary) || pipelines[0] || null;
}

async function validatePinnedState(db) {
  const i = INCIDENT;
  const [form, submission, member, organization, typeField, typeValue, memberDefinition, orgDefinition] = await Promise.all([
    one(db, 'form', { id: i.formId, tenant_id: i.tenantId }),
    one(db, 'form_submission', { id: i.submissionId, tenant_id: i.tenantId }),
    one(db, 'member', { id: i.memberId, tenant_id: i.tenantId }),
    one(db, 'organization', { id: i.organizationId, tenant_id: i.tenantId }),
    one(db, 'preference_field', { id: i.organizationTypePreferenceId, tenant_id: i.tenantId }),
    one(db, 'organization_preference_value', {
      organization_id: i.organizationId,
      field_id: i.organizationTypePreferenceId,
    }),
    one(db, 'custom_object_relationship_definition', {
      id: i.memberDepartmentDefinitionId, tenant_id: i.tenantId,
    }),
    one(db, 'custom_object_relationship_definition', {
      id: i.organizationDepartmentDefinitionId, tenant_id: i.tenantId,
    }),
  ]);

  requireValue(form, 'Pinned form is missing or foreign');
  requireValue(submission, 'Pinned submission is missing or foreign');
  requireValue(member, 'Pinned Member is missing or foreign');
  requireValue(organization, 'Pinned organisation is missing or foreign');
  requireValue(submission.form_id === i.formId, 'Submission/form pin mismatch');
  requireValue(submission.created_member_id === i.memberId,
    'Submission no longer identifies the pinned persisted Member');
  requireValue(
    [submission.organization_id, submission.created_organization_id].filter(Boolean)
      .every(id => id === i.organizationId)
      && [submission.organization_id, submission.created_organization_id].some(id => id === i.organizationId),
    'Submission no longer identifies only the pinned organisation',
  );

  requireValue(typeField?.is_active === true && typeField?.entity_scope === 'organization',
    'Pinned organisation-type field is missing or inactive');
  const normalizedTypes = normalizeOrganizationPreferenceValues(typeValue?.value);
  requireValue(normalizedTypes?.length === 1 && normalizedTypes[0] === i.organizationType,
  `BLOCKED: organisation type must be exactly the evidenced value "${i.organizationType}". An authorized operator must restore it through the admin UI (evidence CSV SHA256 022d30b52848ddbc6b8af9aeca98725adb080466e9d19825a4b26b23f3170eeb). This script will not write preferences.`);

  const memberEndpointOk = memberDefinition?.status === 'active'
    && memberDefinition.source_kind === 'custom_object'
    && memberDefinition.source_custom_object_id
    && memberDefinition.source_custom_object_id === i.departmentObjectId
    && memberDefinition.target_kind === 'member'
    && memberDefinition.target_custom_object_id == null
    && memberDefinition.cardinality === 'many_to_many';
  requireValue(memberEndpointOk, 'Member/Department definition drifted from active Department-source, Member-target many-to-many');
  const orgEndpointOk = orgDefinition?.status === 'active'
    && orgDefinition.source_kind === 'custom_object'
    && orgDefinition.source_custom_object_id === memberDefinition.source_custom_object_id
    && orgDefinition.target_kind === 'organization'
    && orgDefinition.target_custom_object_id == null
    && orgDefinition.cardinality === 'many_to_one';
  requireValue(orgEndpointOk, 'Organisation/Department parent definition or cardinality drifted');

  const field = (form.fields || []).find(candidate => candidate?.id === i.departmentFieldId);
  requireValue(field?.type === 'relationship_dropdown'
    && field.related_kind === 'custom_object'
    && field.related_custom_object_id === memberDefinition.source_custom_object_id
    && field.relationship_definition_id === i.organizationDepartmentDefinitionId,
  'Pinned Department field configuration drifted');
  const parentField = (form.fields || []).find(candidate => candidate?.id === field.parent_field_id);
  requireValue(parentField?.id === i.organizationFieldId
    && parentField.type === 'organisation_dropdown'
    && canonical(parentField.org_filter) === canonical(EXPECTED_ORG_FILTER),
  'Department parent dropdown or its pinned organisation eligibility filter drifted');
  requireValue(submission.submission_data?.[field.parent_field_id] === i.organizationId,
    'Persisted organisation selection is not the pinned organisation');
  const selected = submission.submission_data?.[i.departmentFieldId];
  requireValue(Array.isArray(selected) && sameSet(selected, i.departmentIds),
    'Persisted Department selection is not exactly the three incident Departments');

  const relatedMappings = [
    ...(form.entity_pipelines?.members || []).flatMap(pipeline => pipeline?.related_records || []),
    ...(form.entity_pipelines?.organisations || []).flatMap(pipeline => pipeline?.related_records || []),
  ];
  requireValue(relatedMappings.length === 1
    && relatedMappings[0].source_field_id === i.departmentFieldId
    && relatedMappings[0].relationship_definition_id === i.memberDepartmentDefinitionId
    && (primaryMemberPipeline(form)?.related_records || []).includes(relatedMappings[0]),
  'Related Records configuration drifted: expected only the pinned Member/Department mapping');

  for (const departmentId of i.departmentIds) {
    const department = await one(db, 'custom_object_record', {
      id: departmentId,
      tenant_id: i.tenantId,
      custom_object_id: memberDefinition.source_custom_object_id,
    });
    requireValue(department && department.archived_at == null, `Department ${departmentId} is missing, foreign, or archived`);
    const parent = await one(db, 'custom_object_relationship', {
      tenant_id: i.tenantId,
      relationship_definition_id: i.organizationDepartmentDefinitionId,
      source_record_id: departmentId,
      target_record_id: i.organizationId,
    });
    requireValue(parent && parent.archived_at == null,
      `Department ${departmentId} lacks its active pinned organisation parent`);
  }

  const activeMemberEdges = (await many(db, 'custom_object_relationship', {
    tenant_id: i.tenantId,
    relationship_definition_id: i.memberDepartmentDefinitionId,
    target_record_id: i.memberId,
  })).filter(edge => edge.archived_at == null);
  requireValue(activeMemberEdges.every(edge => i.departmentIds.includes(edge.source_record_id)),
    'Unexpected active Department link exists on the pinned Member');
  return { form, submission, activeMemberEdges };
}

async function readExactActiveEdges(db) {
  const rows = await many(db, 'custom_object_relationship', {
    tenant_id: INCIDENT.tenantId,
    relationship_definition_id: INCIDENT.memberDepartmentDefinitionId,
    target_record_id: INCIDENT.memberId,
  });
  return rows.filter(row => row.archived_at == null);
}

async function appendSuccessNoteCas(db, submission, linkedCount, now) {
  const priorRaw = submission.processing_notes ?? null;
  const prior = Array.isArray(submission.processing_notes)
    ? submission.processing_notes
    : submission.processing_notes
      ? [{ kind: 'legacy_processing_note', message: String(submission.processing_notes) }]
      : [];
  if (prior.some(note => note?.kind === SUCCESS_NOTE_KIND)) return { alreadyRecorded: true };
  const note = {
    at: now(),
    kind: SUCCESS_NOTE_KIND,
    message: 'Task #4349 recovery verified exactly three active Member-to-Department links.',
    tenant_id: INCIDENT.tenantId,
    form_id: INCIDENT.formId,
    submission_id: INCIDENT.submissionId,
    member_id: INCIDENT.memberId,
    organization_id: INCIDENT.organizationId,
    department_ids: [...INCIDENT.departmentIds],
    links_created: linkedCount,
    cas: { prior_processing_notes_count: prior.length, comparison: 'processing_notes JSON equality' },
  };
  const next = [...prior, note];
  let update = db.from('form_submission')
    .update({ processing_notes: next })
    .eq('id', INCIDENT.submissionId)
    .eq('tenant_id', INCIDENT.tenantId);
  // supabase-js/PostgREST interpolates `.eq()` values. Passing an array/object
  // directly becomes "[object Object]" rather than a jsonb literal, so CAS
  // against the exact persisted JSON serialization (and use IS NULL for null).
  update = priorRaw === null
    ? update.is('processing_notes', null)
    : update.eq('processing_notes', JSON.stringify(priorRaw));
  const { data, error } = await update
    .select('id, processing_notes')
    .maybeSingle();
  if (error) throw new Error(`Links are present but recovery note update failed: ${error.message || error}`);
  if (!data) throw new Error('Links are present but recovery note CAS lost a concurrent update; re-read and retry');
  requireValue(Array.isArray(data.processing_notes)
    && data.processing_notes.some(candidate => candidate?.kind === SUCCESS_NOTE_KIND),
  'Links are present but the durable recovery note could not be verified');
  return { alreadyRecorded: false };
}

export async function recoverTraineeDepartmentLinks({
  db,
  apply = false,
  operatorAuthorized = false,
  now = () => new Date().toISOString(),
  processor = processPrimaryPipelineRelatedRecords,
} = {}) {
  requireValue(db, 'Database client is required');
  requireValue(!apply || operatorAuthorized,
    '--apply requires --operator-authorized and an offline admin service-role context');
  requireValue(!apply || db.transactionCapable === true,
    '--apply requires the transaction-capable PostgreSQL adapter');
  const state = await validatePinnedState(db);
  const existingIds = state.activeMemberEdges.map(edge => edge.source_record_id);
  const missingIds = INCIDENT.departmentIds.filter(id => !existingIds.includes(id));
  const planned = missingIds.map(departmentId => ({
    tenant_id: INCIDENT.tenantId,
    relationship_definition_id: INCIDENT.memberDepartmentDefinitionId,
    source_record_id: departmentId,
    target_record_id: INCIDENT.memberId,
  }));
  const guard = createWriteGuard(db, { apply, allowedEdges: planned });
  const result = await processor({
    db: guard.db,
    tenantId: INCIDENT.tenantId,
    form: state.form,
    submission: state.submission,
    memberId: INCIDENT.memberId,
    organizationId: INCIDENT.organizationId,
  });
  requireValue(result?.success === true && result.failed_count === 0 && guard.unexpected.length === 0,
    `Related Records validation/replay failed: ${canonical(result)}`);
  requireValue(guard.attempted.length === planned.length
    && sameSet(guard.attempted.map(edgeKey), planned.map(edgeKey)),
  'Shared helper did not plan only the exact expected missing edges');

  if (!apply) {
    requireValue(sameSet([...existingIds, ...guard.attempted.map(edge => edge.source_record_id)], INCIDENT.departmentIds),
      'Dry-run projection did not produce exactly the three expected active links');
    return { mode: 'dry-run', existing: existingIds.length, wouldCreate: planned.length, result };
  }

  const verified = await readExactActiveEdges(db);
  requireValue(verified.length === 3
    && sameSet(verified.map(edge => edge.source_record_id), INCIDENT.departmentIds),
  'Apply was partial or produced unexpected links; success note was not written');
  const actuallyLinked = result.outcomes.filter(outcome => outcome.status === 'linked').length;
  const note = await appendSuccessNoteCas(db, state.submission, actuallyLinked, now);
  return {
    mode: 'apply',
    created: actuallyLinked,
    verified: verified.length,
    noteAlreadyRecorded: note.alreadyRecorded,
    result,
  };
}

async function main() {
  const known = new Set(['--apply', '--dry-run', '--operator-authorized']);
  const unknown = process.argv.slice(2).filter(arg => !known.has(arg));
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) throw new Error('Choose either --apply or --dry-run');
  let output;
  if (apply) {
    requireValue(process.env.DEST_DATABASE_URL,
      'DEST_DATABASE_URL is required for transactional --apply');
    const pg = await import('pg');
    const { createTask4349PgAdapter } = await import('./lib/task4349-pg-adapter.mjs');
    const client = new pg.default.Client({
      connectionString: process.env.DEST_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `task4349:${INCIDENT.tenantId}:${INCIDENT.submissionId}`,
      ]);
      output = await recoverTraineeDepartmentLinks({
        db: createTask4349PgAdapter(client),
        apply: true,
        operatorAuthorized: process.argv.includes('--operator-authorized'),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  } else {
    const url = process.env.DEST_SUPABASE_URL;
    const key = process.env.DEST_SUPABASE_KEY;
    requireValue(url && key, 'DEST_SUPABASE_URL and DEST_SUPABASE_KEY (service role) are required');
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    output = await recoverTraineeDepartmentLinks({ db });
  }
  console.log(JSON.stringify(output, null, 2));
  if (!apply) console.log('DRY RUN ONLY: all validator reads ran; no database writes occurred.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Task #4349 recovery blocked: ${error.message}`);
    process.exitCode = 1;
  });
}