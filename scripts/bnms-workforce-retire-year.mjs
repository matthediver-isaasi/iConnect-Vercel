#!/usr/bin/env node
/**
 * Retire the obsolete workforce row_name field without touching row data.
 *
 * This is deliberately a metadata-only migration.  A dry-run report is a
 * review artifact; --apply requires that exact artifact and re-reads the
 * destination while holding transaction locks before making the three
 * possible metadata updates.
 *
 *   node scripts/bnms-workforce-retire-year.mjs --report=.local/reports/workforce-year.json
 *   node scripts/bnms-workforce-retire-year.mjs --apply \
 *     --review=.local/reports/workforce-year.json
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const ROW_OBJECT_ID = 'bf123bdb-7227-4f45-b5f9-8344d0f65446';
export const RETIRED_FIELD_ID = '68508e3d-577e-42d1-9e6d-8612241189dd';
export const REPLACEMENT_FIELD_ID = '27ecfa6d-f6c7-4320-b1e5-37d6ef8d7f01';
export const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const DESTINATION_PROJECT_SUFFIX = '.lvmzliemqnieeoruhkik';
const ACTOR = 'bnms-workforce-retire-year';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const clone = (value) => value == null ? value : structuredClone(value);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function active(row) {
  return row && row.archived_at == null
    && row.status !== 'archived'
    && row.is_active !== false;
}

function isFieldReference(value, wanted) {
  return value === wanted || value === `custom:${wanted}` || value === `field:${wanted}`;
}

function exactPaths(value, wanted, pathParts = []) {
  const paths = [];
  if (isFieldReference(value, wanted)) paths.push(pathParts.join('.') || '$');
  if (Array.isArray(value)) {
    value.forEach((item, index) => paths.push(...exactPaths(item, wanted, [...pathParts, String(index)])));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (isFieldReference(key, wanted)) paths.push([...pathParts, key].join('.'));
      paths.push(...exactPaths(item, wanted, [...pathParts, key]));
    }
  }
  return paths;
}

function presentationFieldId(element) {
  const value = element?.field_id ?? element?.fieldId;
  return String(value || '').replace(/^(field|custom):/, '');
}

function ruleMentionsField(rule, fieldIdToRemove) {
  return (rule?.conditions || []).some((condition) =>
    String(condition?.field_id ?? condition?.fieldId ?? '').replace(/^(field|custom):/, '')
      === fieldIdToRemove)
    || (rule?.actions || []).some((action) =>
      String(action?.target_field_id ?? action?.targetFieldId ?? '').replace(/^(field|custom):/, '')
        === fieldIdToRemove);
}

/**
 * Remove references only from the versioned presentation paths owned by the
 * custom-object presentation contract.  Anything left over is an unknown
 * reference and is rejected by buildPlan rather than silently edited.
 */
