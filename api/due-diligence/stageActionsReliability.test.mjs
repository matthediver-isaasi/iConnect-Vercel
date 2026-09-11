import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../_lib/database.js';
import {
  __testables,
  executeContractSendingActions,
  executeEmailTemplateActions,
  executeFieldMappingActions,
  executeMeetingRequestActions,
  executeMemberCreationActions,
  executeStageActions,
  executeZohoCrmActions,
} from './_stageActions.js';
import {
  getTenantZohoCrmCredentials,
  isZohoPostTransportAmbiguous,
  ZohoTimeoutError,
} from '../_lib/zohoCrmClient.js';

function failingReadClient(tableName, error = { message: 'temporary database failure' }) {
  return {
    from(table) {
      assert.equal(table, tableName);
      const query = {
        select() { return query; },
        eq() { return query; },
        in() { return query; },
        ilike() { return query; },
        is() { return query; },
        order() { return query; },
        insert() { return query; },
        upsert() { return query; },
        single() { return { data: null, error }; },
        then(resolve) { return resolve({ data: null, error }); },
      };
      return query;
    },
  };
}

function routedReadClient(responses) {
  return {
    from(table) {
      const response = responses[table] || { data: null, error: { message: `Unexpected ${table} read` } };
      const query = {
        select() { return query; },
        eq() { return query; },
        in() { return query; },
        ilike() { return query; },
        is() { return query; },
        order() { return query; },
        insert() { return query; },
        upsert() { return query; },
        single() { return response; },
        then(resolve) { return resolve(response); },
      };
      return query;
    },
  };
}

async function withFailingRead(tableName, callback) {
  const originalFrom = supabase.from;
  supabase.from = failingReadClient(tableName).from;
  try {
    return await callback();
  } finally {
    supabase.from = originalFrom;
  }
}

async function withRoutedReads(responses, callback) {
  const originalFrom = supabase.from;
  supabase.from = routedReadClient(responses).from;
  try {
    return await callback();
  } finally {
    supabase.from = originalFrom;
  }
}

const submission = { id: 'dd', form_submission_id: 'submission' };
const strictOptions = { onActionCompleted: async () => {} };

test('contract submission read failure is a normal result but strict initialization failure', async () => {
  const results = await withFailingRead('form_submission', () => (
    executeContractSendingActions(['contact-field'], submission, 'tenant', 'system')
  ));
  assert.equal(results[0].failure_kind, 'query');
  await assert.rejects(
    withFailingRead('form_submission', () => (
      executeContractSendingActions(['contact-field'], submission, 'tenant', 'system', strictOptions)
    )),
    { ddKnownQueryFailure: true },
  );
});

test('contract source-form and instance read failures are strict before delivery', async () => {
  const formSubmission = {
    data: { form_id: 'source-form', submission_data: {}, organization_id: null },
    error: null,
  };
  for (const responses of [
    {
      form_submission: formSubmission,
      form: { data: null, error: { message: 'source form read failed' } },
    },
    {
      form_submission: formSubmission,
      form: { data: { id: 'source-form', fields: [] }, error: null },
      tenant: { data: { slug: 'tenant' }, error: null },
      contract_instance: { data: null, error: { message: 'instance read failed' } },
    },
  ]) {
    await assert.rejects(
      withRoutedReads(responses, () => (
        executeContractSendingActions(['contact-field'], submission, 'tenant', 'system', strictOptions)
      )),
      { ddKnownQueryFailure: true },
    );
  }
});

test('meeting, email, and member read failures remain retryable initialization failures', async () => {
  for (const [table, execute] of [
    ['form_submission', () => executeMeetingRequestActions('new', submission, 'tenant', 'system', strictOptions)],
    ['form_submission', () => executeEmailTemplateActions('new', submission, 'tenant', 'system', strictOptions)],
    ['stage_member_action', () => executeMemberCreationActions('new', submission, 'tenant', 'system', { ...strictOptions, configId: 'config' })],
  ]) {
    await assert.rejects(withFailingRead(table, execute), { ddKnownQueryFailure: true });
  }
});

test('field mapping submission and configuration query failures are strict', async () => {
  await assert.rejects(
    withFailingRead('form_submission', () => (
      executeFieldMappingActions('new', submission, 'tenant', 'system', strictOptions)
    )),
    { ddKnownQueryFailure: true },
  );
  await assert.rejects(
    withRoutedReads({
      form_submission: {
        data: { form_id: 'form', submission_data: {}, organization_id: 'organization' },
        error: null,
      },
      stage_field_mapping_action: { data: null, error: { message: 'mapping config failed' } },
    }, () => (
      executeFieldMappingActions('new', submission, 'tenant', 'system', strictOptions)
    )),
    { ddKnownQueryFailure: true },
  );
});

