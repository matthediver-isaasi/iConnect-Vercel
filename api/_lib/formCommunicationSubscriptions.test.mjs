import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  collectFormCommunicationSelections,
  collectMemberPipelineCommunicationSelections,
  createFormCommunicationSnapshot,
  finalizeFormCommunicationSnapshot,
  normalizeSubscriberEmail,
  persistFormCommunicationSubscriptions,
  prepareInitialMemberCommunicationSnapshot,
  promoteAwaitingMemberCommunicationSnapshot,
} from './formCommunicationSubscriptions.js';

function createDatabase({
  categories = ['cat-news'],
  categoryRoles = [],
  members = [],
  submissions = [],
  failures = {},
} = {}) {
  const state = {
    members: members.map((member) => ({ ...member })),
    submissions: submissions.map((submission) => ({ ...submission })),
    preferences: [],
    subscribers: [],
    operations: [],
    unsubscribes: [],
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = {};
    }
    select() { return this; }
    eq(column, value) { this.filters[column] = value; return this; }
    in(column, values) { this.filters[column] = values; return this; }
    maybeSingle() {
      if (failures[`${this.table}:lookup`]) return Promise.resolve({ data: null, error: failures[`${this.table}:lookup`] });
      const rows = this.table === 'member'
        ? state.members
        : this.table === 'form_submission'
          ? state.submissions
          : [];
      const row = rows.find((item) =>
        Object.entries(this.filters).every(([key, value]) => item[key] === value)
      );
      if (this.table === 'form_submission' && row) {
        return Promise.resolve({
          data: { communication_finalization_state: row.communication_finalization_state },
          error: null,
        });
      }
      return Promise.resolve({ data: row || null, error: null });
    }
    then(resolve, reject) {
      let result = { data: null, error: null };
      if (this.table === 'communication_category') {
        const categoryRows = categories.map((category) => typeof category === 'string'
          ? { id: category, tenant_id: 'tenant-1', is_active: true, is_public: true }
          : {
              tenant_id: 'tenant-1',
              is_active: true,
              is_public: true,
              ...category,
            }
        );
        result = {
          data: categoryRows.filter((row) =>
            Object.entries(this.filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value
            )
          ),
          error: failures.categories || null,
        };
      } else if (this.table === 'communication_category_role') {
        result = {
          data: categoryRoles.filter((row) =>
            Object.entries(this.filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value
            )
          ),
          error: failures['communication_category_role:lookup'] || null,
        };
      } else if (this.table === 'member_communication_preference') {
        result = {
          data: state.preferences.filter((row) =>
            Object.entries(this.filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value
            )
          ),
          error: failures['member_communication_preference:lookup'] || null,
        };
      } else if (this.table === 'email_subscriber') {
        result = {
          data: state.subscribers.filter((row) =>
            Object.entries(this.filters).every(([key, value]) =>
              Array.isArray(value) ? value.includes(row[key]) : row[key] === value
            )
          ),
          error: failures['email_subscriber:lookup'] || null,
        };
      }
      return Promise.resolve(result).then(resolve, reject);
    }
    update(values) {
      state.operations.push(['update', this.table, values]);
      const query = this;
      query.then = (resolve, reject) => {
        const rows = query.table === 'member'
          ? state.members
          : query.table === 'form_submission'
            ? state.submissions
            : [];
        const row = rows.find((item) =>
          Object.entries(query.filters).every(([key, value]) => item[key] === value)
        );
        const failure = failures[`${query.table}:update`];
        if (row && !failure) Object.assign(row, values);
        return Promise.resolve({ error: failure || null }).then(resolve, reject);
      };
      return query;
    }
    upsert(values) {
      state.operations.push(['upsert', this.table, { ...values }]);
      if (this.table === 'member_communication_preference') {
        const index = state.preferences.findIndex((row) =>
          row.member_id === values.member_id && row.category_id === values.category_id
        );
        if (index >= 0) state.preferences[index] = { ...values };
        else state.preferences.push({ ...values });
      } else if (this.table === 'email_subscriber') {
        const index = state.subscribers.findIndex((row) =>
          row.tenant_id === values.tenant_id &&
          row.email === values.email &&
          row.communication_category_id === values.communication_category_id
        );
        if (index >= 0) state.subscribers[index] = { ...values };
        else state.subscribers.push({ ...values });
      }
      return Promise.resolve({ error: failures[`${this.table}:upsert`] || null });
    }
    delete() {
      state.operations.push(['delete', this.table]);
      const query = this;
      query.then = (resolve, reject) => {
        if (!failures[`${query.table}:delete`]) {
          state.subscribers = state.subscribers.filter((row) =>
            !Object.entries(query.filters).every(([key, value]) => row[key] === value)
          );
        }
        return Promise.resolve({ error: failures[`${query.table}:delete`] || null }).then(resolve, reject);
      };
      return query;
    }
  }

  const database = {
    from: (table) => new Query(table),
    async rpc(name, values) {
      state.operations.push(['rpc', name, { ...values }]);
      const failure = failures[`${name}:rpc`];
      if (failure) return { error: failure };
      if (name === 'claim_form_communication_finalization') {
        const submission = state.submissions.find((row) => row.id === values.p_submission_id);
        const current = submission?.communication_finalization_state;
        if (!submission || !current
          || current.status !== values.p_expected_status
          || Number(current.attempts || 0) !== values.p_expected_attempts
          || !['pending', 'failed'].includes(current.status)) {
          return { data: null, error: null };
        }
        submission.communication_finalization_state = {
          ...current,
          status: 'processing',
          attempts: Number(current.attempts || 0) + 1,
          owner_token: values.p_owner_token,
          error: null,
        };
        return { data: { ...submission.communication_finalization_state }, error: null };
      }
      if (name === 'promote_form_communication_finalization') {
        const submission = state.submissions.find((row) => row.id === values.p_submission_id);
        const current = submission?.communication_finalization_state;
        if (!submission) return { data: null, error: null };
        if (current?.status === 'awaiting_member') {
          submission.created_member_id = values.p_member_id || submission.created_member_id || null;
          submission.communication_finalization_state = { ...values.p_snapshot };
        } else if (current?.status === 'completed' && values.p_snapshot?.status === 'completed') {
          submission.created_member_id = values.p_member_id || submission.created_member_id || null;
        }
        return { data: { ...submission.communication_finalization_state }, error: null };
      }
      if (name === 'finish_form_communication_finalization') {
        const submission = state.submissions.find((row) => row.id === values.p_submission_id);
        const current = submission?.communication_finalization_state;
        if (!submission || current?.status !== 'processing' || current.owner_token !== values.p_owner_token) {
          return { data: null, error: null };
        }
        const { owner_token, ...withoutOwner } = current;
        submission.communication_finalization_state = {
          ...withoutOwner,
          status: values.p_status,
          member_id: values.p_member_id || null,
          error: values.p_error || null,
        };
        return { data: { ...submission.communication_finalization_state }, error: null };
      }
      for (let index = 0; index < values.p_category_ids.length; index += 1) {
        const categoryId = values.p_category_ids[index];
        const isSubscribed = values.p_is_subscribed[index];
        if (values.p_member_id) {
          const preference = {
            member_id: values.p_member_id,
            category_id: categoryId,
            is_subscribed: isSubscribed,
            tenant_id: values.p_tenant_id,
          };
          const preferenceIndex = state.preferences.findIndex((row) =>
            row.member_id === preference.member_id && row.category_id === categoryId
          );
          if (preferenceIndex >= 0) state.preferences[preferenceIndex] = preference;
          else state.preferences.push(preference);
          state.subscribers = state.subscribers.filter((row) => !(
            row.tenant_id === values.p_tenant_id
              && row.email === values.p_email
              && row.communication_category_id === categoryId
          ));
        } else {
          const subscriber = {
            tenant_id: values.p_tenant_id,
            email: values.p_email,
            first_name: values.p_first_name,
            last_name: values.p_last_name,
            form_id: values.p_form_id,
            communication_category_id: categoryId,
            opted_out: !isSubscribed,
            opted_out_at: isSubscribed ? null : new Date().toISOString(),
          };
          const subscriberIndex = state.subscribers.findIndex((row) =>
            row.tenant_id === subscriber.tenant_id
              && row.email === subscriber.email
              && row.communication_category_id === categoryId
          );
          if (subscriberIndex >= 0) state.subscribers[subscriberIndex] = subscriber;
          else state.subscribers.push(subscriber);
        }
      }
      if (values.p_is_subscribed.some(Boolean)) {
        const member = state.members.find((item) => item.id === values.p_member_id);
        if (member) member.communications_opted_out_all = false;
        state.unsubscribes = state.unsubscribes.filter((row) => row.unsubscribe_type !== 'all');
      }
      return { error: null };
    },
  };
  return { database, state };
}

