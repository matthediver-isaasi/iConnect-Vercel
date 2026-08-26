import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  collectFormCommunicationSelections,
  normalizeSubscriberEmail,
  persistFormCommunicationSubscriptions,
} from './formCommunicationSubscriptions.js';

function createDatabase({ categories = ['cat-news'], members = [], failures = {} } = {}) {
  const state = {
    members: members.map((member) => ({ ...member })),
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
      const row = state.members.find((member) =>
        this.table === 'member' &&
        Object.entries(this.filters).every(([key, value]) => member[key] === value)
      );
      return Promise.resolve({ data: row || null, error: null });
    }
    then(resolve, reject) {
      const result = this.table === 'communication_category'
        ? { data: categories.filter((id) => this.filters.id.includes(id)).map((id) => ({ id })), error: failures.categories || null }
        : { data: null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    }
    update(values) {
      state.operations.push(['update', this.table, values]);
      const query = this;
      query.then = (resolve, reject) => {
        const member = state.members.find((item) =>
          Object.entries(query.filters).every(([key, value]) => item[key] === value)
        );
        if (member) Object.assign(member, values);
        return Promise.resolve({ error: failures[`${query.table}:update`] || null }).then(resolve, reject);
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

  assert.deepEqual(result, { kind: 'member', memberId: 'member-new', count: 2 });
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

test('public submission persists subscriptions only after a successful pipeline and never for anonymous surveys', () => {
  const source = fs.readFileSync(new URL('../public/form-submission.js', import.meta.url), 'utf8');
  const processorSource = fs.readFileSync(new URL('../forms/process-application.js', import.meta.url), 'utf8');
  const pipelineStart = source.indexOf('if (hasEntityPipelines && !surveyIsAnonymous)');
  const pipelineFailureReturn = source.indexOf("code: 'PIPELINE_NETWORK_ERROR'", pipelineStart);
  const subscriptionGuard = source.indexOf('if (!surveyIsAnonymous)', pipelineFailureReturn);
  const persistenceCall = source.indexOf('persistFormCommunicationSubscriptions({', subscriptionGuard);

  assert.ok(pipelineStart >= 0);
  assert.ok(pipelineFailureReturn > pipelineStart);
  assert.ok(subscriptionGuard > pipelineFailureReturn);
  assert.ok(persistenceCall > subscriptionGuard);
  assert.match(source, /defer_communication_subscriptions:\s*true/);
  assert.match(source, /mappedSelections:\s*deferredCommunicationSelections/);
  assert.match(processorSource, /createdMemberId && fields && !defer_communication_subscriptions/);
  assert.match(processorSource, /memberCommunicationPrefsMap\.size > 0 && !defer_communication_subscriptions/);
  assert.match(processorSource, /deferred_communication_selections:\s*defer_communication_subscriptions/);
});