test('an existing member repairs failed custom preferences before checkpointing', async () => {
  const action = {
    id: 'member-action',
    email_field: 'email',
    role_id: 'role',
    welcome_email_template_id: 'welcome-template',
    field_mappings: {
      core: {},
      custom: { preference: { source: 'manual', value: 'value' } },
    },
  };
  const baseResponses = {
    stage_member_action: { data: [action], error: null },
    form_submission: {
      data: { form_id: 'form', submission_data: { email: 'member@example.invalid' }, organization_id: 'organization' },
      error: null,
    },
    form: { data: { fields: [] }, error: null },
    member: { data: { id: 'existing-member', email: 'member@example.invalid' }, error: null },
    preference_field: { data: [{ id: 'preference', field_type: 'text' }], error: null },
  };
  let checkpoints = 0;
  const options = {
    configId: 'config',
    // A genuine pre-existing member has no creation provenance checkpoint and
    // must not receive a welcome email merely because this action runs.
    completedActionKeys: new Set(),
    onActionCompleted: async () => { checkpoints += 1; },
  };
  const failed = await withRoutedReads({
    ...baseResponses,
    member_preference_value: { data: null, error: { message: 'write failed' } },
  }, () => executeMemberCreationActions('new', submission, 'tenant', 'system', options));
  assert.equal(failed[0].status, 'partial');
  assert.equal(checkpoints, 0);

  const repaired = await withRoutedReads({
    ...baseResponses,
    member_preference_value: { data: null, error: null },
  }, () => executeMemberCreationActions('new', submission, 'tenant', 'system', options));
  assert.equal(repaired[0].status, 'success');
  assert.equal(checkpoints, 1);
});

test('existing-member repair upserts two fields without duplicate-key replay', async () => {
  const action = {
    id: 'member-action',
    email_field: 'email',
    role_id: 'role',
    field_mappings: {
      core: {},
      custom: {
        preference_a: { source: 'manual', value: 'A' },
        preference_b: { source: 'manual', value: 'B' },
      },
    },
  };
  const upserts = [];
  let attempt = 1;
  let checkpoints = 0;
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    const readResults = {
      stage_member_action: { data: [action], error: null },
      form_submission: {
        data: { form_id: 'form', submission_data: { email: 'member@example.invalid' }, organization_id: 'organization' },
        error: null,
      },
      form: { data: { fields: [] }, error: null },
      member: { data: { id: 'existing-member', email: 'member@example.invalid' }, error: null },
      preference_field: {
        data: [
          { id: 'preference_a', field_type: 'text' },
          { id: 'preference_b', field_type: 'text' },
        ],
        error: null,
      },
    };
    let response = readResults[table];
    const query = {
      select() { return query; },
      eq() { return query; },
      ilike() { return query; },
      in() { return query; },
      order() { return query; },
      upsert(payload, options) {
        upserts.push({ ...payload, options });
        response = payload.field_id === 'preference_b' && attempt === 1
          ? { data: null, error: { message: 'temporary write failure' } }
          : { data: null, error: null };
        return query;
      },
      single() {
        return response || { data: null, error: { message: `Unexpected ${table} read` } };
      },
      then(resolve) {
        if (!response) {
          response = { data: null, error: { message: `Unexpected ${table} operation` } };
        }
        return resolve(response);
      },
    };
    return query;
  };
  try {
    const options = {
      configId: 'config',
      onActionCompleted: async () => { checkpoints += 1; },
    };
    const first = await executeMemberCreationActions('new', submission, 'tenant', 'system', options);
    assert.equal(first[0].status, 'partial');
    assert.equal(checkpoints, 0);
    attempt = 2;
    const retry = await executeMemberCreationActions('new', submission, 'tenant', 'system', options);
    assert.equal(retry[0].status, 'success');
    assert.equal(checkpoints, 1);
    assert.equal(upserts.length, 4);
    assert.ok(upserts.every((entry) => entry.options.onConflict === 'member_id,field_id'));
    assert.deepEqual(
      upserts.map((entry) => entry.field_id),
      ['preference_a', 'preference_b', 'preference_a', 'preference_b'],
    );
  } finally {
    supabase.from = originalFrom;
  }
});