const form = {
  id: 'form-1',
  communication_category_id: 'cat-news',
  fields: [
    { id: 'email', type: 'email' },
    { id: 'first_name', type: 'text' },
    { id: 'prefs', type: 'communication_preferences' },
  ],
};

test('normalizes subscriber emails and preserves multi-category opt-outs over the single category default', () => {
  assert.equal(normalizeSubscriberEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.deepEqual(
    [...collectFormCommunicationSelections(form, {
      prefs: { 'cat-news': false, 'cat-events': true },
    })],
    [['cat-news', false], ['cat-events', true]]
  );
});

test('merges explicit, preference-field, and mapped selections with mappings taking precedence', () => {
  assert.deepEqual(
    [...collectFormCommunicationSelections(form, {
      prefs: { 'cat-news': false, 'cat-events': true },
    }, [
      { category_id: 'cat-news', is_subscribed: true },
      { category_id: 'cat-events', is_subscribed: false },
      { category_id: 'cat-training', is_subscribed: true },
    ])],
    [['cat-news', true], ['cat-events', false], ['cat-training', true]]
  );
});

test('member pipeline communication mappings are resolved centrally with exact boolean semantics', () => {
  const pipelines = {
    members: [{
      isPrimary: true,
      mappings: [
        { target_type: 'communication', target_field: 'cat-events', source_field_id: 'events' },
        { target_type: 'communication', target_field: 'cat-news', source_field_id: 'prefs' },
      ],
    }],
  };
  assert.deepEqual(
    collectMemberPipelineCommunicationSelections(pipelines, {
      events: 'Yes',
      prefs: { 'cat-news': false },
    }),
    [
      { category_id: 'cat-events', is_subscribed: true },
      { category_id: 'cat-news', is_subscribed: false },
    ]
  );
});

test('member pipelines with no communication choices stay a completed no-op', () => {
  const snapshot = createFormCommunicationSnapshot({
    form: { id: 'form-no-communication', fields: [] },
    submissionData: {},
  });
  assert.equal(snapshot.status, 'completed');
  assert.equal(
    prepareInitialMemberCommunicationSnapshot(snapshot, true).status,
    'completed'
  );

  const pending = createFormCommunicationSnapshot({
    form,
    submissionData: { email: 'person@example.com' },
  });
  assert.equal(
    prepareInitialMemberCommunicationSnapshot(pending, true).status,
    'awaiting_member'
  );

  const noEmailButMapped = createFormCommunicationSnapshot({
    form: { id: 'form-no-email', fields: [] },
    submissionData: {},
    mappedSelections: [{ category_id: 'cat-news', is_subscribed: true }],
  });
  assert.equal(noEmailButMapped.status, 'completed');
  assert.equal(
    prepareInitialMemberCommunicationSnapshot(noEmailButMapped, true).status,
    'awaiting_member'
  );
});

test('mapping-only reported configuration subscribes the resolved member to event updates', async () => {
  const mappingOnlyForm = {
    id: 'form-reported-shape',
    fields: [{ id: 'email', type: 'email' }],
  };
  const { database, state } = createDatabase({
    categories: ['cat-event-updates'],
    members: [{ id: 'member-reported', tenant_id: 'tenant-1', email: 'person@example.com' }],
  });

  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form: mappingOnlyForm,
    submissionData: { email: 'person@example.com' },
    mappedSelections: [{ category_id: 'cat-event-updates', is_subscribed: true }],
    resolvedMemberId: 'member-reported',
  });

  assert.equal(result.kind, 'member');
  assert.deepEqual(state.preferences, [{
    member_id: 'member-reported',
    category_id: 'cat-event-updates',
    is_subscribed: true,
    tenant_id: 'tenant-1',
  }]);
  assert.equal(state.subscribers.length, 0);
});

