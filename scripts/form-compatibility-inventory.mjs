#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDestination, PROJECT } from './import-bnms-final-members.mjs';
import {
  assessFormMutationAccess,
  classifyFormMutationContract,
  FORM_RECORD_ACCESS,
  supportsApplicantContinuationIssuance,
} from '../shared/formMutationContract.js';

export const TARGET_FORM_IDS = Object.freeze([
  '57b94fc2-359d-434c-acd6-794865797ade',
  'a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b',
]);
export const DEFAULT_PAGE_SIZE = 100;
const FIXTURE_DIRECTORY = path.resolve('tests/fixtures/form-compatibility');
const REPORT_FILE = path.resolve('scripts/form-compatibility-audit.json');
const SAFE_ENUM_KEYS = new Set([
  'type', 'layout_type', 'form_type', 'application_level', 'prefill_source',
  'entity_action', 'member_entity_action', 'organization_entity_action',
  'action_type', 'source_type', 'target_type', 'target_entity', 'target_field',
  'transformation', 'uniqueness_key', 'operator', 'logic', 'rule_type',
  'mode',
  'set_value_source', 'formula_operator', 'formula_operand_a_mode',
  'formula_operand_b_mode', 'create_entity_type',
]);
const CONTENT_KEYS = new Set([
  'name', 'description', 'label', 'title', 'placeholder', 'options', 'value',
  'static_value', 'set_value', 'default_value', 'terms_url', 'redirect_url',
  'success_message', 'submit_button_text', 'body', 'content', 'html',
]);
const FORM_SELECT = `
  id, tenant_id, layout_type, fields, pages, require_authentication, is_active,
  is_application_form, application_level, uniqueness_checks, auto_create_entity,
  field_mappings, create_entity_type, prefill_source, visibility_rules,
  entity_action, member_entity_action, organization_entity_action,
  default_member_role_id, additional_member_creations, entity_pipelines,
  form_type, access_policy, structured_actions, prefill_source_field_id`;

