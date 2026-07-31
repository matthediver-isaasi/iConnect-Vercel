// Task #3253 — {{set_password_url}} in membership-paid workflow emails:
// tenant-slug baseUrl fallback + raw-token strip safety net.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripUnresolvedSetPasswordToken } from './workflows.js';
import { hasSetPasswordToken } from './passwordSetupUrl.js';
import { getTenantBaseUrl } from './campaignService.js';

test('stripUnresolvedSetPasswordToken removes curly and bracket tokens', () => {
  const html = '<p>Hi {{ set_password_url }} and [[set_password_url]]</p>';
  const out = stripUnresolvedSetPasswordToken(html, 'body');
  assert.equal(out.includes('set_password_url'), false);
});

test('stripUnresolvedSetPasswordToken leaves clean strings untouched', () => {
  const html = '<p>Hello world</p>';
  assert.equal(stripUnresolvedSetPasswordToken(html, 'body'), html);
  assert.equal(stripUnresolvedSetPasswordToken('', 'body'), '');
  assert.equal(stripUnresolvedSetPasswordToken(null, 'body'), null);
});

test('hasSetPasswordToken detects tokens across subject+body inputs', () => {
  assert.equal(hasSetPasswordToken('Subject', 'Body with {{set_password_url}}'), true);
  assert.equal(hasSetPasswordToken('Subject', 'Body'), false);
});

test('getTenantBaseUrl derives slug-based URL without a request host', () => {
  const url = getTenantBaseUrl('acme');
  assert.match(url, /^https:\/\/acme\./);
});