test('mapped false opts out and invalid or cross-tenant mapped categories are rejected', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-events'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'ada@example.com' }],
  });
  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form: { id: 'form-1', fields: [{ id: 'email', type: 'email' }] },
    submissionData: { email: 'ada@example.com' },
    mappedSelections: [
      { category_id: 'cat-events', is_subscribed: false },
      { category_id: 'cat-other-tenant', is_subscribed: true },
    ],
    resolvedMemberId: 'member-1',
  });

  assert.equal(result.count, 1);
  assert.deepEqual(state.preferences.map(({ category_id, is_subscribed }) => [category_id, is_subscribed]), [
    ['cat-events', false],
  ]);
});

test('form submissions reject member opt-ins outside the member role allowlist', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news'],
    categoryRoles: [{ tenant_id: 'tenant-1', category_id: 'cat-news', role_id: 'role-allowed' }],
    members: [{
      id: 'member-1',
      tenant_id: 'tenant-1',
      email: 'ada@example.com',
      role_id: 'role-other',
    }],
  });

  await assert.rejects(
    persistFormCommunicationSubscriptions({
      database,
      tenantId: 'tenant-1',
      form,
      submissionData: { email: 'ada@example.com' },
      resolvedMemberId: 'member-1',
    }),
    (error) => error.code === 'COMMUNICATION_CATEGORY_ROLE_FORBIDDEN',
  );
  assert.equal(state.preferences.length, 0);
});

