import '../../scripts/test-support/isolation-boundary.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import handler from './process-application.js';
import { buildFormProcessingHeaders } from '../_lib/formProcessingAuth.js';

const TENANT_ID = 'tenant-monthly-processor';
const FORM_ID = 'form-monthly-processor';
const SUBMISSION_ID = 'submission-monthly-processor';

const form = {
  id: FORM_ID,
  tenant_id: TENANT_ID,
  pages: [],
  visibility_rules: [],
  fields: [],
  field_mappings: [],
  application_level: 'member',
  auto_create_entity: false,
  create_entity_type: 'member',
  entity_action: 'none',
  member_entity_action: 'none',
  organization_entity_action: 'none',
  additional_member_creations: [],
  entity_pipelines: { members: [], organisations: [] },
  structured_actions: null,
  default_member_role_id: null,
  submission_emails: [],
};

function monthlySubmission({ paymentMeta = {}, ...overrides } = {}) {
  return {
    id: SUBMISSION_ID,
    form_id: FORM_ID,
    tenant_id: TENANT_ID,
    submission_data: {},
    submitted_by_email: null,
    organization_id: null,
    created_member_id: null,
    created_organization_id: null,
    payment_reference: 'cs_monthly_setup',
    payment_provider: 'stripe_monthly_card',
    payment_status: 'setup_complete',
    payment_meta: {
      verified_submitter_member_id: null,
      verified_admin_access: true,
      monthly_card: {
        agreement_id: 'agreement-monthly-processor',
        checkout_session_id: 'cs_monthly_setup',
        setup_intent_id: 'seti_monthly_setup',
      },
      ...paymentMeta,
    },
    processing_notes: [],
    ...overrides,
  };
}

/*
 * This fixture deliberately implements only the read/write surface needed by
 * the monthly forms below. It is an in-memory Supabase-shaped client: no
 * network, Stripe, or database calls are involved. The structured-action
 * ledger is real enough to exercise the initial primary-output wait and the
 * post-primary retry without bypassing the handler's RPC boundary.
 */
