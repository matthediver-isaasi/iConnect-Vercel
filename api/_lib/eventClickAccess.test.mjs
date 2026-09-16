import assert from 'node:assert/strict';
import test from 'node:test';

import { isEventCardClickVisible } from './eventClickAccess.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const base = {
  tenant_id: tenantId,
  status: 'published',
  event_state: 'active',
  member_group_id: null,
  group_event_public: false,
};

test('click ingestion accepts public event statuses but never drafts', () => {
  assert.equal(isEventCardClickVisible(base, {
    eventType: 'simple',
    tenantId,
  }), true);
  assert.equal(isEventCardClickVisible({ ...base, status: 'draft' }, {
    eventType: 'simple',
    tenantId,
  }), false);
  assert.equal(isEventCardClickVisible({ ...base, event_state: 'draft' }, {
    eventType: 'simple',
    tenantId,
  }), false);
  assert.equal(isEventCardClickVisible({ ...base, status: 'closed' }, {
    eventType: 'simple',
    tenantId,
  }), false);
});

test('private group cards require membership while public group cards allow guests', () => {
  const privateGroup = {
    ...base,
    member_group_id: 'group-1',
    pricing_config: { ticket_classes: [{ id: 'ticket-1' }] },
  };
  assert.equal(isEventCardClickVisible(privateGroup, {
    eventType: 'simple',
    tenantId,
    isAuthenticated: false,
  }), false);
  assert.equal(isEventCardClickVisible(privateGroup, {
    eventType: 'simple',
    tenantId,
    isAuthenticated: true,
    groupIds: new Set(['group-1']),
  }), true);
  assert.equal(isEventCardClickVisible({ ...privateGroup, group_event_public: true }, {
    eventType: 'simple',
    tenantId,
  }), true);
  assert.equal(isEventCardClickVisible({
    ...privateGroup,
    group_event_public: true,
    pricing_config: { ticket_classes: [] },
  }, {
    eventType: 'simple',
    tenantId,
  }), false);
});

test('complex cards enforce complex event state and tenant isolation', () => {
  assert.equal(isEventCardClickVisible(base, {
    eventType: 'complex',
    tenantId,
  }), true);
  assert.equal(isEventCardClickVisible({ ...base, event_state: 'draft' }, {
    eventType: 'complex',
    tenantId,
  }), false);
  assert.equal(isEventCardClickVisible({ ...base, event_state: 'archived' }, {
    eventType: 'complex',
    tenantId,
  }), false);
  assert.equal(isEventCardClickVisible({ ...base, tenant_id: '33333333-3333-4333-8333-333333333333' }, {
    eventType: 'complex',
    tenantId,
  }), false);
});