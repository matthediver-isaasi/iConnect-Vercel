import '../../scripts/test-support/isolation-boundary.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './process-application.js';
import { finalizeFormSubmission } from '../_lib/formPaymentFinalize.js';
import { finalizeFormMonthlyDirectDebit } from '../_lib/formMonthlyDirectDebitFinalize.js';
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

function optionalOrganizationGroupAction() {
  return {
    version: 1,
    actions: [{
      id: 'optional-organization-group',
      source: { scope: 'top_level' },
      operation: 'upsert',
      target: { kind: 'organization_group' },
      uniqueness_field: 'name',
      mappings: [{
        id: 'optional-organization-group-name',
        source_type: 'field',
        source_field_id: 'optional-group-name',
        target_type: 'core',
        target_field_id: 'name',
      }],
    }],
  };
}

function makeOrderingDb({
  form,
  submission,
  existingMember,
  existingOrganization,
  relationshipDefinitions,
  organizationGroups = [],
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
    member_preference_value: [],
    organization_preference_value: [],
    member_resource_category: [],
    role: roleRows,
    organization_group: organizationGroups,
  };
  const inserts = [];
  const updates = [];
  const rpcCalls = [];

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
        if (operator === 'eq') {
          if (column === 'payment_meta' && row[column]
            && typeof row[column] === 'object' && typeof value === 'string') {
            return JSON.stringify(row[column]) === value;
          }
          return String(row[column] ?? '') === String(value ?? '');
        }
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
        if (['member', 'organization', 'organization_group', 'custom_object_relationship'].includes(this.table)) {
          this.inserted = this.inserted.map((value, index) => ({
            id: `${this.table}-created-${index + 1}`,
            ...(this.table === 'member' ? { organization_group_id: null } : {}),
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
    rpcCalls,
    rows,
    client: {
      from(table) { return new Query(table); },
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        if (name === 'begin_form_paid_pipeline_operation') return { data: { status: 'claimed' }, error: null };
        if (name === 'finish_form_paid_pipeline_operation') return { data: true, error: null };
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
  paymentProvider = 'stripe',
  paymentStatus = 'paid',
  existingMember = {
    id: MEMBER_ID,
    tenant_id: TENANT_ID,
    email: 'ordering@example.test',
    organization_id: null,
    organization_group_id: null,
    role_id: null,
  },
  roleRows = [],
  organizationGroups = [],
  resumeUpdateError = null,
  completionOperationId = null,
  completionOperationKind = 'primary',
  invokeHandler = true,
  triggerWorkflows = async () => {},
  notifyGuestSignup = async () => {},
  autoApproveMemberFees = async () => {},
  autoApproveOrgFees = async () => {},
  verifiedAdminAccess = true,
  signed = true,
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
    payment_provider: paymentProvider,
    payment_status: paymentStatus,
    payment_meta: {
      verified_submitter_member_id: null,
      verified_admin_access: verifiedAdminAccess,
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
    organizationGroups,
    roleRows,
    resumeUpdateError,
    ledger,
  });
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'structured-ordering-test-secret';
  const req = {
    method: 'POST',
    headers: signed ? buildFormProcessingHeaders({
      tenantId: TENANT_ID,
      formId: form.id,
      submissionId: submission.id,
      verifiedSubmitterMemberId: null,
      verifiedAdminAccess,
    }) : {},
    body: {
      form_id: form.id,
      submission_id: submission.id,
      tenant_id: TENANT_ID,
      form_values: payload.form_values,
      fields: payload.fields,
      entity_pipelines: payload.entity_pipelines,
      verified_submitter_member_id: null,
      verified_admin_access: verifiedAdminAccess,
      allowPersistedRelationshipLinks: true,
      ...(completionOperationId ? {
        completion_operation_id: completionOperationId,
        completion_operation_kind: completionOperationKind,
      } : {}),
    },
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return body; },
  };
  if (invokeHandler) {
    try {
      await handler(req, res, {
        supabase: db.client,
        triggerWorkflows,
        notifyGuestSignup,
        autoApproveMemberFees,
        autoApproveOrgFees,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
    }
  } else if (previousSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = previousSecret;
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

test('paid anonymous signed processing links configured references without admin authority; unsigned flags cannot', async () => {
  const payload = relationshipPayload({ structuredActions: primaryOutputRelationshipAction() });
  invokeOrderingProcessor.ledger = new Map();
  const signed = await invokeOrderingProcessor(payload, { verifiedAdminAccess: false, existingMember: null });
  assert.equal(signed.response.statusCode, 200, JSON.stringify(signed.response.body));
  assert.equal(signed.response.body.structured_actions?.success, true);
  assert.equal(signed.inserts.some(entry => entry.table === 'custom_object_relationship'), true);
  invokeOrderingProcessor.ledger = new Map();
  const unsigned = await invokeOrderingProcessor(payload, { verifiedAdminAccess: false, signed: false });
  assert.ok(unsigned.response.statusCode >= 400, JSON.stringify(unsigned.response.body));
  assert.equal(unsigned.inserts.some(entry => entry.table === 'custom_object_relationship'), false);
});

test('paid finalizer keeps one-off DD readiness for optional group blanks and creates configured groups', async () => {
  const originalFetch = global.fetch;
  const originalAppUrl = process.env.APP_URL;
  const originalSecret = process.env.SESSION_SECRET;
  const finalizeThroughSharedProcessor = async (groupName, {
    paymentProvider = 'stripe',
    paymentStatus = 'paid',
    existingMember = {
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'ordering@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    },
    organizationGroups = [],
    monthly = false,
    runPaidOneOffRetry = false,
  } = {}) => {
    const payload = relationshipPayload({
      structuredActions: optionalOrganizationGroupAction(),
    });
    payload.fields = [
      ...payload.fields,
      { id: 'optional-group-name', type: 'text', required: false },
    ];
    payload.form_values = {
      ...payload.form_values,
      'optional-group-name': groupName,
    };
    const context = await invokeOrderingProcessor(payload, {
      invokeHandler: false,
      existingMember,
      organizationGroups,
      paymentProvider,
      paymentStatus,
    });
    const rpcNames = [];
    const originalRpc = context.client.rpc.bind(context.client);
    context.client.rpc = async (name, args) => {
      rpcNames.push(name);
      if (name === 'mark_one_off_form_due_diligence_ready') return { data: true, error: null };
      if (name === 'claim_form_due_diligence_initialization') {
        return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      }
      if (name === 'bind_form_monthly_direct_debit_membership') {
        return { data: { ok: true, history_id: 'monthly-history' }, error: null };
      }
      return originalRpc(name, args);
    };
    process.env.APP_URL = 'https://structured-ordering.test';
    process.env.SESSION_SECRET = 'structured-ordering-test-secret';
    global.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/forms/process-application')) {
        return {
          ok: false,
          status: 404,
          async json() { return {}; },
          async text() { return ''; },
        };
      }
      const request = {
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body),
      };
      const response = { statusCode: 200, body: null };
      await handler(request, {
        status(code) { response.statusCode = code; return this; },
        json(body) { response.body = body; return body; },
      }, {
        supabase: context.client,
        triggerWorkflows: async () => {},
        notifyGuestSignup: async () => {},
        autoApproveMemberFees: async () => {},
        autoApproveOrgFees: async () => {},
      });
      const serialized = JSON.stringify(response.body);
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        async json() { return JSON.parse(serialized); },
        async text() { return serialized; },
      };
    };
    try {
      const result = monthly
        ? await finalizeFormMonthlyDirectDebit({
          db: context.client,
          agreement: {
            id: 'ordering-monthly-agreement',
            tenant_id: TENANT_ID,
            provider: 'gocardless',
            agreement_type: 'member',
            metadata: {
              form_submission_id: context.rows.form_submission[0].id,
              dd: { kind: 'monthly_direct_debit', membership_year: '2026/27' },
            },
          },
          baseUrl: '',
        })
        : await finalizeFormSubmission({
          supabase: context.client,
          submission: context.rows.form_submission[0],
          form: context.rows.form[0],
          baseUrl: '',
        });
      let paidOneOffResult = null;
      let paidOneOffRetry = null;
      if (runPaidOneOffRetry) {
        const paidSubmission = context.rows.form_submission[0];
        paidSubmission.payment_status = 'paid';
        paidSubmission.payment_provider = 'stripe';
        paidOneOffResult = await finalizeFormSubmission({
          supabase: context.client,
          submission: paidSubmission,
          form: context.rows.form[0],
          baseUrl: '',
        });
        paidOneOffRetry = await finalizeFormSubmission({
          supabase: context.client,
          submission: context.rows.form_submission[0],
          form: context.rows.form[0],
          baseUrl: '',
        });
      }
      return {
        ...context,
        result,
        paidOneOffResult,
        paidOneOffRetry,
        rpcNames,
      };
    } finally {
      global.fetch = originalFetch;
      if (originalAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originalAppUrl;
      if (originalSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSecret;
    }
  };

  try {
    const blank = await finalizeThroughSharedProcessor('');
    assert.equal(blank.result.finalized, true);
    assert.equal(blank.result.retriedUnreadyFinalization, undefined);
    assert.equal(blank.rows.organization_group.length, 0);
    assert.equal(blank.rows.form_submission[0].entity_processing_completed_at !== null, true);
    assert.equal(blank.rows.form_submission[0].payment_meta.structured_actions_pending, false);
    assert.deepEqual(
      blank.rpcNames.filter(name => [
        'mark_one_off_form_due_diligence_ready',
        'claim_form_due_diligence_initialization',
      ].includes(name)),
      [
        'mark_one_off_form_due_diligence_ready',
        'claim_form_due_diligence_initialization',
      ],
    );

    const configured = await finalizeThroughSharedProcessor('Configured group');
    assert.equal(configured.result.finalized, true);
    assert.deepEqual(
      configured.rows.organization_group.map(row => row.name),
      ['Configured group'],
    );
    assert.equal(configured.rows.form_submission[0].payment_meta.structured_actions_pending, false);
  } finally {
    global.fetch = originalFetch;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('GroupUPSERT assigns existing groups once and leaves organisation-backed members unchanged', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const originalFetch = global.fetch;
  const originalAppUrl = process.env.APP_URL;
  const originalSecret = process.env.SESSION_SECRET;
  const existingGroup = {
    id: 'existing-organization-group',
    tenant_id: TENANT_ID,
    name: 'Existing configured group',
  };
  const run = async (existingMember, {
    groups = [existingGroup],
  } = {}) => {
    const payload = relationshipPayload({
      structuredActions: optionalOrganizationGroupAction(),
    });
    payload.fields = [
      ...payload.fields,
      { id: 'optional-group-name', type: 'text', required: false },
    ];
    payload.form_values = {
      ...payload.form_values,
      'optional-group-name': existingGroup.name,
    };
    const context = await invokeOrderingProcessor(payload, {
      invokeHandler: false,
      existingMember,
      organizationGroups: groups.map(group => ({ ...group })),
    });
    process.env.APP_URL = 'https://structured-ordering.test';
    process.env.SESSION_SECRET = 'structured-ordering-test-secret';
    const request = {
      method: 'POST',
      headers: buildFormProcessingHeaders({
        tenantId: TENANT_ID,
        formId: context.rows.form[0].id,
        submissionId: context.rows.form_submission[0].id,
        verifiedSubmitterMemberId: null,
        verifiedAdminAccess: true,
      }),
      body: {
        form_id: context.rows.form[0].id,
        submission_id: context.rows.form_submission[0].id,
        tenant_id: TENANT_ID,
        form_values: payload.form_values,
        fields: payload.fields,
        entity_pipelines: payload.entity_pipelines,
        verified_submitter_member_id: null,
        verified_admin_access: true,
      },
    };
    const response = { statusCode: 200, body: null };
    await handler(request, {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
    }, {
      supabase: context.client,
      triggerWorkflows: async () => {},
      notifyGuestSignup: async () => {},
      autoApproveMemberFees: async () => {},
      autoApproveOrgFees: async () => {},
    });
    return { ...context, response };
  };

  try {
    const first = await run({
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'ordering@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    });
    assert.equal(first.response.statusCode, 200, JSON.stringify(first.response.body));
    assert.equal(first.rows.organization_group.length, 1);
    assert.equal(first.rows.organization_group[0].id, existingGroup.id);
    assert.equal(first.rows.member[0].organization_group_id, existingGroup.id);

    // A successful group ledger entry can outlive the member write (for
    // example, a crash between those two writes). The retry must reconcile
    // the member without replaying the group upsert.
    invokeOrderingProcessor.ledger = new Map([[
      'optional-organization-group:top',
      { status: 'completed', record_id: existingGroup.id },
    ]]);
    const cached = await run({
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'ordering@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    });
    assert.equal(cached.response.statusCode, 200, JSON.stringify(cached.response.body));
    assert.equal(cached.inserts.some(entry => entry.table === 'organization_group'), false);
    assert.equal(cached.rows.member[0].organization_group_id, existingGroup.id);

    // A cached success from another tenant must not become a direct member
    // link. The tenant-scoped group lookup turns this into a retryable
    // structured-action failure instead.
    const crossTenantGroup = {
      ...existingGroup,
      id: 'cross-tenant-organization-group',
      tenant_id: 'tenant-other',
    };
    invokeOrderingProcessor.ledger = new Map([[
      'optional-organization-group:top',
      { status: 'completed', record_id: crossTenantGroup.id },
    ]]);
    const conflicting = await run({
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'ordering@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    }, { groups: [crossTenantGroup] });
    assert.equal(conflicting.response.statusCode, 400);
    assert.equal(conflicting.response.body.code, 'INVALID_STRUCTURED_ACTIONS');
    assert.equal(conflicting.rows.member[0].organization_group_id, null);

    invokeOrderingProcessor.ledger = new Map();
    const populated = await run({
      id: MEMBER_ID,
      tenant_id: TENANT_ID,
      email: 'ordering@example.test',
      organization_id: ORGANIZATION_ID,
      organization_group_id: null,
      role_id: null,
    });
    assert.equal(populated.response.statusCode, 200, JSON.stringify(populated.response.body));
    assert.equal(populated.rows.organization_group.length, 1);
    assert.equal(populated.rows.member[0].organization_id, ORGANIZATION_ID);
    assert.equal(populated.rows.member[0].organization_group_id, null);
  } finally {
    global.fetch = originalFetch;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('monthly setup waits for optional organisation settlement, creates the member/group, and one-off paid retry stays idempotent', async () => {
  invokeOrderingProcessor.ledger = new Map();
  const payload = relationshipPayload({
    structuredActions: optionalOrganizationGroupAction(),
  });
  payload.fields = [
    ...payload.fields,
    { id: 'optional-org-name', type: 'text', required: false },
    { id: 'optional-group-name', type: 'text', required: false },
  ];
  payload.form_values = {
    ...payload.form_values,
    organization: null,
    'optional-org-name': '',
    'optional-group-name': 'Configured group',
  };
  payload.organization_entity_action = 'upsert';
  payload.entity_pipelines = {
    members: payload.entity_pipelines.members,
    organisations: [{
      id: 'primary-organization',
      isPrimary: true,
      mappings: [{
        id: 'optional-org-name-map',
        source_type: 'field',
        source_field_id: 'optional-org-name',
        target_type: 'core',
        target_entity: 'organization',
        target_field: 'name',
      }],
    }],
  };

  const originalFetch = global.fetch;
  const originalAppUrl = process.env.APP_URL;
  const originalSecret = process.env.SESSION_SECRET;
  const context = await invokeOrderingProcessor(payload, {
    invokeHandler: false,
    existingMember: null,
    paymentProvider: 'gocardless_monthly_dd',
    paymentStatus: 'setup_complete',
  });
  const rpcNames = [];
  const originalRpc = context.client.rpc.bind(context.client);
  context.client.rpc = async (name, args) => {
    rpcNames.push(name);
    if (name === 'bind_form_monthly_direct_debit_membership') {
      return { data: { ok: true, history_id: 'monthly-history' }, error: null };
    }
    if (name === 'claim_form_due_diligence_initialization') {
      return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
    }
    if (name === 'mark_one_off_form_due_diligence_ready') return { data: true, error: null };
    return originalRpc(name, args);
  };
  process.env.APP_URL = 'https://structured-ordering.test';
  process.env.SESSION_SECRET = 'structured-ordering-test-secret';
  global.fetch = async (url, options) => {
    if (!String(url).endsWith('/api/forms/process-application')) {
      return {
        ok: false,
        status: 404,
        async json() { return {}; },
        async text() { return ''; },
      };
    }
    const request = {
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    const response = { statusCode: 200, body: null };
    await handler(request, {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
    }, {
      supabase: context.client,
      triggerWorkflows: async () => {},
      notifyGuestSignup: async () => {},
      autoApproveMemberFees: async () => {},
      autoApproveOrgFees: async () => {},
    });
    const serialized = JSON.stringify(response.body);
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      async json() { return JSON.parse(serialized); },
      async text() { return serialized; },
    };
  };

  try {
    const monthly = await finalizeFormMonthlyDirectDebit({
      db: context.client,
      agreement: {
        id: 'ordering-monthly-agreement',
        tenant_id: TENANT_ID,
        provider: 'gocardless',
        agreement_type: 'member',
        metadata: {
          form_submission_id: context.rows.form_submission[0].id,
          dd: { kind: 'monthly_direct_debit', membership_year: '2026/27' },
        },
      },
      baseUrl: '',
    });
    assert.equal(monthly.handled, true, JSON.stringify(monthly));
    assert.equal(context.rows.form_submission[0].payment_status, 'setup_complete');
    assert.equal(context.rows.form_submission[0].payment_meta.monthly_dd_state.status, 'done');
    assert.deepEqual(
      context.rows.form_submission[0].payment_meta.structured_actions_result.completed_primary_kinds,
      ['organization'],
    );
    assert.equal(rpcNames.includes('mark_one_off_form_due_diligence_ready'), false);
    assert.equal(context.rows.member.length, 1);
    assert.equal(
      context.rows.member[0].organization_group_id,
      context.rows.organization_group[0].id,
      'a populated GroupUPSERT assigns the no-Organisation primary member',
    );
    assert.equal(context.rows.organization_group.length, 1);
    assert.equal(context.rows.organization.length, 1);
    assert.equal(context.inserts.some(entry => entry.table === 'organization'), false);

    context.rows.form_submission[0].payment_status = 'paid';
    context.rows.form_submission[0].payment_provider = 'stripe';
    const paid = await finalizeFormSubmission({
      supabase: context.client,
      submission: context.rows.form_submission[0],
      form: context.rows.form[0],
      baseUrl: '',
    });
    assert.equal(paid.finalized, true);
    assert.equal(rpcNames.includes('mark_one_off_form_due_diligence_ready'), true);
    assert.equal(context.rows.member.length, 1);
    assert.equal(context.rows.member[0].organization_group_id, context.rows.organization_group[0].id);
    assert.equal(context.rows.organization_group.length, 1);

    const retry = await finalizeFormSubmission({
      supabase: context.client,
      submission: context.rows.form_submission[0],
      form: context.rows.form[0],
      baseUrl: '',
    });
    assert.equal(retry.alreadyFinalized, true);
    assert.equal(context.rows.member.length, 1);
    assert.equal(context.rows.member[0].organization_group_id, context.rows.organization_group[0].id);
    assert.equal(context.rows.organization_group.length, 1);
    assert.equal(context.rows.organization.length, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
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
  const result = await invokeOrderingProcessor(payload, {
    completionOperationId: '00000000-0000-4000-8000-000000000091',
  });
  assert.equal(result.response.statusCode, 409, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'STRUCTURED_ACTIONS_INCOMPLETE');
  assert.equal(result.response.body.retryable, true);
  assert.equal(result.rows.form_submission[0].payment_meta.structured_actions_pending, true);
  assert.equal(result.rows.form_submission[0].payment_meta.structured_actions_result.success, false);
  assert.deepEqual(
    result.rpcCalls
      .filter(call => call.name.endsWith('form_paid_pipeline_operation'))
      .map(call => call.name),
    ['begin_form_paid_pipeline_operation', 'finish_form_paid_pipeline_operation'],
  );
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