test('form submissions allow matching roles and roleless categories', async () => {
  const matching = createDatabase({
    categories: ['cat-news'],
    categoryRoles: [{ tenant_id: 'tenant-1', category_id: 'cat-news', role_id: 'role-allowed' }],
    members: [{
      id: 'member-1',
      tenant_id: 'tenant-1',
      email: 'ada@example.com',
      role_id: 'role-allowed',
    }],
  });
  await persistFormCommunicationSubscriptions({
    database: matching.database,
    tenantId: 'tenant-1',
    form,
    submissionData: { email: 'ada@example.com' },
    resolvedMemberId: 'member-1',
  });
  assert.equal(matching.state.preferences[0].is_subscribed, true);

  const roleless = createDatabase({
    categories: ['cat-news'],
    members: [{
      id: 'member-2',
      tenant_id: 'tenant-1',
      email: 'grace@example.com',
      role_id: null,
    }],
  });
  await persistFormCommunicationSubscriptions({
    database: roleless.database,
    tenantId: 'tenant-1',
    form,
    submissionData: { email: 'grace@example.com' },
    resolvedMemberId: 'member-2',
  });
  assert.equal(roleless.state.preferences[0].is_subscribed, true);
});

test('form submissions retain member unsubscribe after role access is removed', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news'],
    categoryRoles: [{ tenant_id: 'tenant-1', category_id: 'cat-news', role_id: 'role-allowed' }],
    members: [{
      id: 'member-1',
      tenant_id: 'tenant-1',
      email: 'ada@example.com',
      role_id: 'role-other',
    }],
  });
  const optOutForm = {
    ...form,
    communication_category_id: null,
  };

  await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form: optOutForm,
    submissionData: {
      email: 'ada@example.com',
      prefs: { 'cat-news': false },
    },
    resolvedMemberId: 'member-1',
  });
  assert.equal(state.preferences[0].is_subscribed, false);
});

test('a newly resolved member receives preferences and stale external rows are removed', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news', 'cat-events'],
    members: [{ id: 'member-new', tenant_id: 'tenant-1', email: 'ada@example.com', communications_opted_out_all: true }],
  });
  state.subscribers.push(
    { tenant_id: 'tenant-1', email: 'ada@example.com', communication_category_id: 'cat-news' },
    { tenant_id: 'tenant-1', email: 'ada@example.com', communication_category_id: 'cat-events' },
  );

  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form,
    submissionData: {
      email: '  Ada@Example.COM ',
      prefs: { 'cat-news': false, 'cat-events': true },
    },
    resolvedMemberId: 'member-new',
  });

  assert.equal(result.kind, 'member');
  assert.equal(result.memberId, 'member-new');
  assert.equal(result.count, 2);
  assert.deepEqual(state.preferences.map(({ category_id, is_subscribed }) => [category_id, is_subscribed]), [
    ['cat-news', false],
    ['cat-events', true],
  ]);
  assert.equal(state.members[0].communications_opted_out_all, false);
  assert.deepEqual(state.subscribers, []);
});

