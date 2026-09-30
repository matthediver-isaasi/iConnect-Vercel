import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./update-status.js', import.meta.url), 'utf8');
const ui = await readFile(new URL('../../client/src/pages/ReviewSubmission.jsx', import.meta.url), 'utf8');

function fixture({ sameStage = false, actionError, actionResults = [], updateError = null, concurrent = false, tenant = 'tenant', allowed = true } = {}) {
  const row = {
    id: 'submission', tenant_id: 'tenant', workflow_status: sameStage ? 'review' : 'draft',
    stage_action_occurrence_id: 'original-occurrence',
    form_submission: { form_id: 'form' }, history_log: [],
  };
  let writes = 0;
  let actions = 0;
  let webhooks = 0;
  const filters = [];
  const supabase = {
    from(table) {
      let update;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        is(key, value) { filters.push([key, value]); return query; },
        update(value) { update = value; return query; },
        async single() {
          if (table === 'form_due_diligence_config') return { data: {
            workflow_stages: [{ id: 'review' }],
            status_change_webhooks: [{ id: 'hook', trigger_status_id: 'review', webhook_url: 'https://isolated.invalid' }],
          } };
          return { data: { ...row } };
        },
        async maybeSingle() {
          writes++;
          if (updateError) return { error: updateError };
          if (concurrent) return { data: null };
          Object.assign(row, update);
          return { data: { ...row } };
        },
        then(resolve) { Object.assign(row, update); return Promise.resolve({ data: row }).then(resolve); },
      };
      return query;
    },
  };
  const context = vm.createContext({
    supabase,
    randomUUID: () => 'new-occurrence',
    getSessionMember: async () => ({ email: 'reviewer@example.invalid', tenant_id: tenant, role_id: 'role' }),
    getTenantContext: async () => ({ tenantId: 'tenant' }),
    resolveMemberExclusions: async () => [],
    makeFeatureAccessChecker: () => ({ canAccessFeature: () => allowed }),
    getPublicBaseUrl: () => 'https://isolated.invalid',
    executeStageActions: async () => {
      actions++;
      if (actionError) throw actionError;
      return { stage_actions_results: actionResults };
    },
    fetch: async () => { webhooks++; return { ok: true }; },
    console: { error() {} },
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler'), context);
  return {
    row, filters,
    counts: () => ({ writes, actions, webhooks }),
    async call() {
      const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await context.handler({ method: 'POST', body: { submissionId: 'submission', newStatus: 'review' } }, response);
      return response;
    },
  };
}

test('fresh stage persists one occurrence and executes effects once', async () => {
  const f = fixture();
  assert.equal((await f.call()).code, 200);
  assert.equal(f.row.stage_action_occurrence_id, 'new-occurrence');
  assert.ok(f.filters.some(([key, value]) => key === 'stage_action_occurrence_id' && value === 'original-occurrence'));
  const repeat = await f.call();
  assert.equal(repeat.body.actions_require_attention, true);
  assert.deepEqual(f.counts(), { writes: 1, actions: 1, webhooks: 1 });
});

test('saved stage reports attention and only safe fanout identifiers; repeating never resends preceding webhooks', async () => {
  const error = Object.assign(new Error('private payload and recorded provider error'), {
    ddFanout: { event_id: 'event-1', event_key: 'dd:occurrence:1', delivery_key: 'delivery-1', status: 'requires_attention', reason: 'secret' },
    ddFanoutRecordedReason: 'sensitive original interruption',
  });
  const f = fixture({ actionError: error });
  const response = await f.call();
  assert.equal(response.code, 409);
  assert.equal(response.body.status_persisted, true);
  assert.equal(response.body.persisted_status, 'review');
  assert.equal(response.body.diagnostic.event_id, 'event-1');
  assert.doesNotMatch(JSON.stringify(response.body), /private|secret|provider|sensitive|interruption/);
  await f.call();
  assert.deepEqual(f.counts(), { writes: 1, actions: 1, webhooks: 1 });
});

test('existing occurrence is not replayed or treated as completed', async () => {
  const f = fixture({ sameStage: true });
  const response = await f.call();
  assert.equal(response.body.stage_action_occurrence_id, 'original-occurrence');
  assert.equal(response.body.actions_require_attention, true);
  assert.deepEqual(f.counts(), { writes: 0, actions: 0, webhooks: 0 });
});

test('failed CAS and write failure never claim a saved transition or run effects', async () => {
  for (const options of [{ concurrent: true }, { updateError: { message: 'private' } }]) {
    const f = fixture(options);
    const response = await f.call();
    assert.notEqual(response.body.status_persisted, true);
    assert.deepEqual(f.counts(), { writes: 1, actions: 0, webhooks: 0 });
  }
});

test('cross-tenant and excluded reviewers are rejected before reads or writes', async () => {
  for (const options of [{ tenant: 'other' }, { allowed: false }]) {
    const f = fixture(options);
    assert.equal((await f.call()).code, 403);
    assert.equal(f.filters.length, 0);
    assert.deepEqual(f.counts(), { writes: 0, actions: 0, webhooks: 0 });
  }
});

test('returned action failures are partial completion, not success or sensitive errors', async () => {
  const f = fixture({ actionResults: [{ action: 'field_mapping', status: 'partial', error: 'private detail' }] });
  const response = await f.call();
  assert.equal(response.body.actions_require_attention, true);
  assert.doesNotMatch(JSON.stringify(response.body), /private detail/);
});

test('configured but undelivered actions require attention; intentional already-sent no-ops remain successful', async () => {
  for (const action of ['send_meeting_request', 'send_email_template', 'send_contract', 'create_member', 'field_mapping']) {
    const f = fixture({ actionResults: [{ action, status: 'requires_attention', reason: 'private missing delivery requirement' }] });
    const response = await f.call();
    assert.equal(response.code, 409, action);
    assert.equal(response.body.status_persisted, true);
    assert.equal(response.body.actions_require_attention, true);
    assert.doesNotMatch(JSON.stringify(response.body), /private missing delivery requirement/);
    assert.deepEqual(f.counts(), { writes: 1, actions: 1, webhooks: 1 });
  }
  for (const actionResults of [[], [{ action: 'send_contract', status: 'skipped', reason: 'Contract already sent' }]]) {
    const response = await fixture({ actionResults }).call();
    assert.equal(response.code, 200);
    assert.equal(response.body.actions_require_attention, false);
  }
});

test('review UI distinguishes saved stage, refreshes authoritative status on every error, and offers no replay', () => {
  const statusMutation = ui.slice(ui.indexOf('const updateStatusMutation'), ui.indexOf('const handleSave'));
  assert.match(statusMutation, /error\.body\?\.status_persisted === true/);
  assert.match(statusMutation, /await queryClient\.invalidateQueries/);
  assert.match(statusMutation, /setWorkflowStatus\(authoritative\.submission\.workflow_status\)/);
  assert.doesNotMatch(statusMutation, /error\.message/);
  assert.match(ui, /data-testid="stage-transition-notice"/);
});

test('review local request helper preserves structured partial-stage errors for the mutation handler', async () => {
  const helper = ui.slice(ui.indexOf('async function apiRequest('), ui.indexOf('const MEMBER_FIELD_MAPPING_ISSUE_STATUSES'));
  const body = {
    error: 'Stage actions need attention',
    status_persisted: true,
    persisted_status: 'review',
    stage_action_occurrence_id: 'original-occurrence',
  };
  const context = vm.createContext({
    fetch: async () => ({ ok: false, status: 409, json: async () => body }),
  });
  vm.runInContext(helper, context);
  await assert.rejects(context.apiRequest('POST', '/isolated-fixture', {}), error => {
    assert.equal(error.status, 409);
    assert.equal(error.body, body);
    assert.equal(error.body.status_persisted, true);
    assert.equal(error.body.persisted_status, 'review');
    return true;
  });
});