import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAdminResetBaseUrl,
  isAdminMembership,
  selectAdminMembership,
} from './adminPasswordMembership.js';

const memberships = [
  {
    id: 'gfi-membership',
    tenant_id: 'gfi',
    role: 'owner',
    membership_type: 'owner',
    status: 'active',
    is_default: true,
  },
  {
    id: 'bnms-membership',
    tenant_id: 'bnms',
    role: 'admin',
    membership_type: 'owner',
    status: 'active',
    is_default: false,
  },
];

test('selectAdminMembership targets the tenant resolved from the request', () => {
  assert.equal(selectAdminMembership(memberships, 'bnms')?.id, 'bnms-membership');
});

test('selectAdminMembership preserves ordered fallback when no tenant is targeted', () => {
  assert.equal(selectAdminMembership(memberships)?.id, 'gfi-membership');
});

test('selectAdminMembership fails closed when the targeted membership is absent or inactive', () => {
  assert.equal(selectAdminMembership(memberships, 'missing'), null);
  assert.equal(
    selectAdminMembership([
      {
        tenant_id: 'bnms',
        role: 'admin',
        membership_type: 'owner',
        status: 'inactive',
      },
    ], 'bnms'),
    null
  );
});

test('isAdminMembership accepts current and legacy admin authority only', () => {
  assert.equal(isAdminMembership({ status: 'active', role: 'admin' }), true);
  assert.equal(isAdminMembership({ status: 'active', membership_type: 'owner' }), true);
  assert.equal(isAdminMembership({ status: 'active', role: 'member' }), false);
});

test('getAdminResetBaseUrl keeps a matching BNMS environment host', () => {
  assert.equal(
    getAdminResetBaseUrl(
      {
        headers: {
          host: 'bnms.dev.iconn.app',
          origin: 'https://attacker.example',
        },
      },
      { slug: 'bnms' }
    ),
    'https://bnms.dev.iconn.app'
  );
});

test('getAdminResetBaseUrl adds the tenant slug to a validated environment root', () => {
  assert.equal(
    getAdminResetBaseUrl(
      { headers: { host: 'dev.iconn.app' } },
      { slug: 'bnms' }
    ),
    'https://bnms.dev.iconn.app'
  );
});

test('getAdminResetBaseUrl ignores attacker-controlled origins and unrelated hosts', () => {
  assert.equal(
    getAdminResetBaseUrl(
      {
        headers: {
          host: 'attacker.example',
          origin: 'https://attacker.example',
        },
      },
      { slug: 'bnms' }
    ),
    'https://bnms.iconn.app'
  );
});

test('getAdminResetBaseUrl accepts only the tenant stored custom domain', () => {
  assert.equal(
    getAdminResetBaseUrl(
      { headers: { host: 'members.bnms.example' } },
      { slug: 'bnms', domain: 'members.bnms.example' }
    ),
    'https://members.bnms.example'
  );
  assert.equal(
    getAdminResetBaseUrl(
      { headers: { host: 'attacker.example' } },
      { slug: 'bnms', domain: 'members.bnms.example' }
    ),
    'https://bnms.iconn.app'
  );
});