test('an existing member is found by normalized email and is never persisted externally', async () => {
  const { database, state } = createDatabase({
    members: [{ id: 'member-existing', tenant_id: 'tenant-1', email: 'ada@example.com', communications_opted_out_all: false }],
  });
  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form,
    submissionData: { email: ' ADA@example.com ' },
  });
  assert.equal(result.kind, 'member');
  assert.equal(state.preferences[0].member_id, 'member-existing');
  assert.equal(state.subscribers.length, 0);
});

test('a pipeline-resolved member does not require a recognizable submitted email field', async () => {
  const { database, state } = createDatabase({
    members: [{ id: 'member-resolved', tenant_id: 'tenant-1', email: 'ada@example.com', communications_opted_out_all: false }],
  });
  state.subscribers.push({ tenant_id: 'tenant-1', email: 'ada@example.com', communication_category_id: 'cat-news' });

  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form,
    submissionData: {},
    resolvedMemberId: 'member-resolved',
  });

  assert.equal(result.kind, 'member');
  assert.equal(state.preferences[0].member_id, 'member-resolved');
  assert.equal(state.subscribers.length, 0);
});

test('a genuinely external submitter gets subscribed and opted-out category rows idempotently', async () => {
  const { database, state } = createDatabase({ categories: ['cat-news', 'cat-events'] });
  const args = {
    database,
    tenantId: 'tenant-1',
    form,
    submissionData: {
      email: ' Ada@Example.com ',
      first_name: ' Ada ',
      prefs: { 'cat-events': false },
    },
  };
  await persistFormCommunicationSubscriptions(args);
  await persistFormCommunicationSubscriptions(args);

  assert.equal(state.subscribers.length, 2);
  assert.deepEqual(
    state.subscribers.map(({ communication_category_id, opted_out }) => [communication_category_id, opted_out]),
    [['cat-news', false], ['cat-events', true]]
  );
  assert.ok(state.subscribers.find((row) => row.opted_out).opted_out_at);
  assert.ok(state.subscribers.every((row) => row.email === 'ada@example.com'));
});

test('external form opt-ins require a public active category but legacy opt-outs remain allowed', async () => {
  const { database, state } = createDatabase({
    categories: [
      { id: 'cat-public', is_public: true },
      { id: 'cat-private-optin', is_public: false },
      { id: 'cat-private-optout', is_public: false },
      { id: 'cat-inactive', is_public: true, is_active: false },
    ],
  });
  const result = await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form: { id: 'form-1', fields: [{ id: 'email', type: 'email' }] },
    submissionData: { email: 'external@example.com' },
    mappedSelections: [
      { category_id: 'cat-public', is_subscribed: true },
      { category_id: 'cat-private-optin', is_subscribed: true },
      { category_id: 'cat-private-optout', is_subscribed: false },
      { category_id: 'cat-inactive', is_subscribed: true },
    ],
  });

  assert.equal(result.kind, 'external');
  assert.deepEqual(
    state.subscribers.map(({ communication_category_id, opted_out }) => [
      communication_category_id,
      opted_out,
    ]),
    [['cat-public', false], ['cat-private-optout', true]],
  );
});

test('durable external finalization preserves snapshotted subscriber names', async () => {
  const { database, state } = createDatabase({
    submissions: [{ id: 'submission-1' }],
  });
  const snapshot = createFormCommunicationSnapshot({
    form: {
      id: 'form-1',
      communication_category_id: 'cat-news',
      fields: [
        { id: 'email', type: 'email' },
        { id: 'first_name', type: 'text', label: 'First name' },
        { id: 'last_name', type: 'text', label: 'Last name' },
      ],
    },
    submissionData: {
      email: 'external@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    },
  });
  state.submissions[0].communication_finalization_state = snapshot;

  await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot,
  });
  assert.equal(state.subscribers[0].first_name, 'Ada');
  assert.equal(state.subscribers[0].last_name, 'Lovelace');
});

