import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../_lib/database.js';
import {
  executeContractSendingActions,
  executeMeetingRequestActions,
  executeMemberCreationActions,
} from './_stageActions.js';

const tenantId = 'tenant';
const submission = { id: 'dd-submission', form_submission_id: 'form-submission' };

function createStatefulSupabase(state) {
  let nextMeetingId = 1;

  const resultFor = (table, query) => {
    const id = query.filters.find((filter) => filter.column === 'id')?.value;

    if (query.operation === 'insert') {
      if (table === 'dd_meeting_request') {
        const row = { ...query.payload, id: `meeting-${nextMeetingId++}` };
        state.meetingRequests.push(row);
        return { data: row, error: null };
      }
      if (table === 'member') {
        state.member = { ...query.payload, id: 'created-member' };
        return { data: state.member, error: null };
      }
    }

    if (query.operation === 'update') {
      if (table === 'contract_instance') {
        Object.assign(state.contractInstance, query.payload);
      }
      if (table === 'dd_meeting_request') {
        const row = state.meetingRequests.find((request) => request.id === id);
        if (row) Object.assign(row, query.payload);
      }
      return { data: null, error: null };
    }

    if (table === 'form_submission') {
      return { data: state.formSubmission, error: null };
    }
    if (table === 'form') {
      return {
        data: id === 'contract-form' ? state.contractForm : state.sourceForm,
        error: null,
      };
    }
    if (table === 'tenant') {
      return { data: { name: 'Test Tenant', slug: 'test-tenant' }, error: null };
    }
    if (table === 'contract_instance') {
      return { data: state.contractInstance ? [state.contractInstance] : [], error: null };
    }
    if (table === 'email_template') {
      return { data: state.emailTemplate, error: null };
    }
    if (table === 'organization') {
      return { data: { id: 'organization', name: 'Test Organization' }, error: null };
    }
    if (table === 'stage_meeting_request') {
      return { data: state.meetingActions || [], error: null };
    }
    if (table === 'agent_meeting_template') {
      return { data: [{ identity_id: 'agent-identity' }], error: null };
    }
    if (table === 'tenant_membership') {
      return { data: { identity_id: 'agent-identity', member_id: 'agent-member' }, error: null };
    }
    if (table === 'stage_member_action') {
      return { data: state.memberActions || [], error: null };
    }
    if (table === 'member') {
      if (id === 'agent-member') {
        return {
          data: {
            id: 'agent-member',
            first_name: 'Booking',
            last_name: 'Agent',
            email: 'agent@example.invalid',
            handle: 'booking-agent',
          },
          error: null,
        };
      }
      return {
        data: state.member || null,
        error: state.member ? null : { code: 'PGRST116', message: 'No rows' },
      };
    }
    if (table === 'form_submission_due_diligence') {
      return { data: null, error: null };
    }
    if (table === 'form_due_diligence_config') {
      return { data: null, error: null };
    }
    if (table === 'communication_category') {
      return { data: [], error: null };
    }

    return { data: null, error: null };
  };

  return {
    from(table) {
      const query = {
        filters: [],
        operation: 'read',
        payload: null,
        select() { return query; },
        eq(column, value) {
          query.filters.push({ column, value });
          return query;
        },
        ilike(column, value) {
          query.filters.push({ column, value });
          return query;
        },
        in(column, value) {
          query.filters.push({ column, value });
          return query;
        },
        is(column, value) {
          query.filters.push({ column, value });
          return query;
        },
        order() { return query; },
        limit() { return query; },
        insert(payload) {
          query.operation = 'insert';
          query.payload = payload;
          return query;
        },
        update(payload) {
          query.operation = 'update';
          query.payload = payload;
          return query;
        },
        single() {
          return Promise.resolve(resultFor(table, query));
        },
        then(resolve, reject) {
          return Promise.resolve(resultFor(table, query)).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

async function withStatefulSupabase(state, callback) {
  const originalFrom = supabase.from;
  supabase.from = createStatefulSupabase(state).from;
  try {
    return await callback();
  } finally {
    supabase.from = originalFrom;
  }
}

function contractState(signers = [{ email: 'signer@example.invalid', name: 'Signer' }]) {
  return {
    formSubmission: {
      form_id: 'source-form',
      submission_data: {},
      organization_id: 'organization',
    },
    sourceForm: {
      id: 'source-form',
      name: 'Source form',
      fields: [{
        id: 'contact-field',
        name: 'contact-field',
        label: 'Contract contact',
        type: 'contact',
        contract_form_id: 'contract-form',
      }],
    },
    contractForm: {
      id: 'contract-form',
      name: 'Contract',
      slug: 'contract',
      contract_settings: { initial_email_template_id: 'contract-template' },
    },
    contractInstance: {
      id: 'contract-instance',
      form_id: 'contract-form',
      source_contact_field_id: 'contact-field',
      sent_at: null,
      signers,
    },
    emailTemplate: {
      id: 'contract-template',
      name: 'Contract email',
      subject: 'Please sign',
      body: 'Please sign',
    },
    meetingRequests: [],
  };
}

test('contract resolved provider failure leaves the contract uncheckpointed and unsent until retry', async () => {
  const state = contractState();
  const completed = new Set();
  const deliveryAttempts = [];

  await withStatefulSupabase(state, async () => {
    const options = {
      completedActionKeys: completed,
      sendEmail: async () => {
        deliveryAttempts.push('attempt');
        return deliveryAttempts.length === 1
          ? { success: false, error: 'provider rejected message' }
          : { success: true, messageId: 'contract-message' };
      },
      onActionCompleted: async (key) => { completed.add(key); },
    };

    const failed = await executeContractSendingActions(
      ['contact-field'], submission, tenantId, 'system', options,
    );
    assert.equal(failed[0].status, 'failed');
    assert.equal(state.contractInstance.sent_at, null);
    assert.equal(state.contractInstance.signers[0].sent_at, undefined);
    assert.equal(completed.has('contract:contact-field'), false);

    const retried = await executeContractSendingActions(
      ['contact-field'], submission, tenantId, 'system', options,
    );
    assert.equal(retried[0].status, 'success');
    assert.ok(state.contractInstance.sent_at);
    assert.ok(state.contractInstance.signers[0].sent_at);
    assert.equal(completed.has('contract:contact-field'), true);
  });
});

test('meeting resolved provider failure leaves its tracking record unstamped and retries', async () => {
  const state = {
    formSubmission: {
      form_id: 'source-form',
      submission_data: { email: 'recipient@example.invalid', first_name: 'Recipient' },
      organization_id: 'organization',
    },
    emailTemplate: {
      id: 'meeting-template-email',
      name: 'Meeting email',
      subject: 'Book a meeting',
      body: 'Book a meeting',
    },
    meetingActions: [{
      id: 'meeting-action',
      recipient_email_field: 'email',
      first_name_field: 'first_name',
      meeting_template: {
        id: 'meeting-template',
        name: 'Consultation',
        slug: 'consultation',
        duration_minutes: 30,
        email_template_id: 'meeting-template-email',
      },
    }],
    meetingRequests: [],
  };
  const completed = new Set();
  let sends = 0;

  await withStatefulSupabase(state, async () => {
    const options = {
      completedActionKeys: completed,
      sendEmail: async () => {
        sends += 1;
        return sends === 1
          ? { success: false, error: 'provider rejected message' }
          : { success: true, messageId: 'meeting-message' };
      },
      onActionCompleted: async (key) => { completed.add(key); },
    };

    const failed = await executeMeetingRequestActions(
      'stage', submission, tenantId, 'system', options,
    );
    assert.equal(failed[0].status, 'error');
    assert.equal(state.meetingRequests.length, 1);
    assert.equal(state.meetingRequests[0].sent_at, null);
    assert.equal(completed.has('meeting:meeting-action'), false);

    const retried = await executeMeetingRequestActions(
      'stage', submission, tenantId, 'system', options,
    );
    assert.equal(retried[0].status, 'success');
    assert.equal(state.meetingRequests.length, 2);
    assert.equal(state.meetingRequests[0].sent_at, null);
    assert.ok(state.meetingRequests[1].sent_at);
    assert.equal(completed.has('meeting:meeting-action'), true);
  });
});

test('contract persists confirmed signer A before surfacing signer B ambiguous delivery', async () => {
  const state = contractState([
    { email: 'signer-a@example.invalid', name: 'Signer A' },
    { email: 'signer-b@example.invalid', name: 'Signer B' },
  ]);
  const completed = new Set();
  let sends = 0;

  await withStatefulSupabase(state, async () => {
    await assert.rejects(
      executeContractSendingActions(['contact-field'], submission, tenantId, 'system', {
        completedActionKeys: completed,
        sendEmail: async () => {
          sends += 1;
          return sends === 1
            ? { success: true, messageId: 'signer-a-message' }
            : { success: false, error: 'timed out', ambiguousEffect: true };
        },
        onActionCompleted: async (key) => { completed.add(key); },
      }),
      { ddAmbiguousEffect: true },
    );
  });

  assert.ok(state.contractInstance.signers[0].sent_at);
  assert.equal(state.contractInstance.signers[1].sent_at, undefined);
  assert.equal(state.contractInstance.sent_at, null);
  assert.equal(completed.has('contract:contact-field'), false);
});

test('member welcome retries a resolved failure only with member-creation provenance', async () => {
  const state = {
    formSubmission: {
      form_id: 'source-form',
      submission_data: { email: 'new-member@example.invalid' },
      organization_id: 'organization',
    },
    sourceForm: { id: 'source-form', fields: [] },
    emailTemplate: {
      id: 'welcome-template',
      name: 'Welcome',
      subject: 'Welcome',
      body: 'Welcome',
    },
    memberActions: [{
      id: 'member-action',
      email_field: 'email',
      role_id: 'role',
      welcome_email_template_id: 'welcome-template',
      field_mappings: { core: {}, custom: {} },
    }],
    meetingRequests: [],
    member: null,
  };
  const completed = new Set();
  let sends = 0;

  await withStatefulSupabase(state, async () => {
    const options = {
      configId: 'config',
      completedActionKeys: completed,
      sendEmail: async () => {
        sends += 1;
        return sends === 1
          ? { success: false, error: 'provider rejected message' }
          : { success: true, messageId: 'welcome-message' };
      },
      onActionCompleted: async (key) => { completed.add(key); },
    };

    const failed = await executeMemberCreationActions(
      'stage', submission, tenantId, 'system', options,
    );
    assert.equal(failed[0].status, 'partial');
    assert.equal(completed.has('member-created:member-action'), true);
    assert.equal(completed.has('member:member-action'), false);

    const retried = await executeMemberCreationActions(
      'stage', submission, tenantId, 'system', options,
    );
    assert.equal(retried[0].status, 'success');
    assert.equal(sends, 2);
    assert.equal(completed.has('member-created:member-action'), true);
    assert.equal(completed.has('member:member-action'), true);
  });
});

test('member welcome does not send for an unrelated pre-existing member', async () => {
  const state = {
    formSubmission: {
      form_id: 'source-form',
      submission_data: { email: 'existing-member@example.invalid' },
      organization_id: 'organization',
    },
    sourceForm: { id: 'source-form', fields: [] },
    emailTemplate: {
      id: 'welcome-template',
      name: 'Welcome',
      subject: 'Welcome',
      body: 'Welcome',
    },
    memberActions: [{
      id: 'member-action',
      email_field: 'email',
      role_id: 'role',
      welcome_email_template_id: 'welcome-template',
      field_mappings: { core: {}, custom: {} },
    }],
    meetingRequests: [],
    member: {
      id: 'unrelated-member',
      email: 'existing-member@example.invalid',
      first_name: 'Existing',
      last_name: 'Member',
    },
  };
  const completed = new Set();
  let sends = 0;

  await withStatefulSupabase(state, async () => {
    const result = await executeMemberCreationActions(
      'stage', submission, tenantId, 'system', {
        configId: 'config',
        completedActionKeys: completed,
        sendEmail: async () => {
          sends += 1;
          return { success: true };
        },
        onActionCompleted: async (key) => { completed.add(key); },
      },
    );

    assert.equal(result[0].status, 'success');
    assert.equal(sends, 0);
    assert.equal(completed.has('member-created:member-action'), false);
  });
});