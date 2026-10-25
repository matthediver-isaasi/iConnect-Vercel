import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('./roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { jobAlertContent, jobStillOpen, jobAlertState, jobBoardEligible } = await import('./jobAlerts.js');
const { processJobAlert } = await import('./jobAlertDelivery.js');
const { handleJobAlerts } = await import('../member/job-alerts.js');

function fixture(overrides = {}) {
  const tables = {
    job_alert_settings: { enabled: true, category_id: 'category' },
    role: { excluded_features: [] },
    member_communication_preference: { is_subscribed: false },
    job_alert_prompt: null, ...overrides,
  };
  return { from(table) {
    const q = { select() { return q; }, eq() { return q; }, maybeSingle() { return Promise.resolve({ data: tables[table] }); } };
    return q;
  } };
}
const member = { id: 'member', tenant_id: 'tenant', role_id: 'role' };
test('prompt is opt-in, snoozed seven days, and never-ask survives visits', async () => {
  assert.equal((await jobAlertState(fixture(), member)).promptDue, true);
  for (const prompt of [{ never_ask: true }, { ask_after: '2099-01-01' }])
    assert.equal((await jobAlertState(fixture({ job_alert_prompt: prompt }), member)).promptDue, false);
  assert.equal((await jobAlertState(fixture({ job_alert_prompt: { ask_after: '2020-01-01' } }), member)).promptDue, true);
  assert.equal((await jobAlertState(fixture(), { ...member, communications_opted_out_all: true })).promptDue, false);
  assert.equal((await jobAlertState(fixture({ member_communication_preference: { is_subscribed: true } }), member)).promptDue, false);
});
test('disabled tenant and RBAC exclusions suppress invitation', async () => {
  assert.equal((await jobAlertState(fixture({ job_alert_settings: null }), member)).enabled, false);
  for (const excluded of ['jobs', 'jobs.job-board', 'page_JobBoard']) {
    assert.equal(await jobBoardEligible(fixture({ role: { excluded_features: [excluded] } }), member), false);
  }
  assert.equal(await jobBoardEligible(fixture(), { ...member, membership_paused: true }), false);
  assert.equal(await jobBoardEligible(fixture(), { ...member, role_id: null }), false);
  assert.equal(await jobBoardEligible(fixture(), { ...member, excluded_features: ['jobs'] }), false);
});
test('only open vacancies can send; markup and subject injection are escaped', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  assert.equal(jobStillOpen({ status: 'active', closing_date: '2026-10-25' }, now), true);
  for (const job of [{ status: 'draft' }, { status: 'active', expiry_date: '2026-10-24' },
    { status: 'active', closing_date: 'invalid' }]) assert.equal(jobStillOpen(job, now), false);
  const content = jobAlertContent({ title: '<script>\r\nbad', company_name: 'A&B' }, 'https://example.test/JobDetails?id=x&jobAlert=1');
  assert.ok(!content.subject.includes('\n'));
  assert.ok(content.html.includes('&lt;script&gt;'));
  assert.ok(content.html.includes('A&amp;B'));
  assert.ok(content.html.includes('&amp;jobAlert=1'));
});
function deliveryDb({ finalizationError = false, lostLease = false } = {}) {
  const updates = [], rpcs = [];
  return { updates, rpcs, from() {
    const q = { update(value) { updates.push(value); return q; }, eq() { return q; },
      select() { return Promise.resolve({ data: lostLease ? [] : [{ id: 'd' }] }); } };
    return q;
  }, async rpc(name, args) { rpcs.push({ name, args }); return { error: finalizationError ? new Error('DB offline') : null }; } };
}
const delivery = { id: 'd', lease_id: 'l', tenant_id: 't', attempts: 0 };
const content = { email: 'member@example.invalid', subject: 'job', html: '<p>job</p>' };
test('successful send records provider receipt and inbox atomically; no duplicate inbox side effect', async () => {
  const db = deliveryDb(); let calls = 0;
  assert.equal(await processJobAlert(db, delivery, {
    resolve: async () => content, send: async args => {
      calls++; assert.equal(args.inboxDelivery, undefined);
      return { success: true, messageId: 'provider', renderedHtml: 'rendered' };
    },
  }), 'sent');
  assert.equal(calls, 1);
  assert.equal(db.rpcs[0].args.p_html, 'rendered');
  assert.equal(db.rpcs[0].args.p_message_id, 'provider');
});
test('opt-out/closed job and lost lease never call provider', async () => {
  for (const [db, resolve] of [[deliveryDb(), async () => null], [deliveryDb({ lostLease: true }), async () => content]]) {
    await processJobAlert(db, delivery, { resolve, send: async () => assert.fail('must not send') });
  }
});
test('ambiguous provider outcome and failed finalization do not resend', async () => {
  for (const finalizationError of [false, true]) {
    const db = deliveryDb({ finalizationError }); let calls = 0;
    const result = await processJobAlert(db, delivery, { resolve: async () => content, send: async () => {
      calls++; return finalizationError ? { success: true, messageId: 'provider' } : { success: false, ambiguousEffect: true };
    } });
    assert.equal(result, 'uncertain'); assert.equal(calls, 1);
    assert.equal(db.updates.at(-1).status, 'uncertain');
  }
});
test('rate limits and transient errors do not consume genuine retry budget', async () => {
  for (const failure of [{ rateLimited: true }, { status: 503 }, { notSubmitted: true }]) {
    const db = deliveryDb();
    assert.equal(await processJobAlert(db, { ...delivery, attempts: 4 }, {
      resolve: async () => content, send: async () => ({ success: false, ...failure }),
    }), 'pending');
    assert.equal(db.updates.at(-1).attempts, 4);
  }
});
test('genuine failures eventually stop rather than retry forever', async () => {
  const db = deliveryDb();
  assert.equal(await processJobAlert(db, { ...delivery, attempts: 4 }, {
    resolve: async () => content, send: async () => ({ success: false, status: 400 }),
  }), 'failed');
});
test('member endpoint refuses guests, malformed writes, inaccessible opt-in and global override', async () => {
  for (const [actor, body, state, expected] of [
    [null, {}, {}, 401],
    [member, { action: 'subscribe', subscribed: 'true' }, { enabled: true }, 400],
    [member, { action: 'subscribe', subscribed: true }, { enabled: true, eligible: false }, 403],
    [member, { action: 'subscribe', subscribed: true }, { enabled: true, eligible: true, optedOutAll: true }, 409],
  ]) {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json() {} };
    await handleJobAlerts({ method: 'PATCH', body }, res, { db: {}, getMember: async () => actor, loadState: async () => state });
    assert.equal(res.statusCode, expected);
  }
});