test('email action only checkpoints after sendEmail confirms delivery', async () => {
  const action = {
    id: 'email-action',
    recipient_email_field: 'email',
    email_template: { name: 'Template', subject: 'Subject', body: 'Body' },
  };
  let sendSucceeds = false;
  let checkpoints = 0;
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    const responseByTable = {
      form_submission: {
        data: { form_id: 'form', submission_data: { email: 'recipient@example.invalid' }, organization_id: 'organization' },
        error: null,
      },
      tenant: { data: { name: 'Tenant', slug: '' }, error: null },
      stage_email_action: { data: [action], error: null },
      organization: { data: null, error: null },
      member: { data: null, error: null },
    };
    const response = responseByTable[table] || { data: null, error: null };
    const query = {
      select() { return query; },
      eq() { return query; },
      is() { return query; },
      order() { return query; },
      single() { return response; },
      then(resolve) { return resolve(response); },
    };
    return query;
  };
  try {
    const options = {
      sendEmail: async () => (sendSucceeds
        ? { success: true, messageId: 'message' }
        : { success: false, error: 'provider rejected message' }),
      onActionCompleted: async () => { checkpoints += 1; },
    };
    const first = await executeEmailTemplateActions('new', submission, 'tenant', 'system', options);
    assert.equal(first[0].status, 'error');
    assert.equal(checkpoints, 0);
    sendSucceeds = true;
    const retry = await executeEmailTemplateActions('new', submission, 'tenant', 'system', options);
    assert.equal(retry[0].status, 'success');
    assert.equal(checkpoints, 1);
  } finally {
    supabase.from = originalFrom;
  }
});

test('resolved provider failures are retryable unless explicitly ambiguous', () => {
  const rejected = __testables.createEmailDeliveryError({
    success: false,
    error: 'provider rejected message',
  });
  assert.equal(rejected.ddAmbiguousEffect, undefined);
  const interrupted = __testables.createEmailDeliveryError({
    success: false,
    error: 'timed out',
    ambiguousEffect: true,
  });
  assert.equal(interrupted.ddAmbiguousEffect, true);
});

test('an absent DD configuration remains a no-op, while a configuration read failure is strict', async () => {
  await assert.rejects(
    withFailingRead(
      'form_due_diligence_config',
      () => executeStageActions('new', { form_id: 'form' }, 'tenant', 'system', strictOptions),
    ),
    { ddKnownQueryFailure: true },
  );

  const originalFrom = supabase.from;
  supabase.from = failingReadClient('form_due_diligence_config', {
    code: 'PGRST116',
    message: 'No rows',
  }).from;
  try {
    const result = await executeStageActions('new', { form_id: 'form' }, 'tenant', 'system', strictOptions);
    assert.deepEqual(result.stage_actions_results, []);
  } finally {
    supabase.from = originalFrom;
  }
});

test('partial contract delivery persists successful signers without checkpointing the field', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const { updatedSigners, allSignersSent } = __testables.applyContractDelivery(
    [{ email: 'first@example.invalid' }, { email: 'second@example.invalid' }],
    ['first@example.invalid'],
    now,
  );
  assert.equal(__testables.contractDeliveryStatus(1, 1), 'partial');
  assert.equal(updatedSigners[0].sent_at, now);
  assert.equal(updatedSigners[1].sent_at, undefined);
  assert.equal(allSignersSent, false);
  assert.deepEqual(
    __testables.pendingContractSigners(updatedSigners).map((signer) => signer.email),
    ['second@example.invalid'],
  );
});

test('only explicitly successful action results have durable checkpoint keys', () => {
  assert.equal(__testables.actionCheckpointKey({
    action: 'send_contract',
    field_id: 'contact-field',
  }), 'contract:contact-field');
  assert.equal(__testables.contractDeliveryStatus(1, 0), 'success');
  assert.equal(__testables.contractDeliveryStatus(0, 1), 'failed');
});

test('a checkpoint write failure is preserved and immediately thrown', async () => {
  const options = {
    onActionCompleted: async () => { throw new Error('checkpoint unavailable'); },
  };
  await assert.rejects(
    __testables.checkpointCompletedAction(options, {
      action: 'send_email_template',
      email_action_id: 'action',
      status: 'success',
    }),
    /checkpoint unavailable/,
  );
  assert.equal(options.checkpointFailure.message, 'checkpoint unavailable');
});