function monthlyProcessorDb({
  formRow = form,
  submissionRow = monthlySubmission(),
  existingMember = null,
  existingOrganization = null,
  relationshipDefinitions = [],
  membershipHistory = [],
  ledger = new Map(),
} = {}) {
  const rows = {
    form: [formRow],
    form_submission: [submissionRow],
    member: existingMember ? [existingMember] : [],
    organization: existingOrganization ? [existingOrganization] : [],
    custom_object_relationship_definition: relationshipDefinitions,
    custom_object_relationship: [],
    form_submission_pipeline_entity: [],
    form_submission_entity_creation: [],
    preference_field: [],
    organization_group: [],
    member_preference_value: [],
    organization_preference_value: [],
    member_resource_category: [],
    member_membership_history: membershipHistory,
    role: [],
  };
  const submission = rows.form_submission[0];
  const operations = [];
  const inserts = [];
  const updates = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = null;
      this.payload = null;
    }

    select() { return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    neq(column, value) { this.filters.push(['neq', column, value]); return this; }
    ilike(column, value) { this.filters.push(['ilike', column, value]); return this; }
    in(column, value) { this.filters.push(['in', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    filter(column, operator, value) {
      this.filters.push([operator, column, value]);
      return this;
    }
    or() { return this; }
    order() { return this; }
    limit() { return this; }

    update(payload) {
      this.operation = 'update';
      this.payload = payload;
      return this;
    }

    insert(payload) {
      this.operation = 'insert';
      this.payload = payload;
      return this;
    }

    upsert(payload) {
      this.operation = 'upsert';
      this.payload = payload;
      return this;
    }

    delete() {
      this.operation = 'delete';
      return this;
    }

    matching() {
      return (rows[this.table] || []).filter(row => this.filters.every(([operator, column, value]) => {
        if (operator === 'eq') return String(row[column] ?? '') === String(value ?? '');
        if (operator === 'neq') return String(row[column] ?? '') !== String(value ?? '');
        if (operator === 'is') return row[column] === value;
        if (operator === 'in') return value.map(String).includes(String(row[column]));
        if (operator === 'ilike') {
          const escaped = String(value)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/%/g, '.*');
          return new RegExp(`^${escaped}$`, 'i').test(String(row[column] ?? ''));
        }
        return true;
      }));
    }

    result() {
      operations.push({
        table: this.table,
        operation: this.operation,
        payload: this.payload,
      });

      if (this.operation === 'insert' || this.operation === 'upsert') {
        const values = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted = values.map((value, index) => ({
          ...(this.table === 'custom_object_relationship'
            ? { id: `relationship-${index + 1}` }
            : {}),
          ...value,
        }));
        rows[this.table] = [...(rows[this.table] || []), ...inserted];
        inserts.push(...inserted.map(payload => ({ table: this.table, payload })));
        return { data: inserted, error: null };
      }

      if (this.operation === 'update') {
        const matching = this.matching();
        for (const row of matching) Object.assign(row, this.payload);
        updates.push(...matching.map(row => ({ table: this.table, payload: this.payload, row })));
        return { data: matching, error: null };
      }

      if (this.operation === 'delete') {
        const matching = new Set(this.matching());
        rows[this.table] = (rows[this.table] || []).filter(row => !matching.has(row));
        return { data: [], error: null };
      }

      return { data: this.matching(), error: null };
    }

    maybeSingle() {
      const result = this.result();
      return Promise.resolve({ data: result.data?.[0] || null, error: result.error });
    }

    single() {
      const result = this.result();
      return Promise.resolve({ data: result.data?.[0] || null, error: result.error });
    }

    then(resolve, reject) {
      return Promise.resolve(this.result()).then(resolve, reject);
    }
  }

  return {
    submission,
    rows,
    operations,
    inserts,
    updates,
    from(table) {
      return new Query(table);
    },
    async rpc(name, args) {
      operations.push({ operation: 'rpc', name, args });
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
      if (name === 'claim_form_stripe_address_mapping_processing') return { data: true, error: null };
      if (name === 'release_form_stripe_address_mapping_processing') return { data: null, error: null };
      throw new Error(`unexpected RPC in monthly processor test: ${name}`);
    },
  };
}

async function invokeMonthlyProcessor(db, formRow = form) {
  const previousSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.SESSION_SECRET = 'monthly-processor-regression-secret';
  globalThis.fetch = async () => {
    throw new Error('monthly setup processing must not make an external call in this fixture');
  };

  const req = {
    method: 'POST',
    headers: buildFormProcessingHeaders({
      tenantId: TENANT_ID,
      formId: formRow.id,
      submissionId: db.submission.id,
      verifiedSubmitterMemberId: null,
      verifiedAdminAccess: true,
    }),
    body: {
      form_id: formRow.id,
      submission_id: db.submission.id,
      tenant_id: TENANT_ID,
      form_values: db.submission.submission_data,
      fields: formRow.fields,
      entity_pipelines: formRow.entity_pipelines,
      verified_submitter_member_id: null,
      verified_admin_access: true,
    },
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return body;
    },
  };

  try {
    await handler(req, res, {
      supabase: db,
      triggerWorkflows: async () => {},
      notifyGuestSignup: async () => {},
      autoApproveMemberFees: async () => {},
      autoApproveOrgFees: async () => {},
    });
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    globalThis.fetch = previousFetch;
  }
  return response;
}

test('trusted monthly-card setup completion runs the shared processor and preserves its binding', async () => {
  const db = monthlyProcessorDb();
  const binding = structuredClone(db.submission.payment_meta.monthly_card);
  const response = await invokeMonthlyProcessor(db);

  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(response.body.success, true);
  assert.equal(db.submission.payment_status, 'setup_complete');
  assert.deepEqual(db.submission.payment_meta.monthly_card, binding);
  assert.equal(db.submission.payment_meta.monthly_card.agreement_id, 'agreement-monthly-processor');
  assert.equal(db.submission.payment_paid_at, undefined);
  assert.ok(
    db.operations.some(operation =>
      operation.table === 'form_submission'
      && operation.operation === 'update'
      && operation.payload?.entity_processing_completed_at,
    ),
    'the shared processor should complete its normal idempotency checkpoint',
  );
});

