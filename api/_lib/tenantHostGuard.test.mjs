import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getIconnHostSlug, evaluateTenantOverride } from './tenantHostGuard.js';

test('getIconnHostSlug: {slug}.iconn.app hosts', () => {
  assert.equal(getIconnHostSlug('gfi.iconn.app'), 'gfi');
  assert.equal(getIconnHostSlug('GFI.ICONN.APP'), 'gfi');
  assert.equal(getIconnHostSlug('gfi.iconn.app:443'), 'gfi');
});

test('getIconnHostSlug: {slug}.{env}.iconn.app hosts', () => {
  assert.equal(getIconnHostSlug('gfi.dev.iconn.app'), 'gfi');
  assert.equal(getIconnHostSlug('gfi.testing.iconn.app'), 'gfi');
  assert.equal(getIconnHostSlug('gfi.preview.iconn.app'), 'gfi');
  assert.equal(getIconnHostSlug('gfi.staging.iconn.app'), 'gfi');
});

test('getIconnHostSlug: non-tenant iconn.app hosts return null', () => {
  assert.equal(getIconnHostSlug('iconn.app'), null);
  assert.equal(getIconnHostSlug('www.iconn.app'), null);
  assert.equal(getIconnHostSlug('api.iconn.app'), null);
  assert.equal(getIconnHostSlug('dev.iconn.app'), null); // env-only, no slug
  assert.equal(getIconnHostSlug('www.dev.iconn.app'), null);
  assert.equal(getIconnHostSlug('a.b.c.iconn.app'), null); // unexpected nesting
  assert.equal(getIconnHostSlug('gfi.foo.iconn.app'), null); // unknown env label
});

test('getIconnHostSlug: non-iconn hosts return null', () => {
  assert.equal(getIconnHostSlug('localhost'), null);
  assert.equal(getIconnHostSlug('localhost:5000'), null);
  assert.equal(getIconnHostSlug('127.0.0.1'), null);
  assert.equal(getIconnHostSlug('foo.replit.dev'), null);
  assert.equal(getIconnHostSlug('members.example.org'), null);
  assert.equal(getIconnHostSlug('eviliconn.app'), null); // suffix, not subdomain
  assert.equal(getIconnHostSlug(''), null);
  assert.equal(getIconnHostSlug(null), null);
});

test('wildcard host + conflicting tenant param is refused', () => {
  const r = evaluateTenantOverride('typo.iconn.app', 'real');
  assert.equal(r.hostSlug, 'typo');
  assert.equal(r.allowOverride, false);
});

test('wildcard env host + conflicting tenant param is refused', () => {
  const r = evaluateTenantOverride('fgi.dev.iconn.app', 'gfi');
  assert.equal(r.hostSlug, 'fgi');
  assert.equal(r.allowOverride, false);
});

test('wildcard host + matching tenant param is allowed', () => {
  assert.deepEqual(evaluateTenantOverride('gfi.iconn.app', 'gfi'),
    { hostSlug: 'gfi', allowOverride: true });
  assert.deepEqual(evaluateTenantOverride('gfi.dev.iconn.app', ' GFI '),
    { hostSlug: 'gfi', allowOverride: true });
});

test('wildcard host + missing tenant param is not an override', () => {
  const r = evaluateTenantOverride('gfi.iconn.app', undefined);
  assert.equal(r.hostSlug, 'gfi');
  assert.equal(r.allowOverride, false);
});

test('localhost / replit dev / custom domains keep param behaviour', () => {
  assert.deepEqual(evaluateTenantOverride('localhost:3000', 'anything'),
    { hostSlug: null, allowOverride: true });
  assert.deepEqual(evaluateTenantOverride('x.replit.dev', 'anything'),
    { hostSlug: null, allowOverride: true });
  assert.deepEqual(evaluateTenantOverride('members.example.org', 'anything'),
    { hostSlug: null, allowOverride: true });
  assert.deepEqual(evaluateTenantOverride('www.iconn.app', 'anything'),
    { hostSlug: null, allowOverride: true });
});