const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const countBy = (values, key = value => value) => Object.fromEntries(
  [...values.reduce((map, value) => {
    const item = String(key(value));
    map.set(item, (map.get(item) || 0) + 1);
    return map;
  }, new Map())].sort(([a], [b]) => a.localeCompare(b)),
);
const alias = (prefix, value) => `${prefix}_${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;

export async function readAllForms(client, pageSize = DEFAULT_PAGE_SIZE, { hasMutationAccessPolicy = false } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('pageSize must be an integer from 1 to 1000');
  }
  const rows = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const result = await client.query(
      `select ${FORM_SELECT}${hasMutationAccessPolicy ? ', mutation_access_policy' : ''} from public.form
       where ($1::uuid is null or id > $1::uuid)
       order by id asc limit $2`,
      [cursor, pageSize],
    );
    pages += 1;
    rows.push(...result.rows);
    if (result.rows.length < pageSize) break;
    const next = result.rows.at(-1)?.id;
    if (!next || next === cursor) throw new Error('Form pagination cursor did not advance');
    cursor = next;
  }
  return { rows, pages, pageSize };
}

function pipelineEntries(form) {
  const pipelines = object(form.entity_pipelines);
  return Object.entries(pipelines).flatMap(([collection, entries]) =>
    array(entries).map(entry => ({ collection, ...object(entry) })));
}

function mappingEntries(form) {
  return [
    ...array(form.field_mappings),
    ...pipelineEntries(form).flatMap(pipeline => array(pipeline.mappings)),
    ...array(form.additional_member_creations).flatMap(item => array(item?.mappings)),
  ];
}

export function classifyForm(form) {
  const structured = Array.isArray(form.structured_actions)
    ? form.structured_actions
    : array(object(form.structured_actions).actions);
  const pipelines = pipelineEntries(form);
  const legacyMappings = array(form.field_mappings);
  const families = [];
  if (structured.length) families.push('structured-actions-current');
  if (pipelines.length) families.push('entity-pipelines-modern');
  if ([form.entity_action, form.member_entity_action, form.organization_entity_action]
    .some(action => ['create', 'update', 'upsert'].includes(action))) {
    families.push('split-entity-actions-current');
  }
  if (legacyMappings.length) families.push('legacy-field-mappings');
  if (form.auto_create_entity) families.push('legacy-auto-create');
  if (!families.length) families.push('display-only');

  const actions = [
    form.entity_action,
    form.member_entity_action,
    form.organization_entity_action,
    ...structured.map(action => action?.operation || action?.action_type || action?.type),
  ].filter(value => typeof value === 'string' && value.length && value !== 'none');
  const mappings = mappingEntries(form);
  const organizationPipelines = pipelines.filter(pipeline =>
    ['organisations', 'organizations'].includes(pipeline.collection));
  const memberPipelines = pipelines.filter(pipeline => pipeline.collection === 'members');
  const organizationMappings = organizationPipelines.flatMap(pipeline => array(pipeline.mappings));
  const memberMappings = memberPipelines.flatMap(pipeline => array(pipeline.mappings));
  const customWriteCount = mappings.filter(mapping =>
    ['custom', 'custom_field', 'communication'].includes(mapping?.target_type)).length;
  const invoiceWriteCount = mappings.filter(mapping =>
    ['invoicing_address', 'invoicing_email'].includes(mapping?.target_field)).length;
  const identityKeys = pipelines.map(pipeline => pipeline.uniqueness_key).filter(Boolean);
  const loginSettings = pipelines.map(pipeline => pipeline.login_enabled).filter(value => typeof value === 'boolean');
  const mutationContract = classifyFormMutationContract(form);
  const mutationAssessment = assessFormMutationAccess(form);
  const existingRecordOperations = mutationContract.mutationTargets;
  const exceptions = [];
  if (!form.id || !form.tenant_id) exceptions.push('missing-form-or-tenant-identity');
  if (form.entity_pipelines != null && typeof form.entity_pipelines !== 'object') exceptions.push('malformed-entity-pipelines');
  if (form.structured_actions != null
    && !Array.isArray(form.structured_actions)
    && (!object(form.structured_actions) || !Array.isArray(form.structured_actions.actions))) {
    exceptions.push('malformed-structured-actions');
  }
  const knownActions = new Set([
    'create', 'update', 'upsert', 'update_selected',
    'resolve_record_reference', 'resolve_record_references',
    'find_or_create', 'reuse', 'link_existing', 'link_relationship',
  ]);
  for (const action of actions) {
    if (!knownActions.has(action)) exceptions.push('unclassified-action');
  }

  return {
    primaryFamily: families[0],
    families,
    access: form.require_authentication ? 'authenticated' : 'public',
    hasAccessPolicy: Boolean(form.access_policy),
    prefill: form.prefill_source || 'none',
    actionModes: [...new Set(actions)].sort(),
    existingRecordOperations: [...existingRecordOperations].sort(),
    mutationContract: {
      hasExistingRecordMutation: mutationContract.hasExistingRecordMutation,
      mutationTargets: [...mutationContract.mutationTargets].sort(),
      applicantContinuationSupported: supportsApplicantContinuationIssuance(form),
      applicantContinuationLimitations:
        mutationContract.applicantContinuationUnsupportedReasons.map(reason => ({
          family: reason.family,
          operation: reason.operation,
        })),
      targets: Object.fromEntries(Object.entries(mutationContract.targets).map(([entity, target]) => [
        entity,
        {
          classification: target.classification,
          evidence: target.evidence.map(item => ({ family: item.family, access: item.access })),
        },
      ])),
      accessAssessment: {
        ok: mutationAssessment.ok,
        code: mutationAssessment.code || null,
        policyConfigured: mutationAssessment.policy != null,
      },
    },
    pipelineCount: pipelines.length,
    identityKeys: [...new Set(identityKeys)].sort(),
    loginEnabled: {
      true: loginSettings.filter(Boolean).length,
      false: loginSettings.filter(value => !value).length,
    },
    mappingCount: mappings.length,
    customWriteCount,
    invoiceWriteCount,
    entityWrites: {
      member: {
        pipelineCount: memberPipelines.length,
        identityKeys: [...new Set(memberPipelines.map(item => item.uniqueness_key).filter(Boolean))].sort(),
        customWriteCount: memberMappings.filter(mapping =>
          ['custom', 'custom_field', 'communication'].includes(mapping?.target_type)).length,
        invoiceWriteCount: memberMappings.filter(mapping =>
          ['invoicing_address', 'invoicing_email'].includes(mapping?.target_field)).length,
      },
      organization: {
        pipelineCount: organizationPipelines.length,
        identityKeys: [...new Set(organizationPipelines.map(item => item.uniqueness_key).filter(Boolean))].sort(),
        hasNameIdentityMapping: organizationPipelines.some(pipeline =>
          pipeline.uniqueness_key === 'name'
          && array(pipeline.mappings).some(mapping => mapping?.target_field === 'name')),
        customWriteCount: organizationMappings.filter(mapping =>
          ['custom', 'custom_field', 'communication'].includes(mapping?.target_type)).length,
        invoiceWriteCount: organizationMappings.filter(mapping =>
          ['invoicing_address', 'invoicing_email'].includes(mapping?.target_field)).length,
      },
    },
    exceptions: [...new Set(exceptions)].sort(),
  };
}

function safeKey(key) {
  if (/^(field|page|rule|action)_\d+$/i.test(key) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key)) {
    return alias('key', key);
  }
  return key;
}

export function sanitizeStructure(value, key = '', depth = 0) {
  if (depth > 20) return '<depth-limit>';
  if (CONTENT_KEYS.has(key)) return undefined;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return value.map(item => sanitizeStructure(item, key, depth + 1)).filter(item => item !== undefined);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
      const sanitized = sanitizeStructure(childValue, childKey, depth + 1);
      return sanitized === undefined ? [] : [[safeKey(childKey), sanitized]];
    }));
  }
  if (typeof value !== 'string') return `<${typeof value}>`;
  if (key === 'id' || key.endsWith('_id') || key.endsWith('_ids') || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
    return value ? alias('ref', value) : '';
  }
  if (SAFE_ENUM_KEYS.has(key) && /^[a-z0-9_-]{0,64}$/i.test(value)) return value;
  return value === '' ? '' : '<redacted>';
}

export function makeFixture(form) {
  const classification = classifyForm(form);
  return {
    schemaVersion: 1,
    source: 'production read-only repeatable-read inventory',
    formId: form.id,
    tenantAlias: alias('tenant', form.tenant_id),
    classification,
    structure: sanitizeStructure({
      layout_type: form.layout_type,
      fields: form.fields,
      pages: form.pages,
      require_authentication: form.require_authentication,
      is_active: form.is_active,
      is_application_form: form.is_application_form,
      application_level: form.application_level,
      uniqueness_checks: form.uniqueness_checks,
      auto_create_entity: form.auto_create_entity,
      field_mappings: form.field_mappings,
      create_entity_type: form.create_entity_type,
      prefill_source: form.prefill_source,
      visibility_rules: form.visibility_rules,
      entity_action: form.entity_action,
      member_entity_action: form.member_entity_action,
      organization_entity_action: form.organization_entity_action,
      default_member_role_id: form.default_member_role_id,
      additional_member_creations: form.additional_member_creations,
      entity_pipelines: form.entity_pipelines,
      form_type: form.form_type,
      access_policy: form.access_policy,
      mutation_access_policy: form.mutation_access_policy,
      structured_actions: form.structured_actions,
      prefill_source_field_id: form.prefill_source_field_id,
    }),
  };
}

export function makeReport(forms, pagination, databaseCount) {
  const classified = forms.map(form => ({ form, classification: classifyForm(form) }));
  const configurationExceptions = classified.flatMap(({ form, classification }) =>
    classification.exceptions.map(type => ({ type, formAlias: alias('form', form.id) })));
  const susceptible = classified.filter(item => item.classification.mutationContract.hasExistingRecordMutation);
  const runtimeUnknowns = susceptible.map(({ form }) => ({
    type: 'runtime-processor-deployment-identity-unverified',
    formAlias: alias('form', form.id),
  }));
  const untestedFlows = susceptible.map(({ form }) => ({
    type: 'susceptible-flow-not-exercised',
    formAlias: alias('form', form.id),
  }));
  const unresolvedRows = [...configurationExceptions, ...runtimeUnknowns, ...untestedFlows];
  const susceptibleConfigurations = susceptible.map(({ form, classification }) => ({
    formAlias: alias('form', form.id),
    access: classification.access,
    prefill: classification.prefill,
    targets: classification.mutationContract.mutationTargets,
    mechanisms: [...new Set(Object.values(classification.mutationContract.targets)
      .flatMap(target => target.evidence.map(item => item.family)))].sort(),
    identityKeys: classification.identityKeys,
    customWriteCount: classification.customWriteCount,
    invoiceWriteCount: classification.invoiceWriteCount,
    accessContractAccepted: classification.mutationContract.accessAssessment.ok === true,
    flowTested: false,
    runtimeProcessorIdentity: 'unknown',
  }));
  const tenantAliases = new Map(forms.map(form => [form.tenant_id, alias('tenant', form.tenant_id)]));
  const targetChecks = TARGET_FORM_IDS.map(id => {
    const match = classified.find(item => item.form.id === id);
    if (!match) return { formId: id, found: false };
    const c = match.classification;
    return {
      formId: id,
      found: true,
      public: c.access === 'public',
      organizationPrefill: c.prefill === 'organization',
      modernPipeline: c.families.includes('entity-pipelines-modern'),
      invoiceWrites: c.invoiceWriteCount,
      customWrites: c.customWriteCount,
      existingRecordOperations: c.existingRecordOperations,
      memberMutationRisk: c.mutationContract.targets.member.classification === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
      organizationMutationRisk: c.mutationContract.targets.organization.classification === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
      organizationNameIdentityMapping: c.entityWrites.organization.hasNameIdentityMapping,
      organizationIdentityKeys: c.entityWrites.organization.identityKeys,
      organizationInvoiceWrites: c.entityWrites.organization.invoiceWriteCount,
      organizationCustomWrites: c.entityWrites.organization.customWriteCount,
      findingKind: 'static-configuration-susceptibility',
      flowTested: false,
      runtimeProcessorIdentity: 'unknown',
    };
  });
  const sourceFiles = [
    'shared/formMutationContract.js',
    'api/forms/process-application.js',
  ];
  const formContractDisposition = classified.map(({ classification }) => {
    if (classification.mutationContract.hasExistingRecordMutation) return 'may_mutate_existing';
    const targetClasses = Object.values(classification.mutationContract.targets)
      .map(target => target.classification);
    if (targetClasses.includes(FORM_RECORD_ACCESS.CREATE_ONLY)) return 'create_only';
    if (targetClasses.includes(FORM_RECORD_ACCESS.REFERENCE_ONLY)) return 'reference_only';
    return 'none';
  });
  return {
    task: 4710,
    project: PROJECT,
    transaction: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT only; ROLLBACK',
    pagination: { ...pagination, databaseCount, complete: forms.length === databaseCount },
    coverage: {
      status: 'static-inventory-complete-runtime-unverified',
      forms: forms.length,
      tenants: tenantAliases.size,
      byPrimaryFamily: countBy(classified, item => item.classification.primaryFamily),
      byFamily: countBy(classified.flatMap(item => item.classification.families)),
      byAccess: countBy(classified, item => item.classification.access),
      byPrefill: countBy(classified, item => item.classification.prefill),
      canonicalContractClassifications: {
        forms: countBy(formContractDisposition),
        memberTargets: countBy(classified,
          item => item.classification.mutationContract.targets.member.classification),
        organizationTargets: countBy(classified,
          item => item.classification.mutationContract.targets.organization.classification),
      },
      withExistingRecordOperations: classified.filter(item => item.classification.existingRecordOperations.length).length,
      withIdentityKeys: classified.filter(item => item.classification.identityKeys.length).length,
      withCustomWrites: classified.filter(item => item.classification.customWriteCount).length,
      withInvoiceWrites: classified.filter(item => item.classification.invoiceWriteCount).length,
      susceptibleExistingRecordMutation: susceptible.length,
      susceptibleByTarget: {
        member: susceptible.filter(item =>
          item.classification.mutationContract.targets.member.classification === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING).length,
        organization: susceptible.filter(item =>
          item.classification.mutationContract.targets.organization.classification === FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING).length,
      },
      susceptiblePublicForms: susceptible.filter(item => item.classification.access === 'public').length,
      susceptibleWithoutAcceptedAccessContract: susceptible.filter(item =>
        item.classification.mutationContract.accessAssessment.ok !== true).length,
      susceptibleByMechanism: countBy(susceptible.flatMap(item =>
        [...new Set(Object.values(item.classification.mutationContract.targets)
          .flatMap(target => target.evidence.map(evidence => evidence.family)))])),
      actionModes: countBy(classified.flatMap(item => item.classification.actionModes)),
    },
    susceptibleConfigurations,
    exceptions: {
      configurationTotal: configurationExceptions.length,
      unresolvedTotal: unresolvedRows.length,
      unresolvedForms: new Set(unresolvedRows.map(row => row.formAlias)).size,
      byType: countBy(unresolvedRows, row => row.type),
      rows: unresolvedRows,
    },
    rowCounts: {
      databaseSnapshot: databaseCount,
      paginatedRows: forms.length,
      classifiedRows: classified.length,
      susceptibleRows: susceptibleConfigurations.length,
      nonSusceptibleRows: classified.length - susceptibleConfigurations.length,
      configurationExceptionRows: configurationExceptions.length,
      unresolvedFindingRows: unresolvedRows.length,
      requestedFixtureRows: targetChecks.filter(check => check.found).length,
    },
    evidenceLimits: {
      classification: 'Static persisted-configuration susceptibility using the local shared form mutation contract.',
      testedFlows: [],
      runtimeProcessorIdentity: 'unknown; no deployed source hash or revision was available from the read-only database inventory',
      conclusionBoundary: 'A susceptible classification means the configuration can reach an existing-record mutation path when runtime identity resolution matches. It does not prove that a production submission exercised that path.',
      localSourceHashes: Object.fromEntries(sourceFiles.map(file => [
        file,
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      ])),
    },
    targetChecks,
    safety: {
      piiStored: false,
      tokensStored: false,
      contentStored: false,
      identifiers: 'Only requested form IDs are retained; tenant and other identifiers are one-way aliases.',
    },
  };
}

export async function runInventory(client, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  let rolledBack = false;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const databaseCount = Number((await client.query('select count(*)::integer count from public.form')).rows[0].count);
    const hasMutationAccessPolicy = Boolean((await client.query(
      `select exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'form'
           and column_name = 'mutation_access_policy'
       ) present`,
    )).rows[0]?.present);
    const paginated = await readAllForms(client, pageSize, { hasMutationAccessPolicy });
    const report = makeReport(
      paginated.rows,
      { pages: paginated.pages, pageSize: paginated.pageSize, rowsRead: paginated.rows.length },
      databaseCount,
    );
    if (!report.pagination.complete) throw new Error('Pagination coverage does not match snapshot count');
    if (report.targetChecks.some(check => !check.found)) throw new Error('A requested GFI form was not found');
    mkdirSync(FIXTURE_DIRECTORY, { recursive: true });
    for (const id of TARGET_FORM_IDS) {
      const form = paginated.rows.find(row => row.id === id);
      writeFileSync(path.join(FIXTURE_DIRECTORY, `${id}.json`), `${JSON.stringify(makeFixture(form), null, 2)}\n`);
    }
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    await client.query('ROLLBACK');
    rolledBack = true;
    return report;
  } finally {
    if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
  }
}

export async function main() {
  const client = await connectDestination();
  try {
    const report = await runInventory(client);
    console.log(JSON.stringify({
      forms: report.coverage.forms,
      tenants: report.coverage.tenants,
      configurationExceptions: report.exceptions.configurationTotal,
      unresolvedFindings: report.exceptions.unresolvedTotal,
      unresolvedForms: report.exceptions.unresolvedForms,
      pagination: report.pagination,
      targetChecks: report.targetChecks,
      report: REPORT_FILE,
      fixtures: FIXTURE_DIRECTORY,
    }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Form compatibility inventory failed: ${error.message}`);
    process.exitCode = 1;
  });
}