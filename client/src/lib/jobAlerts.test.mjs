import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAlertsKey, communicationPreferencesKey, shouldPromptForJobAlerts, jobAlertReturnTo, isJobPostingsCategory, invalidateJobAlertPreferences } from './jobAlerts.mjs';

test('prompt fails closed for disabled, ineligible, globally opted-out and subscribed members', () => {
  const due = { enabled: true, eligible: true, promptDue: true, optedOutAll: false, subscribed: false };
  assert.equal(shouldPromptForJobAlerts(due), true);
  for (const patch of [{ enabled: false }, { eligible: false }, { promptDue: false }, { optedOutAll: true }, { subscribed: true }]) {
    assert.equal(shouldPromptForJobAlerts({ ...due, ...patch }), false);
  }
  assert.equal(shouldPromptForJobAlerts(undefined), false);
});

test('member and tenant identities both partition preferences', () => {
  assert.notDeepEqual(jobAlertsKey('a', 'm'), jobAlertsKey('b', 'm'));
  assert.notDeepEqual(jobAlertsKey('a', 'm'), jobAlertsKey('a', 'n'));
  assert.notDeepEqual(communicationPreferencesKey('a', 'm'), communicationPreferencesKey('b', 'm'));
});

test('email return target is a constructed relative job detail path, not an open redirect', () => {
  const id = 'bd975b71-a1ee-4c07-9dcc-d7db5ac10fc8';
  assert.equal(jobAlertReturnTo(`?id=${id}&jobAlert=1&returnTo=https://evil.test`), `/JobDetails?id=${id}&jobAlert=1`);
  for (const search of [`?id=${id}`, '?id=//evil.test&jobAlert=1', '?id=%2F%5Cevil.test&jobAlert=1', '?jobAlert=1']) {
    assert.equal(jobAlertReturnTo(search), null);
  }
});

test('only the canonical system key protects a category', () => {
  assert.equal(isJobPostingsCategory({ system_key: 'job_postings' }), true);
  assert.equal(isJobPostingsCategory({ name: 'Job postings' }), false);
  assert.equal(isJobPostingsCategory(null), false);
});

test('cross-surface invalidation targets job alerts in the current tenant', async () => {
  const calls = [];
  await invalidateJobAlertPreferences({ invalidateQueries: async options => calls.push(options) }, 'tenant-a');
  const predicate = calls.find(call => call.predicate).predicate;
  assert.equal(predicate({ queryKey: jobAlertsKey('tenant-a', 'm') }), true);
  assert.equal(predicate({ queryKey: jobAlertsKey('tenant-b', 'm') }), false);
  assert.ok(calls.some(call => call.queryKey?.[0] === 'my-communication-preferences'));
  assert.ok(calls.some(call => call.queryKey?.[0] === 'communication-categories'));
});
