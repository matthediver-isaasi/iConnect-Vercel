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

  return { database: { from: (table) => new Query(table) }, state };
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
    failures: { 'member_communication_preference:upsert': writeError },
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
  assert.match(processorSource, /createdMemberId && fields && !defer_communication_subscriptions/);
  assert.match(processorSource, /memberCommunicationPrefsMap\.size > 0 && !defer_communication_subscriptions/);
});