test('failed external finalization replays names without nulling subscriber identity', async () => {
  const writeError = Object.assign(new Error('temporary preference write failure'), { code: 'TEMPORARY' });
  const failures = { 'set_form_communication_preference_state:rpc': writeError };
  const { database, state } = createDatabase({
    submissions: [{ id: 'submission-1' }],
    failures,
  });
  const snapshot = {
    version: 1,
    status: 'pending',
    member_id: null,
    email: 'external@example.com',
    first_name: 'Grace',
    last_name: 'Hopper',
    selections: [{ category_id: 'cat-news', is_subscribed: true }],
    attempts: 0,
    error: null,
  };
  state.submissions[0].communication_finalization_state = snapshot;

  await assert.rejects(finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot,
  }), writeError);
  delete failures['set_form_communication_preference_state:rpc'];
  await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: state.submissions[0].communication_finalization_state,
  });

  assert.equal(state.subscribers[0].first_name, 'Grace');
  assert.equal(state.subscribers[0].last_name, 'Hopper');
  const writeCalls = state.operations.filter(([, name]) =>
    name === 'set_form_communication_preference_state'
  );
  assert.equal(writeCalls.at(-1)[2].p_first_name, 'Grace');
  assert.equal(writeCalls.at(-1)[2].p_last_name, 'Hopper');
});

test('member preference failures do not delete the stale external subscriber', async () => {
  const writeError = new Error('preference write failed');
  const { database, state } = createDatabase({
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'ada@example.com' }],
    failures: { 'set_form_communication_preference_state:rpc': writeError },
  });
  state.subscribers.push({ tenant_id: 'tenant-1', email: 'ada@example.com', communication_category_id: 'cat-news' });

  await assert.rejects(
    persistFormCommunicationSubscriptions({
      database,
      tenantId: 'tenant-1',
      form,
      submissionData: { email: 'ada@example.com' },
      resolvedMemberId: 'member-1',
    }),
    writeError
  );
  assert.equal(state.subscribers.length, 1);
  assert.equal(state.operations.some(([operation]) => operation === 'delete'), false);
});

test('form consent is persisted in one locked RPC with explicit desired category states', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news', 'cat-events'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'current@example.com', communications_opted_out_all: true }],
  });
  state.unsubscribes.push({
    tenant_id: 'tenant-1',
    email: 'current@example.com',
    unsubscribe_type: 'all',
  });

  await persistFormCommunicationSubscriptions({
    database,
    tenantId: 'tenant-1',
    form,
    submissionData: {
      email: 'old@example.com',
      prefs: { 'cat-news': false, 'cat-events': true },
    },
    resolvedMemberId: 'member-1',
  });

  const rpcCalls = state.operations.filter(([operation]) => operation === 'rpc');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0][1], 'set_form_communication_preference_state');
  assert.equal(rpcCalls[0][2].p_email, 'current@example.com');
  assert.deepEqual(rpcCalls[0][2].p_category_ids, ['cat-news', 'cat-events']);
  assert.deepEqual(rpcCalls[0][2].p_is_subscribed, [false, true]);
  assert.equal(state.members[0].communications_opted_out_all, false);
  assert.equal(state.unsubscribes.length, 0);
});

test('preference and form RPCs serialize on the same recipient lock and reconcile global suppression', () => {
  const migration = fs.readFileSync(
    new URL('../../supabase/migrations/20260826_atomic_email_preference_global_state.sql', import.meta.url),
    'utf8'
  );
  const lockExpression = "hashtextextended(p_tenant_id::text || ':' || v_email, 0)";
  assert.equal(migration.split(lockExpression).length - 1, 3);
  const formRpc = migration.slice(migration.indexOf('create or replace function set_form_communication_preference_state'));
  assert.match(formRpc, /set communications_opted_out_all = false/);
  assert.match(formRpc, /unsubscribe_type = 'all'/);
  assert.match(formRpc, /insert into member_communication_preference/);
  assert.match(formRpc, /insert into email_subscriber/);
  assert.match(formRpc, /insert into email_unsubscribe/);
});

