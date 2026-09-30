import test from 'node:test';
import assert from 'node:assert/strict';
import discovery from './event-surveys.js';
import lists from '../audience-lists.js';

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function fixture({ failure, anonymous = false } = {}) {
  const calls = [];
  const rows = {
    event_survey_assignment: ['event', 'complex_event'].map((type, i) => ({
      id: `a${i}`, tenant_id: 'tenant', form_id: 'survey', event_type: type,
      [type === 'event' ? 'event_id' : 'complex_event_id']: `e${i}`,
      status: 'archived', created_date: '2026-01-01', survey_version_id: 'v', token: 'must-not-leak',
    })),
    event: [{ id: 'e0', tenant_id: 'tenant', title: 'Simple' }],
    complex_event: [{ id: 'e1', tenant_id: 'tenant', title: 'Complex' }],
    form: [{ id: 'survey', tenant_id: 'tenant', name: 'Reusable Feedback', form_type: 'survey', survey_settings: { current_version: 1 } }],
    survey_version: [{ id: 'v', tenant_id: 'tenant', form_id: 'survey', version_number: 1, survey_settings: { response_identity: anonymous ? 'anonymous' : 'identified' } }],
  };
  rows.event_survey_assignment.push({ ...rows.event_survey_assignment[0], id: 'foreign', tenant_id: 'other' });
  const db = { from(table) {
    calls.push(table); const filters = []; let single = false; let start = 0; let end = Infinity; let saved;
    const q = {
      select() { return q; }, eq(key, value) { filters.push([key, value]); return q; },
      order() { return q; }, range(a, b) { start = a; end = b; return q; },
      maybeSingle() { single = true; return q; },
      insert(payload) { saved = payload; return q; }, update(payload) { saved = payload; return q; },
      single() { single = true; return q; },
      then(resolve) {
        const data = (rows[table] || []).filter(r => filters.every(([key, value]) => r[key] === value)).slice(start, end + 1);
        return Promise.resolve({ data: saved || (single ? data[0] : data), error: table === failure ? new Error('Unavailable') : null }).then(resolve);
      },
    };
    return q;
  } };
  return { rows, calls, deps: { supabase: db, getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant' }), hasAdminAccess: async () => true } };
}
test('discovery requires GET and tenant admin authorization before DB reads', async () => {
  for (const [method, auth, admin, expected] of [['POST', true, true, 405], ['GET', false, true, 401], ['GET', true, false, 403]]) {
    const { deps, calls } = fixture();
    deps.getTenantContext = async () => ({ isAuthenticated: auth, tenantId: 'tenant' });
    deps.hasAdminAccess = async () => admin;
    const res = response();
    await discovery({ method }, res, deps);
    assert.equal(res.statusCode, expected);
    assert.equal(calls.length, 0);
  }
});
test('event discovery includes simple and complex assignments; scoped discovery returns only safe readable metadata', async () => {
  const { deps } = fixture();
  let res = response();
  await discovery({ method: 'GET', query: {} }, res, deps);
  assert.deepEqual(res.body.map(e => e.event_type), ['event', 'complex_event']);
  for (const [event_type, event_id] of [['event', 'e0'], ['complex_event', 'e1']]) {
    res = response();
    await discovery({ method: 'GET', query: { event_type, event_id } }, res, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].survey_name, 'Reusable Feedback');
    assert.equal(res.body[0].supported, true);
    assert.deepEqual(Object.keys(res.body[0]).sort(), ['id', 'form_id', 'survey_name', 'event_id', 'event_type', 'event_title', 'status', 'created_date', 'supported', 'unsupported_reason', 'no_response_supported', 'no_response_unsupported_reason'].sort());
    assert.ok(!JSON.stringify(res.body).includes('must-not-leak'));
  }
});
test('discovery represents unsupported policies and policy load failures explicitly', async () => {
  for (const options of [{ anonymous: true }, { failure: 'survey_version' }, { failure: 'form_submission' }]) {
    const { deps } = fixture(options); const res = response();
    await discovery({ method: 'GET', query: { event_id: 'e0', event_type: 'event' } }, res, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body[0].supported, false);
    assert.ok(res.body[0].unsupported_reason);
  }
});
test('discovery handles empty scope, invalid parameters and failed assignments without a silent fallback', async () => {
  for (const [query, expected] of [[{ event_id: 'e0' }, 400], [{ event_id: 'e0', event_type: 'wrong' }, 400], [{ event_id: 'foreign', event_type: 'event' }, 200]]) {
    const { deps } = fixture(); const res = response();
    await discovery({ method: 'GET', query }, res, deps);
    assert.equal(res.statusCode, expected);
    if (expected === 200) assert.deepEqual(res.body, []);
  }
  const { deps } = fixture({ failure: 'event_survey_assignment' }); const res = response();
  await discovery({ method: 'GET', query: {} }, res, deps);
  assert.equal(res.statusCode, 500);
});
test('POST and PATCH reject unsafe survey scopes before any persistence operation', async () => {
  for (const method of ['POST', 'PATCH']) {
    for (const change of [{}, { survey_assignment_id: 'stale' }, { survey_assignment_id: 'a0', event_id: 'e1' }]) {
      const { deps, calls } = fixture(); const res = response();
      await lists({ method, body: { id: 'list', name: 'Survey', target_audiences: [{ type: 'event_form', form_id: 'survey', received: false, ...change }] } }, res, deps);
      assert.equal(res.statusCode, 500);
      assert.ok(!calls.includes('audience_list'));
    }
  }
});
test('save and discovery allow positively evidenced Responded but reject incomplete anonymous No response', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const method of ['POST', 'PATCH']) {
    for (const received of [true, false]) {
      const { deps, calls, rows } = fixture();
      rows.survey_version[0].survey_settings = { response_identity: 'anonymous', anonymous_completion_version: 1 };
      rows.form_submission = ['known-response', 'public-response'].map(id => ({
        id, tenant_id: 'tenant', form_id: 'survey', survey_assignment_id: 'a0', survey_version_id: 'v', is_anonymous: true,
      }));
      rows.survey_completion = [{ id: 'known', tenant_id: 'tenant', form_id: 'survey', assignment_id: 'a0', recipient_email: 'known@example.test' }];
      const res = response();
      await lists({ method, body: { id: 'list', name: 'Survey', target_audiences: [{
        type: 'event_form', form_id: 'survey', survey_assignment_id: 'a0', received,
      }] } }, res, deps);
      if (received) {
        assert.equal(res.statusCode, method === 'POST' ? 201 : 200);
        assert.equal(res.body.target_audiences[0].received, true);
      } else {
        assert.equal(res.statusCode, 500);
        assert.match(res.body.error, /completeness guarantee/);
        assert.ok(!calls.includes('audience_list'));
      }
      const discover = response();
      await discovery({ method: 'GET', query: { event_id: 'e0', event_type: 'event' } }, discover, deps);
      assert.equal(discover.body[0].supported, true);
      assert.equal(discover.body[0].unsupported_reason, null);
      assert.equal(discover.body[0].no_response_supported, false);
      assert.match(discover.body[0].no_response_unsupported_reason, /completeness guarantee/);
    }
  }
});