export function sanitizePresentationConfiguration(configuration, fieldId = RETIRED_FIELD_ID) {
  const output = clone(configuration ?? {});
  const removedPaths = [];
  const removeFrom = (parent, key, label) => {
    if (!Array.isArray(parent?.[key])) return;
    const before = parent[key];
    parent[key] = before.filter((item, index) => {
      const remove = isFieldReference(item, fieldId);
      if (remove) removedPaths.push(`${label}.${index}`);
      return !remove;
    });
  };

  const views = output?.views;
  removeFrom(views?.list, 'field_ids', 'views.list.field_ids');
  removeFrom(views?.organisation_directory, 'field_ids', 'views.organisation_directory.field_ids');
  const detail = views?.detail;
  removeFrom(detail, 'schema_field_ids', 'views.detail.schema_field_ids');
  if (Array.isArray(detail?.cards)) {
    detail.cards.forEach((card, cardIndex) => {
      if (!Array.isArray(card?.fields)) return;
      card.fields = card.fields.filter((element, elementIndex) => {
        const remove = (element?.type === 'field' || element?.type === 'custom')
          && (presentationFieldId(element) === fieldId || element.id === `field:${fieldId}`
            || element.id === `custom:${fieldId}`);
        if (remove) removedPaths.push(`views.detail.cards.${cardIndex}.fields.${elementIndex}`);
        return !remove;
      });
    });
  }
  const rules = detail?.visibility_rules;
  const ruleArray = Array.isArray(rules) ? rules : rules?.rules;
  if (Array.isArray(ruleArray)) {
    const retained = [];
    ruleArray.forEach((rule, index) => {
      const remove = ruleMentionsField(rule, fieldId);
      if (!remove) {
        retained.push(rule);
        return;
      }
      // Keep an otherwise unrelated rule intact.  When a rule contains both
      // retired and live clauses, remove only the retired clauses; discard it
      // only when no valid condition/action remains.
      const next = {
        ...rule,
        conditions: (rule.conditions || []).filter((condition) =>
          !isFieldReference(condition?.field_id ?? condition?.fieldId, fieldId)),
        actions: (rule.actions || []).filter((action) =>
          !isFieldReference(action?.target_field_id ?? action?.targetFieldId, fieldId)),
      };
      if (next.conditions.length && next.actions.length) {
        retained.push(next);
        removedPaths.push(`views.detail.visibility_rules.${index}.retired_clauses`);
      } else {
        removedPaths.push(`views.detail.visibility_rules.${index}`);
      }
    });
    // Mixed rules were added directly above so that their surviving clauses
    // retain their original ordering relative to the surrounding rules.
    if (Array.isArray(rules)) detail.visibility_rules = retained;
    else if (rules && typeof rules === 'object') rules.rules = retained;
  }
  return {
    configuration: output,
    changed: fingerprint(output) !== fingerprint(configuration ?? {}),
    removedPaths,
  };
}