test('failed first completion is durable and duplicate replay completes the exact member state', async () => {
  const rpcError = Object.assign(new Error('function is not available during deployment'), {
    code: 'PGRST202',
    details: 'set_form_communication_preference_state was not found',
  });
  const failures = { 'set_form_communication_preference_state:rpc': rpcError };
  const { database, state } = createDatabase({
    categories: ['cat-news', 'cat-events', 'cat-optout'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{ id: 'submission-1', created_member_id: 'member-1' }],
    failures,
  });
  const snapshot = createFormCommunicationSnapshot({
    form: {
      id: 'form-1',
      communication_category_id: 'cat-news',
      fields: [
        { id: 'email', type: 'email' },
        { id: 'prefs', type: 'communication_preferences' },
      ],
    },
    submissionData: {
      email: 'person@example.com',
      prefs: { 'cat-optout': false },
    },
    mappedSelections: [{ category_id: 'cat-events', is_subscribed: true }],
    resolvedMemberId: 'member-1',
  });
  state.submissions[0].communication_finalization_state = snapshot;

  await assert.rejects(finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot,
  }), rpcError);

  const failed = state.submissions[0].communication_finalization_state;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'PGRST202');
  assert.deepEqual(failed.selections, [
    { category_id: 'cat-news', is_subscribed: true },
    { category_id: 'cat-optout', is_subscribed: false },
    { category_id: 'cat-events', is_subscribed: true },
  ]);
  assert.equal(state.preferences.length, 0);
  assert.equal(state.subscribers.length, 0);
  assert.equal(state.members.length, 1);

  delete failures['set_form_communication_preference_state:rpc'];
  const completed = await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: failed,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attempts, 2);
  assert.deepEqual(
    state.preferences.map(({ category_id, is_subscribed }) => [category_id, is_subscribed]),
    [['cat-news', true], ['cat-optout', false], ['cat-events', true]]
  );
  assert.equal(state.subscribers.length, 0);
  assert.equal(state.members.length, 1);
});

test('an unavailable finalization claim contract fails before the preference write RPC', async () => {
  const migrationError = Object.assign(new Error('claim_form_communication_finalization does not exist'), { code: 'PGRST202' });
  const { database, state } = createDatabase({
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{ id: 'submission-1' }],
    failures: { 'claim_form_communication_finalization:rpc': migrationError },
  });
  const snapshot = createFormCommunicationSnapshot({
    form,
    submissionData: { email: 'person@example.com' },
    resolvedMemberId: 'member-1',
  });
  state.submissions[0].communication_finalization_state = snapshot;
  await assert.rejects(finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot,
  }), migrationError);
  assert.equal(
    state.operations.some(([, name]) => name === 'set_form_communication_preference_state'),
    false
  );
});

test('no-email and inactive-category selections complete as intentional no-ops', async () => {
  const noEmail = createFormCommunicationSnapshot({
    form,
    submissionData: {},
  });
  assert.equal(noEmail.status, 'completed');

  const { database, state } = createDatabase({
    categories: [],
    submissions: [{ id: 'submission-1' }],
  });
  const inactive = createFormCommunicationSnapshot({
    form,
    submissionData: { email: 'external@example.com' },
  });
  state.submissions[0].communication_finalization_state = inactive;
  const completed = await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: inactive,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(state.preferences.length, 0);
  assert.equal(state.subscribers.length, 0);
});

test('concurrent duplicate replays cannot overwrite a completed state', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{ id: 'submission-1' }],
  });
  const snapshot = createFormCommunicationSnapshot({
    form,
    submissionData: { email: 'person@example.com' },
    resolvedMemberId: 'member-1',
  });
  state.submissions[0].communication_finalization_state = snapshot;

  const results = await Promise.allSettled([
    finalizeFormCommunicationSnapshot({
      database, tenantId: 'tenant-1', submissionId: 'submission-1', formId: 'form-1', snapshot,
    }),
    finalizeFormCommunicationSnapshot({
      database, tenantId: 'tenant-1', submissionId: 'submission-1', formId: 'form-1', snapshot,
    }),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(state.submissions[0].communication_finalization_state.status, 'completed');
  assert.equal(state.preferences.length, 1);
});

