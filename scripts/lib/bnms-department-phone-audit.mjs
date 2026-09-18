#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './member-index-destination.mjs';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const PHONE_FIELD_ID = '2126d5c5-ee9e-4ef4-b8f6-e584c5523b76';
export const PHONE_KEY = 'phone_number';

const CONFIG_TABLES = new Set([
  'custom_object_definition',
  'custom_object_relationship_definition',
  'custom_object_report_export_job',
  'dashboard_widget',
  'dynamic_directory',
  'form',
  'form_submission_saved_view',
  'workflow',
]);
const NUMERIC_TOKENS = new Set([
  'sum', 'avg', 'average', 'minimum', 'maximum', 'min', 'max',
  'greater_than', 'less_than', 'gte', 'lte', 'gt', 'lt',
  'numeric', 'number', 'decimal', 'range',
]);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function jsonReferences(value) {
  const output = [];
  const numericTokensFor = (container) => {
    const containerText = JSON.stringify(container).toLowerCase();
    return [...NUMERIC_TOKENS].filter((token) =>
      new RegExp(`(^|[^a-z0-9_])${token.replaceAll('_', '[_ -]?')}([^a-z0-9_]|$)`, 'i').test(containerText));
  };
  const referenceKind = (candidate) => {
    const text = String(candidate ?? '');
    if (text === PHONE_KEY) return 'field_key';
    if (text === PHONE_FIELD_ID || text === `field:${PHONE_FIELD_ID}`
      || text === `custom:${PHONE_FIELD_ID}` || text.includes(PHONE_FIELD_ID)) return 'field_id';
    return null;
  };
  const visit = (item, pathParts, container) => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, [...pathParts, index], item));
      return;
    }
    if (!item || typeof item !== 'object') {
      const reference = referenceKind(item);
      if (reference) {
        output.push({
          path: pathParts.join('.'),
          reference,
          numericTokens: numericTokensFor(container),
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      const nextPath = [...pathParts, key];
      const reference = referenceKind(key);
      if (reference && child && typeof child === 'object') {
        output.push({
          path: nextPath.join('.'),
          reference,
          numericTokens: numericTokensFor(item),
        });
      }
      visit(child, nextPath, item);
    }
  };
  visit(value, [], value);
  return output;
}

function fieldSnapshot(row) {
  const excluded = new Set(['created_by', 'updated_by', 'created_at', 'updated_at']);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key)));
}

