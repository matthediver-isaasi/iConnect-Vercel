import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './process-application.js';
import {
  isCleanPrimaryOutputDependencyWait,
} from './process-application.js';
import { buildFormProcessingHeaders } from '../_lib/formProcessingAuth.js';

const TENANT_ID = 'tenant-runtime-org';
const ORGANIZATION_ID = 'organization-structured-ordering';
const MEMBER_ID = 'member-structured-ordering';

function relationshipPayload({ structuredActions = null } = {}) {
  return {
    fields: [
      { id: 'email', type: 'email' },
      { id: 'organization', type: 'organisation_dropdown' },
    ],
    form_values: {
      email: 'ordering@example.test',
      organization: ORGANIZATION_ID,
    },
    application_level: 'member',
    create_entity_type: 'member',
    member_entity_action: 'upsert',
    organization_entity_action: 'none',
    entity_pipelines: {
      members: [{
        id: 'primary-member',
        isPrimary: true,
        mappings: [{
          id: 'member-email',
          source_type: 'field',
          source_field_id: 'email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
    structured_actions: structuredActions,
  };
}

function primaryOutputRelationshipAction() {
  return {
    version: 1,
    actions: [{
      id: 'link-primary-member',
      source: { scope: 'top_level' },
      operation: 'link_relationship',
      relationship_definition_id: 'member-organization',
      source_endpoint: {
        kind: 'member',
        source: { type: 'primary_pipeline_output' },
      },
      target_endpoint: {
        kind: 'organization',
        source: { type: 'field', field_id: 'organization' },
      },
    }],
  };
}

function makeOrderingDb({
  form,
  submission,
  existingMember,
  existingOrganization,
  relationshipDefinitions,
  roleRows = [],
  resumeUpdateError = null,
  ledger,
}) {
  const rows = {
    form: [form],
    form_submission: [submission],
    member: existingMember ? [existingMember] : [],
    organization: [existingOrganization],
    custom_object_relationship_definition: relationshipDefinitions,
    custom_object_relationship: [],
    form_submission_pipeline_entity: [],
    form_submission_entity_creation: [],
    preference_field: [],
    organization_group: [],
    member_preference_value: [],
    organization_preference_value: [],
    member_resource_category: [],
    role: roleRows,
  };
  const inserts = [];
  const updates = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = null;
      this.payload = null;
      this.inserted = null;
    }

    select() { return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    neq(column, value) { this.filters.push(['neq', column, value]); return this; }
    ilike(column, value) { this.filters.push(['ilike', column, value]); return this; }
    in(column, value) { this.filters.push(['in', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    or() { return this; }
    filter() { return this; }
    order() { return this; }
    limit() { return this; }

    insert(payload) {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    upsert(payload) {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.operation = 'update';
      this.payload = payload;
      return this;
    }

    delete() {
      this.operation = 'delete';
      return this;
    }

    matching() {
      const tableRows = rows[this.table] || [];
      return tableRows.filter(row => this.filters.every(([operator, column, value]) => {
        if (operator === 'eq') return String(row[column] ?? '') === String(value ?? '');
        if (operator === 'neq') return String(row[column] ?? '') !== String(value ?? '');
        if (operator === 'is') return row[column] === value;
        if (operator === 'in') return value.map(String).includes(String(row[column]));
        if (operator === 'ilike') {
          const escaped = String(value).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
          return new RegExp(`^${escaped}$`, 'i').test(String(row[column] ?? ''));
        }
        return true;
      }));
    }

    result() {
      if (this.operation === 'insert') {
        const values = Array.isArray(this.payload) ? this.payload : [this.payload];
        this.inserted = values.map(value => ({ ...value }));
        if (['member', 'organization', 'custom_object_relationship'].includes(this.table)) {
          this.inserted = this.inserted.map((value, index) => ({
            id: `${this.table}-created-${index + 1}`,
            ...value,
          }));
        }
        rows[this.table] = [...(rows[this.table] || []), ...this.inserted];
        inserts.push(...this.inserted.map(payload => ({ table: this.table, payload })));
        return { data: this.inserted, error: null };
      }
      if (this.operation === 'update') {
        if (this.table === 'form_submission'
          && this.payload
          && Object.hasOwn(this.payload, 'entity_processing_completed_at')
          && resumeUpdateError) {
          return { data: null, error: resumeUpdateError };
        }
        const matching = this.matching();
        for (const row of matching) Object.assign(row, this.payload);
        updates.push({ table: this.table, payload: this.payload });
        return { data: matching, error: null };
      }
      if (this.operation === 'delete') {
        const matching = new Set(this.matching());
        rows[this.table] = (rows[this.table] || []).filter(row => !matching.has(row));
        return { data: [], error: null };
      }
      return { data: this.matching(), error: null };
    }

    async maybeSingle() {
      const result = this.result();
      return { data: result.data?.[0] || null, error: result.error };
    }

    async single() {
      const result = this.result();
      return { data: result.data?.[0] || null, error: result.error };
    }

    then(resolve, reject) {
      return Promise.resolve(this.result()).then(resolve, reject);
    }
  }

  return {
    inserts,
    updates,
    rows,
    client: {
      from(table) { return new Query(table); },
      async rpc(name, args) {
        if (name === 'claim_form_stripe_address_mapping_processing') return { data: true, error: null };
        if (name === 'release_form_stripe_address_mapping_processing') return { data: null, error: null };
        if (name === 'claim_form_structured_action') {
          const key = `${args.p_action_id}:${args.p_row_identity}`;
          const prior = ledger.get(key);
          if (prior?.status === 'completed') {
            return { data: { status: 'completed', claimed: false, record_id: prior.record_id }, error: null };
          }
          ledger.set(key, { status: 'processing', record_id: null });
          return { data: { claimed: true, claim_token: key }, error: null };
        }
        if (name === 'finalize_form_structured_action') {
          const key = `${args.p_action_id}:${args.p_row_identity}`;
          ledger.set(key, {
            status: args.p_status,
            record_id: args.p_record_id || null,
          });
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
    },
  };
}

async function invokeOrderingProcessor(payload, {
  persistedCreatedMemberId = null,
  entityProcessingCompletedAt = null,
  paymentMeta = {},
  existingMember = {
    id: MEMBER_ID,
    tenant_id: TENANT_ID,
    email: 'ordering@example.test',
    organization_id: null,
    organization_group_id: null,
    role_id: null,
  },
  roleRows = [],
  resumeUpdateError = null,
} = {}) {
  const form = {
    id: 'form-structured-ordering',
    tenant_id: TENANT_ID,
    pages: [],
    visibility_rules: [],
    field_mappings: [],
    application_level: 'member',
    create_entity_type: 'member',
    entity_action: 'none',
    member_entity_action: 'upsert',
    organization_entity_action: 'none',
    additional_member_creations: [],
    default_member_role_id: null,
    ...payload,
  };
  const submission = {
    id: 'submission-structured-ordering',
    form_id: form.id,
    tenant_id: TENANT_ID,
    submission_data: payload.form_values,
    submitted_by_email: 'ordering@example.test',
    organization_id: null,
    created_member_id: persistedCreatedMemberId,
    created_organization_id: null,
    entity_processing_completed_at: entityProcessingCompletedAt,
    payment_reference: 'pi-ordering-test',
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_meta: {
      verified_submitter_member_id: null,
      verified_admin_access: true,
      ...paymentMeta,
    },
    processing_notes: [],
  };
  const ledger = invokeOrderingProcessor.ledger || new Map();
  invokeOrderingProcessor.ledger = ledger;
  const db = makeOrderingDb({
    form,
    submission,
    existingMember,
    existingOrganization: {
      id: ORGANIZATION_ID,
      tenant_id: TENANT_ID,
      name: 'Ordering Organisation',
    },
    relationshipDefinitions: [{
      id: 'member-organization',
      tenant_id: TENANT_ID,
      status: 'active',
      source_kind: 'member',
      source_custom_object_id: null,
      target_kind: 'organization',
      target_custom_object_id: null,
    }],
    roleRows,
    resumeUpdateError,
    ledger,
  });
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'structured-ordering-test-secret';
  const req = {
    method: 'POST',
    headers: buildFormProcessingHeaders({
      tenantId: TENANT_ID,
      formId: form.id,
      submissionId: submission.id,
      verifiedSubmitterMemberId: null,
      verifiedAdminAccess: true,
    }),
    body: {
      form_id: form.id,
      submission_id: submission.id,
      tenant_id: TENANT_ID,
      form_values: payload.form_values,
      fields: payload.fields,
      entity_pipelines: payload.entity_pipelines,
      verified_submitter_member_id: null,
      verified_admin_access: true,
    },
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; },
  };
  try {
    await handler(req, res, { supabase: db.client });
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
  return { response, ...db };
}

test('clean primary-output waits are the only incomplete result allowed to defer', () => {
  const waiting = {
    success: false,
    completed_count: 0,
    failed_count: 0,
    outcomes: [{
      status: 'skipped',
      reason: 'primary_pipeline_output_unavailable',
      retryable: true,
    }],
  };
  assert.equal(isCleanPrimaryOutputDependencyWait(waiting), true);
  assert.equal(isCleanPrimaryOutputDependencyWait({
    ...waiting,
    outcomes: [{ ...waiting.outcomes[0], status: 'failed', error: 'genuine failure' }],
    failed_count: 1,
  }), false);
  assert.equal(isCleanPrimaryOutputDependencyWait({
    ...waiting,
    outcomes: [{ ...waiting.outcomes[0], status: 'already_completed' }],
    completed_count: 1,
  }), false);
  assert.equal(isCleanPrimaryOutputDependencyWait({
    ...waiting,
    outcomes: [{ ...waiting.outcomes[0], reason: 'already_running' }],
  }), false);
});

test('paid handler runs a primary pipeline before its primary-output relationship and retries idempotently', async () => {
  const payload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });

  const first = await invokeOrderingProcessor(payload);
  assert.equal(first.response.statusCode, 200, JSON.stringify(first.response.body));
  assert.equal(first.response.body.structured_actions?.success, true);
  assert.equal(
    first.updates.find(entry => entry.table === 'member')?.payload.email,
    'ordering@example.test',
  );
  assert.equal(
    first.inserts.some(entry => entry.table === 'custom_object_relationship'),
    true,
  );

  const retry = await invokeOrderingProcessor(payload, {
    persistedCreatedMemberId: MEMBER_ID,
    entityProcessingCompletedAt: '2026-10-01T10:00:00.000Z',
  });
  assert.equal(retry.response.statusCode, 200, JSON.stringify(retry.response.body));
  assert.equal(retry.response.body.already_processed, true);
  assert.equal(retry.response.body.structured_actions?.success, true);
  assert.equal(
    retry.inserts.some(entry => entry.table === 'member'),
    false,
  );
});

test('genuine structured failure still blocks the primary pipeline', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const payload = relationshipPayload({
    structuredActions: {
      version: 1,
      actions: [
        {
          id: 'invalid-organization-create',
          source: { scope: 'top_level' },
          operation: 'create',
          target: { kind: 'organization' },
          mappings: [{
            id: 'empty-name',
            source_type: 'static',
            static_value: '',
            target_type: 'core',
            target_field: 'name',
          }],
        },
        ...primaryOutputRelationshipAction().actions,
      ],
    },
  });
  const result = await invokeOrderingProcessor(payload);
  assert.equal(result.response.statusCode, 409, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'STRUCTURED_ACTIONS_INCOMPLETE');
  assert.equal(
    result.updates.some(entry => entry.table === 'member'),
    true,
  );
  assert.equal(
    result.inserts.some(entry => entry.table === 'member'),
    false,
  );
  assert.equal(
    result.updates.some(entry => Object.hasOwn(entry.payload, 'entity_processing_completed_at')),
    false,
  );
});

test('pre-primary mixed structured outcomes never start the primary pipeline', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const payload = relationshipPayload({
    structuredActions: {
      version: 1,
      actions: [
        {
          id: 'valid-organization-create',
          source: { scope: 'top_level' },
          operation: 'create',
          target: { kind: 'organization' },
          mappings: [{
            id: 'valid-name',
            source_type: 'static',
            static_value: 'New organization before failure',
            target_type: 'core',
            target_field: 'name',
          }],
        },
        {
          id: 'invalid-organization-create',
          source: { scope: 'top_level' },
          operation: 'create',
          target: { kind: 'organization' },
          mappings: [{
            id: 'empty-name',
            source_type: 'static',
            static_value: '',
            target_type: 'core',
            target_field: 'name',
          }],
        },
      ],
    },
  });
  const result = await invokeOrderingProcessor(payload);
  assert.equal(result.response.statusCode, 409, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'STRUCTURED_ACTIONS_INCOMPLETE');
  assert.equal(result.response.body.structured_actions.completed_count, 1);
  assert.equal(result.response.body.structured_actions.failed_count, 1);
  assert.equal(
    result.updates.some(entry => entry.table === 'member'),
    false,
  );
});

test('late structured wait persists primary IDs and a retry completes without duplicating the member', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const firstPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  firstPayload.form_values.organization = null;
  const first = await invokeOrderingProcessor(firstPayload);
  assert.equal(first.response.statusCode, 409, JSON.stringify(first.response.body));
  assert.equal(first.response.body.code, 'STRUCTURED_ACTIONS_INCOMPLETE');
  assert.equal(first.rows.form_submission[0].created_member_id, MEMBER_ID);
  assert.equal(first.rows.form_submission[0].payment_meta.structured_actions_pending, true);
  assert.equal(first.updates.some(entry => entry.table === 'member'), true);

  const retryPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  const retry = await invokeOrderingProcessor(retryPayload, {
    persistedCreatedMemberId: MEMBER_ID,
  });
  assert.equal(retry.response.statusCode, 200, JSON.stringify(retry.response.body));
  assert.equal(retry.response.body.already_processed, true);
  assert.equal(retry.response.body.structured_actions?.success, true);
  assert.equal(
    retry.updates.some(entry => entry.table === 'member'),
    false,
  );
  assert.equal(
    retry.rows.form_submission[0].payment_meta.structured_actions_pending,
    false,
  );
});

test('pay-in-full new-member role assignment waits for late actions before auto-approval', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const roleRows = [{
    id: 'role-dynamic',
    tenant_id: TENANT_ID,
    name: 'Dynamic Role',
    max_members: null,
  }];
  const firstPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  firstPayload.default_member_role_id = 'role-dynamic';
  firstPayload.form_values.organization = null;
  const first = await invokeOrderingProcessor(firstPayload, {
    existingMember: null,
    roleRows,
  });
  assert.equal(first.response.statusCode, 409, JSON.stringify(first.response.body));
  assert.equal(first.response.body.code, 'STRUCTURED_ACTIONS_INCOMPLETE');
  const createdMember = first.rows.member[0];
  assert.ok(createdMember?.id);
  assert.equal(createdMember.role_id, 'role-dynamic');
  assert.equal(first.rows.form_submission[0].payment_meta.structured_actions_pending, true);

  const retryPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  retryPayload.default_member_role_id = 'role-dynamic';
  const retry = await invokeOrderingProcessor(retryPayload, {
    persistedCreatedMemberId: createdMember.id,
    existingMember: createdMember,
    roleRows,
    paymentMeta: {
      structured_actions_pending: true,
    },
  });
  assert.equal(retry.response.statusCode, 200, JSON.stringify(retry.response.body));
  assert.equal(retry.response.body.already_processed, true);
  assert.equal(retry.response.body.structured_actions?.success, true);
  assert.equal(
    retry.inserts.some(entry => entry.table === 'member'),
    false,
  );
  assert.equal(
    retry.rows.form_submission[0].entity_processing_completed_at !== null,
    true,
  );
});

test('resolved structured resume update failure does not report completion or approve readiness', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const firstPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  firstPayload.form_values.organization = null;
  const first = await invokeOrderingProcessor(firstPayload);
  assert.equal(first.response.statusCode, 409, JSON.stringify(first.response.body));
  const retryPayload = relationshipPayload({
    structuredActions: primaryOutputRelationshipAction(),
  });
  const retry = await invokeOrderingProcessor(retryPayload, {
    persistedCreatedMemberId: MEMBER_ID,
    paymentMeta: {
      structured_actions_pending: true,
    },
    resumeUpdateError: {
      code: 'RESUME_CHECKPOINT_FAILED',
      message: 'resume checkpoint failed',
    },
  });
  assert.equal(retry.response.statusCode, 500, JSON.stringify(retry.response.body));
  assert.equal(retry.rows.form_submission[0].entity_processing_completed_at, null);
  assert.equal(
    retry.updates.some(entry => entry.table === 'member'),
    false,
  );
});