test('a duplicate promotes a linked awaiting-member snapshot and replays without an external row', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news', 'cat-events'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{
      id: 'submission-1',
      created_member_id: 'member-1',
      communication_finalization_state: {
        version: 1,
        status: 'awaiting_member',
        member_id: null,
        email: 'person@example.com',
        selections: [
          { category_id: 'cat-news', is_subscribed: true },
          { category_id: 'cat-events', is_subscribed: true },
        ],
        attempts: 0,
        error: null,
      },
    }],
  });
  const pending = await promoteAwaitingMemberCommunicationSnapshot(database, state.submissions[0]);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.member_id, 'member-1');
  await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: pending,
  });
  assert.equal(state.submissions[0].communication_finalization_state.status, 'completed');
  assert.equal(state.preferences.length, 2);
  assert.equal(state.subscribers.length, 0);
});

test('guarded promotion atomically persists a newly resolved member after an earlier link update failed', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{
      id: 'submission-1',
      created_member_id: null,
      communication_finalization_state: {
        version: 1,
        status: 'awaiting_member',
        member_id: null,
        email: null,
        first_name: null,
        last_name: null,
        selections: [{ category_id: 'cat-news', is_subscribed: true }],
        attempts: 0,
        error: null,
      },
    }],
  });
  const resolvedSnapshot = {
    ...state.submissions[0].communication_finalization_state,
    status: 'pending',
    member_id: 'member-1',
  };
  const pending = await promoteAwaitingMemberCommunicationSnapshot(
    database,
    state.submissions[0],
    resolvedSnapshot
  );
  assert.equal(state.submissions[0].created_member_id, 'member-1');
  assert.equal(pending.member_id, 'member-1');
  assert.equal(pending.status, 'pending');

  await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: pending,
  });
  assert.equal(state.preferences[0].member_id, 'member-1');
  assert.equal(state.subscribers.length, 0);
});

test('guarded promotion still links a resolved member for a completed no-selection snapshot', async () => {
  const { database, state } = createDatabase({
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{
      id: 'submission-1',
      created_member_id: null,
      communication_finalization_state: {
        version: 1,
        status: 'completed',
        member_id: null,
        email: null,
        first_name: null,
        last_name: null,
        selections: [],
        attempts: 0,
        error: null,
      },
    }],
  });
  const completedWithMember = {
    ...state.submissions[0].communication_finalization_state,
    member_id: 'member-1',
  };
  const result = await promoteAwaitingMemberCommunicationSnapshot(
    database,
    state.submissions[0],
    completedWithMember
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.selections.length, 0);
  assert.equal(state.submissions[0].created_member_id, 'member-1');
  assert.equal(state.submissions[0].communication_finalization_state.status, 'completed');
});

test('the original request cannot overwrite a duplicate that already completed promotion and replay', async () => {
  const { database, state } = createDatabase({
    categories: ['cat-news'],
    members: [{ id: 'member-1', tenant_id: 'tenant-1', email: 'person@example.com' }],
    submissions: [{
      id: 'submission-1',
      created_member_id: 'member-1',
      communication_finalization_state: {
        version: 1,
        status: 'awaiting_member',
        member_id: null,
        email: 'person@example.com',
        selections: [{ category_id: 'cat-news', is_subscribed: true }],
        attempts: 0,
        error: null,
      },
    }],
  });
  const duplicatePending = await promoteAwaitingMemberCommunicationSnapshot(database, state.submissions[0]);
  await finalizeFormCommunicationSnapshot({
    database,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
    formId: 'form-1',
    snapshot: duplicatePending,
  });
  const completedBeforeOriginal = structuredClone(state.submissions[0].communication_finalization_state);

  const staleOriginalTarget = {
    ...duplicatePending,
    status: 'pending',
    attempts: 0,
  };
  const originalResult = await promoteAwaitingMemberCommunicationSnapshot(
    database,
    {
      id: 'submission-1',
      created_member_id: 'member-1',
      communication_finalization_state: {
        ...duplicatePending,
        status: 'awaiting_member',
      },
    },
    staleOriginalTarget
  );
  assert.equal(originalResult.status, 'completed');
  assert.deepEqual(state.submissions[0].communication_finalization_state, completedBeforeOriginal);
});