async function discoverConfigColumns(client) {
  const { rows } = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and data_type in ('json', 'jsonb')
      order by table_name, ordinal_position`,
  );
  return rows.filter((row) => CONFIG_TABLES.has(row.table_name));
}

async function auditScalarConfigurationReferences(client) {
  const { rows: columns } = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1)
        and column_name ilike '%field%'
        and data_type in ('uuid', 'text', 'character varying')
      order by table_name, ordinal_position`,
    [[...CONFIG_TABLES]],
  );
  const references = [];
  for (const { table_name: table, column_name: column } of columns) {
    const metadata = await client.query(
      `select column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [table],
    );
    const names = new Set(metadata.rows.map((row) => row.column_name));
    if (!names.has('id') || !names.has('tenant_id')) continue;
    const result = await client.query(
      `select id::text as id, to_jsonb(candidate) as value
         from ${quoteIdentifier(table)} candidate
        where tenant_id = $1
          and ${quoteIdentifier(column)}::text in ($2, $3)
        order by id`,
      [TENANT_ID, PHONE_FIELD_ID, PHONE_KEY],
    );
    for (const row of result.rows) {
      const rowText = JSON.stringify(row.value).toLowerCase();
      references.push({
        table,
        column,
        rowId: row.id,
        path: column,
        reference: String(row.value?.[column]) === PHONE_FIELD_ID ? 'field_id' : 'field_key',
        numericTokens: [...NUMERIC_TOKENS].filter((token) =>
          new RegExp(`(^|[^a-z0-9_])${token.replaceAll('_', '[_ -]?')}([^a-z0-9_]|$)`, 'i').test(rowText)),
      });
    }
  }
  return references;
}

async function auditConfigurationReferences(client) {
  const columns = await discoverConfigColumns(client);
  const references = [];
  for (const { table_name: table, column_name: column } of columns) {
    const metadata = await client.query(
      `select column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [table],
    );
    const names = new Set(metadata.rows.map((row) => row.column_name));
    const idColumn = names.has('id') ? 'id' : null;
    if (!idColumn || !names.has('tenant_id')) continue;
    const extraScope = names.has('custom_object_id')
      ? ` and (custom_object_id = $2 or ${quoteIdentifier(column)}::text ilike '%' || $3 || '%')`
      : '';
    const params = names.has('custom_object_id')
      ? [TENANT_ID, OBJECT_ID, OBJECT_ID, PHONE_FIELD_ID, PHONE_KEY]
      : [TENANT_ID, PHONE_FIELD_ID, PHONE_KEY];
    const fieldIdParam = names.has('custom_object_id') ? 4 : 2;
    const keyParam = names.has('custom_object_id') ? 5 : 3;
    const query = `
      select id::text as id, ${quoteIdentifier(column)} as value
        from ${quoteIdentifier(table)}
       where tenant_id = $1${extraScope}
         and (${quoteIdentifier(column)}::text ilike '%' || $${fieldIdParam} || '%'
           or ${quoteIdentifier(column)}::text ilike '%' || $${keyParam} || '%')
       order by id`;
    const result = await client.query(query, params);
    for (const row of result.rows) {
      const matches = jsonReferences(row.value);
      for (const match of matches) {
        references.push({
          table,
          column,
          rowId: row.id,
          ...match,
        });
      }
    }
  }
  const scalarReferences = await auditScalarConfigurationReferences(client);
  const seen = new Set();
  return [...references, ...scalarReferences].filter((item) => {
    const key = `${item.table}:${item.column}:${item.rowId}:${item.path}:${item.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function auditSchemaReferences(client) {
  const permissions = await client.query(
    `select id::text, custom_object_id::text, access_level
       from custom_object_field_role_permission
      where tenant_id = $1 and field_id = $2
      order by id`,
    [TENANT_ID, PHONE_FIELD_ID],
  );
  const indexes = await client.query(
    `select schemaname, tablename, indexname
       from pg_indexes
      where schemaname = 'public'
        and (indexdef ilike '%' || $1 || '%' or indexdef ilike '%' || $2 || '%')
      order by tablename, indexname`,
    [PHONE_FIELD_ID, PHONE_KEY],
  );
  const triggers = await client.query(
    `select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname = 'public'
        and (pg_get_triggerdef(t.oid) ilike '%' || $1 || '%'
          or pg_get_triggerdef(t.oid) ilike '%' || $2 || '%'
          or pg_get_functiondef(t.tgfoid) ilike '%' || $1 || '%'
          or pg_get_functiondef(t.tgfoid) ilike '%' || $2 || '%')
      order by c.relname, t.tgname`,
    [PHONE_FIELD_ID, PHONE_KEY],
  );
  return {
    fieldRolePermissions: permissions.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
  };
}

export async function auditPhoneDependencies(client) {
  const blockers = [];
  const fieldResult = await client.query(
    `select *
       from preference_field
      where id = $1 and tenant_id = $2 and custom_object_id = $3`,
    [PHONE_FIELD_ID, TENANT_ID, OBJECT_ID],
  );
  if (fieldResult.rows.length !== 1) {
    blockers.push(`Expected exactly one pinned BNMS phone field; found ${fieldResult.rows.length}.`);
  }
  const field = fieldResult.rows[0] || null;
  if (field && (field.name !== PHONE_KEY || !['number', 'text'].includes(field.field_type)
    || field.entity_scope !== 'custom_object' || field.is_active !== true)) {
    blockers.push('Pinned phone field is not the expected active custom-object number or text field.');
  }

  const objectResult = await client.query(
    `select id::text, tenant_id::text, object_key, status, archived_at
       from custom_object_definition
      where id = $1 and tenant_id = $2`,
    [OBJECT_ID, TENANT_ID],
  );
  if (objectResult.rows.length !== 1 || objectResult.rows[0].status !== 'active'
    || objectResult.rows[0].archived_at !== null) {
    blockers.push('Pinned BNMS Organisation department object is missing or inactive.');
  }

  const valuesResult = await client.query(
    `select
       count(*)::int as total_records,
       count(*) filter (where archived_at is null)::int as active_records,
       count(*) filter (where data ? $3)::int as records_with_key,
       count(*) filter (where data ? $3 and data -> $3 = 'null'::jsonb)::int as json_null,
       count(*) filter (where data ? $3 and jsonb_typeof(data -> $3) = 'number')::int as numeric_values,
       count(*) filter (where data ? $3 and jsonb_typeof(data -> $3) = 'string')::int as string_values,
       count(*) filter (where data ? $3 and jsonb_typeof(data -> $3) = 'string'
         and data ->> $3 = '')::int as empty_strings,
       count(*) filter (where data ? $3 and jsonb_typeof(data -> $3)
         not in ('number', 'string', 'null'))::int as other_values
     from custom_object_record
    where tenant_id = $1 and custom_object_id = $2`,
    [TENANT_ID, OBJECT_ID, PHONE_KEY],
  );
  const valueShape = valuesResult.rows[0];
  if (valueShape.other_values > 0) {
    blockers.push(`${valueShape.other_values} phone value(s) have an unsafe non-scalar JSON shape.`);
  }

  const configurationReferences = await auditConfigurationReferences(client);
  const numericReferences = configurationReferences.filter((item) => item.numericTokens.length > 0);
  if (numericReferences.length) {
    blockers.push(`${numericReferences.length} saved configuration reference(s) use the phone field with numeric semantics.`);
  }
  const schemaReferences = await auditSchemaReferences(client);
  if (schemaReferences.indexes.length || schemaReferences.triggers.length) {
    blockers.push('Phone-field indexes or triggers require manual review before changing the field type.');
  }

  const proposedField = field ? { ...fieldSnapshot(field), field_type: 'text' } : null;
  return {
    blockers,
    evidence: {
      project: PROJECT,
      tenantId: TENANT_ID,
      object: objectResult.rows[0] || null,
      phoneFieldId: PHONE_FIELD_ID,
      phoneKey: PHONE_KEY,
      currentField: field ? fieldSnapshot(field) : null,
      proposedField,
      settingsChangedByProposal: field?.field_type === 'number' ? ['field_type'] : [],
      existingValueShape: valueShape,
      configurationReferences,
      numericConfigurationReferences: numericReferences,
      schemaReferences,
    },
  };
}

async function main() {
  const client = await connectDestination();
  let report;
  try {
    if (client.connection?.stream?.encrypted !== true || client.connection?.stream?.authorized !== true) {
      throw new Error('Destination TLS connection is not encrypted and CA-authorized.');
    }
    await client.query('BEGIN READ ONLY');
    report = await auditPhoneDependencies(client);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
  const output = {
    observedAt: new Date().toISOString(),
    databaseWrites: 0,
    tls: { encrypted: true, authorized: true },
    ...report,
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const outputPath = path.join(root, 'reports/bnms-department-addresses/phone-audit.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(root, outputPath),
    blockers: output.blockers,
    existingValueShape: output.evidence.existingValueShape,
    configurationReferenceCount: output.evidence.configurationReferences.length,
  }, null, 2));
  if (output.blockers.length) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`BNMS phone dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}