#!/usr/bin/env node
// Strictly read-only, tenant-scoped snapshot of persisted GSF form configurations.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { makeFixture } from './form-compatibility-inventory.mjs';
import {
  classifyFormMutationContract,
  assessFormMutationAccess,
  validateFormMutationAccessSave,
  supportsApplicantContinuationIssuance,
  FORM_MUTATION_CONFIG_KEYS,
} from '../shared/formMutationContract.js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const PAGE_SIZE = 10;
const SINCE = '2026-09-01T00:00:00Z';
const EVIDENCE = 'docs/gsf-form-access-evidence.json';
const FIXTURES = 'tests/fixtures/gsf-form-access.json';
const CONFIG_COLUMNS = [
  'fields', 'pages', 'layout_type', 'is_application_form', 'application_level',
  'uniqueness_checks', 'auto_create_entity', 'field_mappings', 'create_entity_type',
  'prefill_source', 'visibility_rules', 'entity_action', 'member_entity_action',
  'organization_entity_action', 'default_member_role_id', 'additional_member_creations',
  'entity_pipelines', 'form_type', 'access_policy', 'mutation_access_policy',
  'structured_actions', 'prefill_source_field_id', 'require_authentication', 'is_active',
];
const columns = ['id', 'tenant_id', 'name', 'slug', ...CONFIG_COLUMNS];
const arr = x => Array.isArray(x) ? x : [];
const obj = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ref = value => `ref_${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x ?? null;
}
const count = (xs, predicate) => xs.filter(predicate).length;
const mappingMetrics = mappings => ({
  total: mappings.length,
  core: count(mappings, m => (m?.target_type || 'core') === 'core'),
  custom: count(mappings, m => ['custom', 'custom_field', 'communication'].includes(m?.target_type)),
  static: count(mappings, m => m?.source_type === 'static' || m?.set_value_source === 'static'),
  date: count(mappings, m => ['date', 'current_date'].includes(m?.source_type)
    || ['date', 'current_date'].includes(m?.transformation) || m?.set_value_source === 'date'),
  invoice: count(mappings, m => ['invoicing_address', 'invoicing_email'].includes(m?.target_field)),
  other: count(mappings, m => !['core', 'custom', 'custom_field', 'communication'].includes(m?.target_type || 'core')),
});

function fixtureStructure(form) {
  // Reuse the established content-redacting fixture helper. Restore only the
  // nonempty-label *predicate* required by organizationMappingAccess; the text
  // itself must never enter a fixture. Ensure dictionary binding keys and the
  // corresponding field IDs use the same synthetic reference namespace.
  const structure = makeFixture(form).structure;
  for (const [raw, sanitized] of arr(form.fields).map((field, i) => [field, arr(structure.fields)[i]])) {
    if (raw?.not_listed_choice && sanitized?.not_listed_choice
      && typeof raw.not_listed_choice.label === 'string'
      && raw.not_listed_choice.label.trim()) {
      sanitized.not_listed_choice.label = 'synthetic_nonempty_label';
    }
  }
  for (const [collection, entries] of Object.entries(obj(form.entity_pipelines))) {
    arr(entries).forEach((entry, i) => {
      const target = structure.entity_pipelines?.[collection]?.[i];
      if (target && entry?.field_mappings && typeof entry.field_mappings === 'object'
        && !Array.isArray(entry.field_mappings)) {
        target.field_mappings = Object.fromEntries(
          Object.entries(entry.field_mappings).map(([fieldId, value]) => [
            ref(fieldId),
            // Values were already redacted by makeFixture; retain them, not raw.
            Object.values(obj(target.field_mappings)).at(
              Object.keys(entry.field_mappings).indexOf(fieldId),
            ) ?? '<redacted>',
          ]),
        );
      }
    });
  }
  return structure;
}

function contractSignature(form) {
  const contract = classifyFormMutationContract(form);
  const assessment = assessFormMutationAccess(form);
  const unchanged = validateFormMutationAccessSave({ form, previousForm: form });
  const changed = validateFormMutationAccessSave({
    form: { ...form, fields: [...arr(form.fields), { id: '__audit_only_change__' }] },
    previousForm: form,
  });
  const save = result => ({
    ok: result.ok,
    code: result.code || null,
    legacyCompatibility: Boolean(result.legacyCompatibility),
    draftWarning: Boolean(result.draftWarning),
  });
  return {
    targets: Object.fromEntries(Object.entries(contract.targets).map(([key, target]) => [
      key, {
        classification: target.classification,
        evidence: target.evidence.map(e => ({ family: e.family, access: e.access })),
      },
    ])),
    mutationTargets: contract.mutationTargets,
    unsupportedReasons: contract.applicantContinuationUnsupportedReasons.map(r => ({
      family: r.family, operation: r.operation,
    })),
    continuationSupported: supportsApplicantContinuationIssuance(form),
    assessment: { ok: assessment.ok, code: assessment.code || null, mode: assessment.policy?.mode || null },
    unchanged: save(unchanged),
    changed: save(changed),
  };
}

function formEvidence(form) {
  const pipelines = Object.entries(obj(form.entity_pipelines)).flatMap(([destination, entries]) =>
    arr(entries).map(entry => {
      const p = obj(entry);
      const implicit = obj(p.field_mappings);
      return {
        destination,
        identityKey: p.uniqueness_key || null,
        loginEnabled: p.login_enabled ?? null,
        hasRoleAssignment: Boolean(p.role_id || p.role_assignment),
        mappings: mappingMetrics(arr(p.mappings)),
        implicitFieldMappingCount: Object.keys(implicit).length,
        // Do not persist source-field identifiers, static values or custom-field values.
      };
    }));
  const additional = arr(form.additional_member_creations).map(p => ({
    identityKey: p?.uniqueness_key || null,
    mappings: mappingMetrics(arr(p?.mappings)),
    implicitFieldMappingCount: Object.keys(obj(p?.field_mappings)).length,
  }));
  const structured = Array.isArray(form.structured_actions)
    ? form.structured_actions : arr(form.structured_actions?.actions);
  const contract = classifyFormMutationContract(form);
  const assessment = assessFormMutationAccess(form);
  // A no-op save checks the grandfathered legacy path; a config edit checks the
  // strict gate without writing anything. The edit changes only an in-memory key.
  const unchangedSave = validateFormMutationAccessSave({ form, previousForm: form });
  const changedSave = validateFormMutationAccessSave({
    form: { ...form, fields: [...arr(form.fields), { id: '__audit_only_change__' }] },
    previousForm: form,
  });
  return {
    id: form.id, name: form.name, slug: form.slug, isActive: form.is_active,
    requireAuthentication: form.require_authentication,
    accessPolicyConfigured: form.access_policy != null,
    mutationAccessPolicy: form.mutation_access_policy == null ? null : {
      version: form.mutation_access_policy.version ?? null,
      mode: form.mutation_access_policy.mode ?? null,
    },
    prefillSource: form.prefill_source || null,
    legacyActions: {
      entity: form.entity_action || null,
      member: form.member_entity_action || null,
      organization: form.organization_entity_action || null,
      createEntityType: form.create_entity_type || null,
      autoCreate: Boolean(form.auto_create_entity),
    },
    pipelines, legacyMappings: mappingMetrics(arr(form.field_mappings)),
    additionalMemberCreations: additional,
    structuredActions: structured.map(action => ({
      operation: action?.operation || null,
      targetKind: action?.target?.kind || action?.entity_type || action?.entity || null,
      notListedOperation: action?.not_listed_operation || null,
    })),
    classification: {
      hasExistingRecordMutation: contract.hasExistingRecordMutation,
      mutationTargets: contract.mutationTargets,
      targets: Object.fromEntries(Object.entries(contract.targets).map(([key, target]) => [
        key, {
          classification: target.classification,
          evidence: target.evidence.map(e => ({ family: e.family, access: e.access })),
        },
      ])),
      applicantContinuationUnsupported: contract.applicantContinuationUnsupportedReasons.map(r => ({
        family: r.family, operation: r.operation,
      })),
    },
    assessment: { ok: assessment.ok, code: assessment.code || null },
    saveChecks: {
      unchanged: { ok: unchangedSave.ok, legacyCompatibility: Boolean(unchangedSave.legacyCompatibility), draftWarning: Boolean(unchangedSave.draftWarning), code: unchangedSave.code || null },
      changed: { ok: changedSave.ok, legacyCompatibility: Boolean(changedSave.legacyCompatibility), draftWarning: Boolean(changedSave.draftWarning), code: changedSave.code || null },
    },
    configDigestSha256: hash(canonical(Object.fromEntries(CONFIG_COLUMNS.map(k => [k, form[k]])))),
    mutationConfigDigestSha256: hash(canonical(Object.fromEntries(FORM_MUTATION_CONFIG_KEYS.map(k => [k, form[k]])))),
  };
}

async function run(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let rolledBack = false;
  try {
    // Name/slug are independently verified from tenant, never inferred from the
    // provided UUID or any form row.
    const tenant = (await client.query(
      'select id, name, slug from public.tenant where id = $1::uuid', [TENANT_ID],
    )).rows;
    if (tenant.length !== 1 || tenant[0].name !== 'gsf' || tenant[0].slug !== 'gsf') {
      throw new Error('GSF tenant identity mismatch');
    }
    const snapshotAt = (await client.query('select transaction_timestamp() as at')).rows[0].at;
    const total = Number((await client.query(
      'select count(*)::integer as n from public.form where tenant_id = $1::uuid', [TENANT_ID],
    )).rows[0].n);
    const forms = [];
    let cursor = null;
    let pages = 0;
    while (true) {
      const page = (await client.query(
        `select ${columns.join(', ')} from public.form
         where tenant_id = $1::uuid and ($2::uuid is null or id > $2::uuid)
         order by id limit $3`, [TENANT_ID, cursor, PAGE_SIZE],
      )).rows;
      pages++;
      if (page.some(row => row.tenant_id !== TENANT_ID || (cursor && row.id <= cursor))) {
        throw new Error('GSF form pagination scope/order mismatch');
      }
      forms.push(...page);
      if (page.length < PAGE_SIZE) break;
      const next = page.at(-1).id;
      if (next === cursor) throw new Error('Pagination cursor did not advance');
      cursor = next;
    }
    if (forms.length !== total || new Set(forms.map(f => f.id)).size !== total) {
      throw new Error('GSF pagination does not reconcile to snapshot count');
    }
    // All activity is grouped inside the verified tenant's form set. No answer
    // payloads, respondent identity, draft data, grant IDs or token hashes leave DB.
    const submissions = (await client.query(`
      select s.form_id, s.status, count(*)::integer as n
      from public.form_submission s
      join public.form f on f.id = s.form_id and f.tenant_id = $1::uuid
      where s.tenant_id = $1::uuid and s.created_date >= $2::timestamptz
      group by s.form_id, s.status`, [TENANT_ID, SINCE])).rows;
    const drafts = (await client.query(`
      select d.form_id, count(*)::integer as n
      from public.form_draft_submission d
      join public.form f on f.id::text = d.form_id and f.tenant_id = $1::uuid
      where d.tenant_id = $1::text and d.expires_at > $2::timestamptz
      group by d.form_id`, [TENANT_ID, snapshotAt])).rows;
    const grants = (await client.query(`
      select g.form_id,
        case when g.revoked_at is not null then 'revoked'
             when g.submission_id is not null then 'consumed'
             when g.expires_at <= $2::timestamptz then 'expired'
             when g.organization_id is null then 'detached'
             else 'unexpired_unconsumed' end as status,
        count(*)::integer as n
      from public.form_applicant_continuation g
      join public.form f on f.id = g.form_id and f.tenant_id = $1::uuid
      where g.tenant_id = $1::uuid
      group by g.form_id, status`, [TENANT_ID, snapshotAt])).rows;
    const fixtures = forms.map(form => {
      const structure = fixtureStructure(form);
      if (JSON.stringify(contractSignature(form)) !== JSON.stringify(contractSignature(structure))) {
        throw new Error(`Sanitized contract parity mismatch for GSF form ${form.id}`);
      }
      return { formId: form.id, structure, contractSignature: contractSignature(structure) };
    });
    const rows = forms.map(form => ({
      ...formEvidence(form),
      activity: {
        submissionsSince: SINCE,
        submissionsByStatus: Object.fromEntries(submissions.filter(s => s.form_id === form.id).map(s => [s.status ?? 'null', s.n])),
        unexpiredDrafts: drafts.find(d => d.form_id === form.id)?.n ?? 0,
        grantsByStatus: Object.fromEntries(grants.filter(g => g.form_id === form.id).map(g => [g.status, g.n])),
      },
    }));
    const evidence = {
      schemaVersion: 1, project: PROJECT, tenant: tenant[0], snapshotAt, since: SINCE,
      publicHostIdentityCorroboration: {
        source: 'docs/gsf-form-deployment-evidence.md',
        endpoint: 'https://gsf.iconn.app/api/public/tenant-branding',
        documentedName: 'gsf',
        documentedSlug: 'gsf',
        note: 'Earlier public GET corroborates host identity; does not verify backend revision.',
      },
      transaction: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT only; ROLLBACK',
      pagination: { pageSize: PAGE_SIZE, pages, databaseCount: total, rowsRead: rows.length, reconciled: true },
      counts: {
        active: count(rows, r => r.isActive === true),
        inactive: count(rows, r => r.isActive === false),
        mayMutateExisting: count(rows, r => r.classification.hasExistingRecordMutation),
        accessAssessmentRejected: count(rows, r => !r.assessment.ok),
        changedSaveRejected: count(rows, r => !r.saveChecks.changed.ok),
      },
      limits: 'Static saved configuration, not runtime verification; submission counts do not establish successful processing. No respondent data or grants/tokens were retrieved.',
      forms: rows,
    };
    await client.query('ROLLBACK');
    rolledBack = true;
    return { evidence, fixtures };
  } finally {
    if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
  }
}

async function main() {
  const client = await connectDestination();
  try {
    const { evidence, fixtures } = await run(client);
    // Write local evidence only after database transaction has been rolled back.
    writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(FIXTURES, `${JSON.stringify({
      schemaVersion: 1, sourceSnapshotAt: evidence.snapshotAt,
      tenant: evidence.tenant, forms: evidence.forms.map((form, i) => ({
        ...form, structure: fixtures[i].structure, contractSignature: fixtures[i].contractSignature,
      })),
    }, null, 2)}\n`);
    console.log(JSON.stringify({ tenant: evidence.tenant, pagination: evidence.pagination, counts: evidence.counts, evidence: EVIDENCE, fixtures: FIXTURES }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`GSF read-only audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}