function byId(rows = []) {
  const result = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    check(!result.has(row.id), `Duplicate destination id ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}

function assertTenantScope(state) {
  check(state.tenantId === TENANT_ID, 'Pinned BNMS tenant scope is missing or drifted.');
  for (const collection of ['objects', 'fields', 'definitions', 'records', 'edges']) {
    for (const row of state[collection] || []) {
      check(row.tenant_id === TENANT_ID, `Cross-tenant ${collection} row ${row.id} was returned; refusing migration.`);
    }
  }
}

function referenceInventory(state) {
  return [
    ...(state.activeFormReferences || []),
    ...(state.activeRelationshipPreviewReferences || []),
    ...(state.activeReportReferences || []),
    ...(state.activeConfigReferences || []),
  ];
}

function relevantScope(state) {
  const ordered = (rows) => [...(rows || [])].sort((left, right) =>
    String(left?.id || '').localeCompare(String(right?.id || '')));
  const orderedRefs = (rows) => ordered(rows);
  return {
    tenant_id: TENANT_ID,
    object: state.objects?.find((row) => row.id === ROW_OBJECT_ID) || null,
    fields: ordered((state.fields || []).filter((row) => row.custom_object_id === ROW_OBJECT_ID)),
    // These digests prove that this script did not change records or edges,
    // without placing record JSON in a review report.
    recordFingerprint: fingerprint(ordered(state.records)),
    edgeFingerprint: fingerprint(ordered(state.edges)),
    definitions: ordered((state.definitions || []).map(({ id, tenant_id, source_custom_object_id,
      target_custom_object_id, status, archived_at, configuration }) =>
      ({ id, tenant_id, source_custom_object_id, target_custom_object_id, status, archived_at, configuration }))),
    activeFormReferences: orderedRefs(state.activeFormReferences),
    activeRelationshipPreviewReferences: orderedRefs(state.activeRelationshipPreviewReferences),
    activeReportReferences: orderedRefs(state.activeReportReferences),
    activeConfigReferences: orderedRefs(state.activeConfigReferences),
    auditHistoryReferences: [...(state.auditHistoryReferences || [])].sort(),
    historicalReferences: orderedRefs(state.historicalReferences),
    existingReferenceTables: [...(state.existingReferenceTables || [])].sort(),
  };
}

export function buildPlan(state) {
  assertTenantScope(state);
  const objects = byId(state.objects);
  const fields = byId(state.fields);
  const rowObject = objects.get(ROW_OBJECT_ID);
  const retired = fields.get(RETIRED_FIELD_ID);
  const replacement = fields.get(REPLACEMENT_FIELD_ID);
  check(rowObject?.tenant_id === TENANT_ID && rowObject.object_key === 'workforce_survey_row',
    'Pinned workforce_survey_row object is missing or drifted.');
  check(retired?.tenant_id === TENANT_ID && retired.custom_object_id === ROW_OBJECT_ID
    && retired.name === 'row_name', 'Pinned row_name field is missing or drifted.');
  check(replacement?.tenant_id === TENANT_ID && replacement.custom_object_id === ROW_OBJECT_ID
    && replacement.name === 'staff_group' && replacement.is_active !== false,
  'Pinned staff_group replacement field is missing, drifted, or inactive.');

  const references = referenceInventory(state);
  check(!references.length,
    `Active workforce metadata references retired field outside the known presentation contract: ${
      references.map((item) => `${item.source}:${item.id}`).join(', ')}`);

  const presentation = sanitizePresentationConfiguration(rowObject.configuration);
  check(!exactPaths(presentation.configuration, RETIRED_FIELD_ID).length,
    'Retired field remains in an unknown workforce presentation configuration path.');
  const otherConfigReferences = (state.objects || [])
    .filter((object) => object.id !== ROW_OBJECT_ID && active(object))
    .flatMap((object) => exactPaths(object.configuration, RETIRED_FIELD_ID)
      .map((pathValue) => ({ source: `object:${object.id}`, path: pathValue })));
  check(!otherConfigReferences.length,
    'Retired field is referenced by an unrelated active object configuration.');

  const completed = retired.is_active === false
    && rowObject.primary_display_field_id === REPLACEMENT_FIELD_ID
    && !presentation.changed;
  if (completed) {
    return {
      completed: true,
      changed: false,
      setPrimaryDisplayFieldId: null,
      deactivateFieldId: null,
      configuration: presentation.configuration,
      removedPresentationPaths: [],
      summary: { fieldsDeactivated: 0, primaryDisplayUpdated: 0,
        configurationsUpdated: 0, recordsUpdated: 0, edgesUpdated: 0, writes: 0 },
    };
  }

  return {
    completed: false,
    changed: true,
    // The primary-display update is intentionally a separate planned write
    // which applyAtomically performs before is_active is changed.
    setPrimaryDisplayFieldId: rowObject.primary_display_field_id === REPLACEMENT_FIELD_ID
      ? null : REPLACEMENT_FIELD_ID,
    deactivateFieldId: retired.is_active === false ? null : RETIRED_FIELD_ID,
    configuration: presentation.configuration,
    removedPresentationPaths: presentation.removedPaths,
    summary: {
      fieldsDeactivated: retired.is_active === false ? 0 : 1,
      primaryDisplayUpdated: rowObject.primary_display_field_id === REPLACEMENT_FIELD_ID ? 0 : 1,
      configurationsUpdated: presentation.changed ? 1 : 0,
      recordsUpdated: 0,
      edgesUpdated: 0,
      writes: (retired.is_active === false ? 0 : 1)
        + (rowObject.primary_display_field_id === REPLACEMENT_FIELD_ID ? 0 : 1)
        + (presentation.changed ? 1 : 0),
    },
  };
}

function orderedFingerprint(rows) {
  return fingerprint([...(rows || [])].sort((left, right) =>
    String(left?.id || '').localeCompare(String(right?.id || ''))));
}

export function verifyPostcondition(beforeState, afterState, plan) {
  const rowObject = afterState.objects?.find((row) => row.id === ROW_OBJECT_ID);
  const retired = afterState.fields?.find((row) => row.id === RETIRED_FIELD_ID);
  const replacement = afterState.fields?.find((row) => row.id === REPLACEMENT_FIELD_ID);
  check(rowObject?.primary_display_field_id === REPLACEMENT_FIELD_ID,
    'Postcondition did not set staff_group as the primary display field.');
  check(retired?.is_active === false, 'Postcondition did not deactivate row_name.');
  check(replacement?.is_active !== false, 'Postcondition found staff_group inactive.');
  check(!exactPaths(rowObject.configuration, RETIRED_FIELD_ID).length,
    'Postcondition found a retired field reference in workforce presentation metadata.');
  check(orderedFingerprint(beforeState.records) === orderedFingerprint(afterState.records),
    'Postcondition found record data or record metadata drift.');
  check(orderedFingerprint(beforeState.edges) === orderedFingerprint(afterState.edges),
    'Postcondition found relationship edge graph drift.');
  check(fingerprint(afterState.activeFormReferences || []) === fingerprint(beforeState.activeFormReferences || [])
    && fingerprint(afterState.activeRelationshipPreviewReferences || [])
      === fingerprint(beforeState.activeRelationshipPreviewReferences || [])
    && fingerprint(afterState.activeReportReferences || []) === fingerprint(beforeState.activeReportReferences || []),
  'Postcondition found reference inventory drift.');
  check(fingerprint(rowObject.configuration) === fingerprint(plan.configuration),
    'Postcondition workforce presentation configuration differs from the reviewed plan.');
  return { completed: true, recordsPreserved: true, edgesPreserved: true, historicalDataPreserved: true };
}

function relativePath(input) {
  const resolved = path.resolve(ROOT, input);
  check(resolved.startsWith(`${ROOT}${path.sep}`), 'Report paths must remain inside the workspace.');
  return resolved;
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const review = argv.find((arg) => arg.startsWith('--review='));
  const report = argv.find((arg) => arg.startsWith('--report='));
  check(argv.every((arg) => arg === '--apply' || arg.startsWith('--review=') || arg.startsWith('--report=')),
    'Supported arguments are --apply, --review=<path>, and --report=<path>.');
  check(!apply || review, '--apply requires an explicit reviewed dry-run report via --review=<path>.');
  return { apply, review, report };
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows.map((row) => row.row ?? row);
}

async function tableExists(client, tableName) {
  const result = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS present', [`public.${tableName}`],
  );
  return result.rows[0]?.present === true;
}

const REFERENCE_TABLES = new Set(['form', 'report', 'custom_object_report', 'system_settings']);
const CORE_LOCK_TABLES = [
  'custom_object_definition', 'preference_field', 'custom_object_record',
  'custom_object_relationship', 'custom_object_relationship_definition',
];

/**
 * Keep the database snapshot wrapper and its state payload interchangeable at
 * this boundary.  loadSnapshot returns { state, existingReferenceTables };
 * the reference-table inventory itself lives in state so it participates in
 * the reviewed fingerprint.
 */
export function lockTableNames(snapshot) {
  const referenceTables = snapshot?.state?.existingReferenceTables
    ?? snapshot?.existingReferenceTables
    ?? [];
  for (const table of referenceTables) {
    check(REFERENCE_TABLES.has(table), `Unexpected reference table lock ${table}.`);
  }
  return [...new Set([...CORE_LOCK_TABLES, ...referenceTables])];
}

async function readReferenceTable(client, tableName) {
  check(REFERENCE_TABLES.has(tableName), 'Unexpected reference table identifier.');
  if (!await tableExists(client, tableName)) return { exists: false, rows: [] };
  const columns = (await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [tableName])).rows.map((row) => row.column_name);
  if (tableName !== 'system_settings') {
    check(columns.includes('tenant_id'), `${tableName} has no tenant_id; refusing unscoped reference inventory.`);
  }
  const rows = tableName === 'system_settings'
    ? await queryRows(client, `SELECT to_jsonb(t) AS row FROM public.${tableName} t`)
    : await queryRows(client, `SELECT to_jsonb(t) AS row FROM public.${tableName} t WHERE t.tenant_id = $1`, [TENANT_ID]);
  return { exists: true, rows };
}

function refsFromRows(rows, source, { activeOnly = false } = {}) {
  return rows.flatMap((row) => {
    if (activeOnly && !active(row)) return [];
    return exactPaths(row, RETIRED_FIELD_ID).map((pathValue) => ({
      source, id: row.id || '(settings)', path: pathValue,
    }));
  });
}

async function loadSnapshot(client) {
  const tenant = (await client.query('SELECT id FROM public.tenant WHERE id = $1', [TENANT_ID])).rows[0];
  check(tenant?.id === TENANT_ID, 'Pinned BNMS tenant is unavailable.');
  const objects = await queryRows(client, `
    SELECT to_jsonb(o) AS row FROM public.custom_object_definition o WHERE o.tenant_id = $1
  `, [TENANT_ID]);
  const fields = await queryRows(client, `
    SELECT to_jsonb(f) AS row FROM public.preference_field f
    WHERE f.tenant_id = $1 AND f.custom_object_id = $2
  `, [TENANT_ID, ROW_OBJECT_ID]);
  const records = await queryRows(client, `
    SELECT to_jsonb(r) AS row FROM public.custom_object_record r WHERE r.tenant_id = $1
  `, [TENANT_ID]);
  const definitions = await queryRows(client, `
    SELECT to_jsonb(d) AS row FROM public.custom_object_relationship_definition d WHERE d.tenant_id = $1
  `, [TENANT_ID]);
  const edges = await queryRows(client, `
    SELECT to_jsonb(e) AS row FROM public.custom_object_relationship e WHERE e.tenant_id = $1
  `, [TENANT_ID]);
  const forms = await readReferenceTable(client, 'form');
  const reports = await readReferenceTable(client, 'report');
  const customReports = await readReferenceTable(client, 'custom_object_report');
  const settings = await readReferenceTable(client, 'system_settings');
  const activeFormReferences = refsFromRows(forms.rows, 'form', { activeOnly: true });
  const activeReportReferences = [
    ...refsFromRows(reports.rows, 'report', { activeOnly: true }),
    ...refsFromRows(customReports.rows, 'custom_object_report', { activeOnly: true }),
    ...refsFromRows(settings.rows, 'system_settings'),
  ];
  const activeRelationshipPreviewReferences = definitions
    .filter((definition) => active(definition))
    .flatMap((definition) => exactPaths(definition.configuration, RETIRED_FIELD_ID)
      .map((pathValue) => ({ source: `relationship:${definition.id}`, id: definition.id, path: pathValue })));
  const activeConfigReferences = objects
    .filter((object) => active(object) && object.id !== ROW_OBJECT_ID)
    .flatMap((object) => exactPaths(object.configuration, RETIRED_FIELD_ID)
      .map((pathValue) => ({ source: `object:${object.id}`, id: object.id, path: pathValue })));
  const audit = await tableExists(client, 'custom_object_audit_event')
    ? await queryRows(client, `
      SELECT id FROM public.custom_object_audit_event
      WHERE tenant_id = $1 AND to_jsonb(custom_object_audit_event)::text LIKE $2
    `, [TENANT_ID, `%${RETIRED_FIELD_ID}%`])
    : [];
  const historicalReferences = [
    ...refsFromRows(forms.rows, 'historical-form'),
    ...refsFromRows(reports.rows, 'historical-report'),
    ...refsFromRows(customReports.rows, 'historical-custom_object_report'),
  ];
  return {
    state: {
      tenantId: TENANT_ID, objects, fields, records, definitions, edges,
      activeFormReferences, activeRelationshipPreviewReferences,
      activeReportReferences, activeConfigReferences,
      auditHistoryReferences: audit.map((row) => row.id),
      historicalReferences,
      existingReferenceTables: [
        forms.exists && 'form', reports.exists && 'report',
        customReports.exists && 'custom_object_report', settings.exists && 'system_settings',
      ].filter(Boolean),
    },
    scope: null,
  };
}

function reportFor(state, plan, dryRun) {
  return {
    review_version: 1,
    generated_at: new Date().toISOString(),
    tenantId: TENANT_ID,
    dryRun,
    preflightFingerprint: fingerprint(relevantScope(state)),
    summary: { ...plan.summary, completedReplay: plan.completed },
    metadata: {
      retiredField: RETIRED_FIELD_ID,
      replacementField: REPLACEMENT_FIELD_ID,
      rowObject: ROW_OBJECT_ID,
      removedPresentationPaths: plan.removedPresentationPaths,
      auditHistoryRowsInspected: state.auditHistoryReferences.length,
      historicalReferencesPreserved: state.historicalReferences.length,
      referenceTablesInspected: state.existingReferenceTables || [],
    },
    safety: {
      destinationOnly: true,
      noWritesDuringDryRun: dryRun,
      reviewedFingerprintRequired: true,
      transactionalLocks: true,
      recordsAndEdgesUntouched: true,
      noBulkImport: true,
      noHardDelete: true,
      historicalRecordJsonPreserved: true,
      unknownActiveReferencesRejected: true,
    },
  };
}

async function destinationClient() {
  const connectionString = process.env.DEST_DATABASE_URL;
  check(connectionString, 'DEST_DATABASE_URL is required; source and bare DATABASE_URL are forbidden.');
  const destination = new URL(connectionString);
  const allowed = new Set([
    'aws-1-eu-central-1.pooler.supabase.com',
    'db.lvmzliemqnieeoruhkik.supabase.co',
  ]);
  check(allowed.has(destination.hostname) && (!destination.port || destination.port === '5432'),
    'Destination SQL host pin mismatch; use the BNMS direct database or IPv4 pooler.');
  if (destination.hostname.endsWith('.pooler.supabase.com')) {
    check(decodeURIComponent(destination.username).endsWith(DESTINATION_PROJECT_SUFFIX),
      'Shared pool username is not pinned to the BNMS Supabase project.');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) destination.searchParams.delete(key);
  const caResponse = await fetch(DESTINATION_CA_URL);
  check(caResponse.ok, `Destination CA download failed with HTTP ${caResponse.status}.`);
  const ca = await caResponse.text();
  check(ca.includes('BEGIN CERTIFICATE'), 'Destination CA download was not a PEM certificate.');
  return { client: new pg.Client({
    connectionString: destination.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: destination.hostname },
  }), hostname: destination.hostname };
}

async function readReview(argument) {
  const review = JSON.parse(await readFile(relativePath(argument.slice('--review='.length)), 'utf8'));
  check(review?.review_version === 1 && review.tenantId === TENANT_ID
    && typeof review.preflightFingerprint === 'string',
  'Review report is not a valid pinned BNMS workforce year-retirement preflight.');
  return review;
}

async function applyAtomically(snapshot, plan) {
  const { client } = await destinationClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `bnms-workforce-retire-year:${TENANT_ID}`,
    ]);
    await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR KEY SHARE', [TENANT_ID]);
    const lockTables = lockTableNames(snapshot);
    await client.query(`LOCK TABLE ${lockTables.map((name) => `public.${name}`).join(', ')}
      IN SHARE ROW EXCLUSIVE MODE`);
    const locked = await loadSnapshot(client);
    locked.scope = relevantScope(locked.state);
    check(fingerprint(locked.scope) === fingerprint(snapshot.scope),
      'Destination metadata, record data, edge graph, or reference inventory drifted after review; transaction rolled back.');
    const lockedPlan = buildPlan(locked.state);
    check(fingerprint(lockedPlan) === fingerprint(plan),
      'Destination workforce year-retirement plan changed after review; transaction rolled back.');
    if (lockedPlan.completed) {
      await client.query('COMMIT');
      return { applied: false, noOp: true };
    }
    // Set the replacement primary display first.  The API's field archive
    // guard rejects deactivation while the old field is still primary.
    if (lockedPlan.setPrimaryDisplayFieldId) {
      const result = await client.query(`
        UPDATE public.custom_object_definition
        SET primary_display_field_id = $1, updated_by = $2
        WHERE tenant_id = $3 AND id = $4
          AND primary_display_field_id IS DISTINCT FROM $5::uuid
      `, [REPLACEMENT_FIELD_ID, ACTOR, TENANT_ID, ROW_OBJECT_ID, REPLACEMENT_FIELD_ID]);
      check(result.rowCount === 1, 'Primary display field changed during the guarded transaction.');
    }
    if (fingerprint(lockedPlan.configuration)
      !== fingerprint(locked.state.objects.find((row) => row.id === ROW_OBJECT_ID)?.configuration)) {
      const result = await client.query(`
        UPDATE public.custom_object_definition
        SET configuration = $1::jsonb, updated_by = $2
        WHERE tenant_id = $3 AND id = $4 AND configuration = $5::jsonb
      `, [JSON.stringify(lockedPlan.configuration), ACTOR, TENANT_ID, ROW_OBJECT_ID,
        JSON.stringify(locked.state.objects.find((row) => row.id === ROW_OBJECT_ID)?.configuration)]);
      check(result.rowCount === 1, 'Workforce presentation configuration changed during the guarded transaction.');
    }
    if (lockedPlan.deactivateFieldId) {
      const result = await client.query(`
        UPDATE public.preference_field
        SET is_active = false, updated_by = $2
        WHERE tenant_id = $1 AND custom_object_id = $3 AND id = $4 AND is_active = true
      `, [TENANT_ID, ACTOR, ROW_OBJECT_ID, RETIRED_FIELD_ID]);
      check(result.rowCount === 1, 'row_name changed during the guarded transaction.');
    }
    const after = await loadSnapshot(client);
    verifyPostcondition(locked.state, after.state, lockedPlan);
    await client.query('COMMIT');
    return { applied: true, noOp: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const { apply, review, report } = parseArgs(process.argv.slice(2));
  const { client } = await destinationClient();
  await client.connect();
  let loaded;
  try {
    loaded = await loadSnapshot(client);
  } finally {
    await client.end();
  }
  loaded.scope = relevantScope(loaded.state);
  const plan = buildPlan(loaded.state);
  let output = reportFor(loaded.state, plan, !apply);
  if (apply) {
    const reviewed = await readReview(review);
    check(reviewed.preflightFingerprint === output.preflightFingerprint,
      'Destination state differs from the reviewed dry run; no write was attempted.');
    const applied = await applyAtomically(loaded, plan);
    const { client: verifyClient } = await destinationClient();
    await verifyClient.connect();
    let verified;
    try {
      verified = await loadSnapshot(verifyClient);
    } finally {
      await verifyClient.end();
    }
    const replay = buildPlan(verified.state);
    check(replay.completed, 'Post-apply replay did not reach the completed zero-write state.');
    output = { ...reportFor(verified.state, replay, false), applied: applied.applied, noOp: applied.noOp };
  }
  if (report) {
    const destination = relativePath(report.slice('--report='.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
    output = { ...output, reportPath: path.relative(ROOT, destination) };
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bnms-workforce-retire-year: ${error.message || error}`);
    process.exitCode = 1;
  });
}