test('monthly setup waits for a primary member output before linking structured records, then retries idempotently', async () => {
  const organizationId = 'organization-monthly-structured';
  const memberId = 'member-monthly-structured';
  const structuredForm = {
    ...form,
    fields: [
      { id: 'email', type: 'email' },
      { id: 'organization', type: 'organisation_dropdown' },
    ],
    member_entity_action: 'upsert',
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
    structured_actions: {
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
    },
  };
  const monthlyState = {
    status: 'processing',
    owner_token: 'monthly-setup-owner',
    claimed_at: '2026-10-01T10:00:00.000Z',
  };
  const binding = {
    agreement_id: 'agreement-monthly-structured',
    checkout_session_id: 'cs_monthly_structured',
    setup_intent_id: 'seti_monthly_structured',
  };
  const db = monthlyProcessorDb({
    formRow: structuredForm,
    submissionRow: monthlySubmission({
      submission_data: {
        email: 'monthly-structured@example.test',
        organization: organizationId,
      },
      submitted_by_email: 'monthly-structured@example.test',
      paymentMeta: {
        monthly_card: binding,
        monthly_card_state: monthlyState,
      },
    }),
    existingMember: {
      id: memberId,
      tenant_id: TENANT_ID,
      email: 'monthly-structured@example.test',
      organization_id: null,
      organization_group_id: null,
      role_id: null,
    },
    existingOrganization: {
      id: organizationId,
      tenant_id: TENANT_ID,
      name: 'Monthly Structured Organisation',
    },
    membershipHistory: [{
      id: 'history-monthly-structured',
      member_id: memberId,
      billing_period: 'monthly_card',
      status: 'pending_activation',
      payment_status: 'unpaid',
    }],
    relationshipDefinitions: [{
      id: 'member-organization',
      tenant_id: TENANT_ID,
      status: 'active',
      source_kind: 'member',
      source_custom_object_id: null,
      target_kind: 'organization',
      target_custom_object_id: null,
    }],
  });
  const initialPaymentMeta = structuredClone(db.submission.payment_meta);

  const first = await invokeMonthlyProcessor(db, structuredForm);
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(first.body.success, true);
  assert.equal(first.body.structured_actions?.success, true);
  assert.equal(db.submission.payment_status, 'setup_complete');
  assert.deepEqual(db.submission.payment_meta.monthly_card, initialPaymentMeta.monthly_card);
  assert.deepEqual(db.submission.payment_meta.monthly_card_state, initialPaymentMeta.monthly_card_state);
  assert.equal(db.submission.payment_meta.structured_actions_pending, false);
  assert.equal(db.submission.payment_paid_at, undefined);
  assert.equal(db.submission.paid_at, undefined);
  assert.equal(db.rows.member_membership_history.length, 1);
  assert.equal(db.rows.member_membership_history[0].status, 'pending_activation');
  assert.equal(db.rows.member_membership_history[0].payment_status, 'unpaid');
  assert.equal(
    db.updates.some(update => update.table === 'member_membership_history'),
    false,
  );
  assert.equal(
    db.operations.some(operation =>
      operation.operation === 'rpc'
      && /due_diligence|membership|activation/i.test(operation.name),
    ),
    false,
    'setup processing must not activate a membership or mark DD ready',
  );

  const memberUpdateAt = db.operations.findIndex(operation =>
    operation.table === 'member' && operation.operation === 'update');
  const structuredClaimAt = db.operations.findIndex(operation =>
    operation.operation === 'rpc' && operation.name === 'claim_form_structured_action');
  const relationshipInsertAt = db.operations.findIndex(operation =>
    operation.table === 'custom_object_relationship' && operation.operation === 'insert');
  assert.ok(memberUpdateAt > -1, 'the primary member pipeline should produce a member output');
  assert.ok(structuredClaimAt > memberUpdateAt, 'structured action must wait for the primary output');
  assert.ok(relationshipInsertAt > structuredClaimAt, 'structured relationship should run after its claim');

  const firstCompletionStamp = db.submission.entity_processing_completed_at;
  assert.ok(firstCompletionStamp, 'the first setup processing run should stamp completion');
  const second = await invokeMonthlyProcessor(db, structuredForm);
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal(second.body.already_processed, true);
  assert.deepEqual(db.submission.payment_meta.monthly_card, initialPaymentMeta.monthly_card);
  assert.deepEqual(db.submission.payment_meta.monthly_card_state, initialPaymentMeta.monthly_card_state);
  assert.equal(db.submission.payment_status, 'setup_complete');
  assert.equal(db.submission.entity_processing_completed_at, firstCompletionStamp);
  assert.equal(db.rows.member_membership_history[0].status, 'pending_activation');
  assert.equal(db.rows.member_membership_history[0].payment_status, 'unpaid');
  assert.equal(
    db.inserts.filter(insert => insert.table === 'custom_object_relationship').length,
    1,
    'a completion retry must not duplicate the structured relationship',
  );
});