test('member creation provenance uses a separate durable key', async () => {
  const keys = [];
  await __testables.checkpointMemberCreation({
    onActionCompleted: async (key) => { keys.push(key); },
  }, 'member-action');
  assert.deepEqual(keys, ['member-created:member-action']);
});

test('contract signer persistence failures are ambiguous, never safe query retries', () => {
  const error = __testables.createAmbiguousContractPersistenceError({
    message: 'write unavailable',
  });
  assert.equal(error.ddAmbiguousFailure, true);
  assert.equal(error.ddKnownQueryFailure, undefined);
});

test('Zoho credential query failures are strict, but absent integration is not', async () => {
  await assert.rejects(
    withFailingRead('tenant_integrations', () => (
      getTenantZohoCrmCredentials('tenant', { strictQueryErrors: true })
    )),
    { ddKnownQueryFailure: true },
  );
  const originalFrom = supabase.from;
  supabase.from = failingReadClient('tenant_integrations', {
    code: 'PGRST116',
    message: 'No rows',
  }).from;
  try {
    assert.equal(
      await getTenantZohoCrmCredentials('tenant', { strictQueryErrors: true }),
      null,
    );
  } finally {
    supabase.from = originalFrom;
  }
});

test('Zoho executor distinguishes confirmed rejection from ambiguous post-create outcomes', async () => {
  const action = { id: 'zoho-action' };
  const dd = { id: 'dd', form_submission_id: 'submission' };
  let mode = 'success';
  let checkpoints = 0;
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    let operation = 'read';
    const query = {
      select() { return query; },
      eq() { return query; },
      is() { return query; },
      ilike() { return query; },
      order() { return query; },
      limit() { return query; },
      update() { operation = 'update'; return query; },
      single() {
        if (table === 'form_submission') {
          return {
            data: { form_id: 'form', submission_data: { org: 'Organization' }, organization_id: null },
            error: null,
          };
        }
        if (table === 'form') {
          return { data: { name: 'ESO', slug: 'eso', fields: [{ id: 'org', label: 'Organization name' }] }, error: null };
        }
        return { data: null, error: null };
      },
      then(resolve) {
        if (table === 'stage_zoho_crm_action' && operation === 'read') {
          return resolve({ data: [action], error: null });
        }
        if (table === 'form_submission_due_diligence' && operation === 'update') {
          return resolve({ data: null, error: mode === 'linkage-failure' ? { message: 'linkage write failed' } : null });
        }
        if (table === 'stage_zoho_crm_action' && operation === 'update') {
          return resolve({ data: null, error: mode === 'tracking-failure' ? { message: 'tracking write failed' } : null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return query;
  };
  const options = {
    isZohoCrmConnected: async () => true,
    createZohoOrganization: async () => {
      if (mode === 'timeout') {
        const error = new Error('Zoho POST timed out');
        error.ddAmbiguousEffect = true;
        throw error;
      }
      if (mode === 'rejected') return { success: false, error: 'validation rejected' };
      return { success: true, id: 'zoho-account' };
    },
    onActionCompleted: async () => { checkpoints += 1; },
  };
  try {
    mode = 'timeout';
    await assert.rejects(
      executeZohoCrmActions('new', dd, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(checkpoints, 0);

    mode = 'rejected';
    const rejected = await executeZohoCrmActions('new', dd, 'tenant', 'system', options);
    assert.equal(rejected[0].status, 'error');
    assert.equal(checkpoints, 0);

    mode = 'linkage-failure';
    await assert.rejects(
      executeZohoCrmActions('new', dd, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(checkpoints, 0);

    mode = 'tracking-failure';
    await assert.rejects(
      executeZohoCrmActions('new', dd, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(checkpoints, 0);

    mode = 'success';
    const success = await executeZohoCrmActions('new', dd, 'tenant', 'system', options);
    assert.equal(success[0].status, 'success');
    assert.equal(checkpoints, 1);
  } finally {
    supabase.from = originalFrom;
  }
});

test('Zoho POST transport classifier preserves pre-connect retries and marks unknown writes', () => {
  assert.equal(
    isZohoPostTransportAmbiguous(new ZohoTimeoutError('https://www.zohoapis.com/crm/v3/Accounts', 100)),
    true,
  );
  assert.equal(
    isZohoPostTransportAmbiguous(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'EAI_AGAIN' },
    })),
    false,
  );
  assert.equal(
    isZohoPostTransportAmbiguous(Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    })),
    true,
  );
});