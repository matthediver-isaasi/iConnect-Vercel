// Task #2363 — unit tests for the Member AI Knowledge Assistant visibility
// boundary. The retrieval filter IS the security boundary, so these assertions
// guard against a member (or another tenant) ever seeing a chunk they should
// not. Run with: node --test api/_lib/memberContentVisibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChunkVisibleToMember,
  CONTENT_TYPES,
} from './memberContentVisibility.js';

const TENANT = 'tenant-1';
const memberCtx = (over = {}) => ({
  isAdmin: false,
  roleId: 'role-1',
  groupIds: new Set(['group-1']),
  canAccessFeature: () => true,
  tenantId: TENANT,
  now: new Date('2026-07-06T00:00:00Z'),
  ...over,
});

test('CONTENT_TYPES covers the member content kinds', () => {
  assert.deepEqual(CONTENT_TYPES, [
    'resource',
    'event',
    'complex_event',
    'news_post',
    'blog_post',
    'canvas_page',
  ]);
});

test('null chunk is never visible', () => {
  assert.equal(isChunkVisibleToMember(null, memberCtx()), false);
});

test('cross-tenant chunk is never visible (defence in depth)', () => {
  const chunk = {
    tenant_id: 'other-tenant',
    content_type: 'blog_post',
    status: 'published',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});

test('feature-key RBAC gate blocks disallowed features', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'blog_post',
    status: 'published',
    feature_key: 'content.articles',
  };
  assert.equal(
    isChunkVisibleToMember(
      chunk,
      memberCtx({ canAccessFeature: (k) => k !== 'content.articles' })
    ),
    false
  );
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), true);
});

test('resource: only active status is visible', () => {
  const base = { tenant_id: TENANT, content_type: 'resource' };
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'active' }, memberCtx()),
    true
  );
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'draft' }, memberCtx()),
    false
  );
});

test('resource: group-restricted hidden unless member is in the group', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'resource',
    status: 'active',
    member_group_id: 'group-9',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
  assert.equal(
    isChunkVisibleToMember(
      chunk,
      memberCtx({ groupIds: new Set(['group-9']) })
    ),
    true
  );
});

test('resource: role-restricted hidden unless member holds an allowed role', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'resource',
    status: 'active',
    allowed_role_ids: ['role-x', 'role-y'],
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
  assert.equal(
    isChunkVisibleToMember(chunk, memberCtx({ roleId: 'role-y' })),
    true
  );
});

test('resource: admin bypasses group and role gating', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'resource',
    status: 'active',
    member_group_id: 'group-9',
    allowed_role_ids: ['role-x'],
  };
  assert.equal(
    isChunkVisibleToMember(chunk, memberCtx({ isAdmin: true, roleId: null })),
    true
  );
});

test('event: draft event_state is never visible', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'event',
    status: 'published',
    event_state: 'draft',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});

test('event: unpublished status hidden', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'event',
    status: 'cancelled',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});

test('event: published, tbc, and immediate are visible', () => {
  for (const status of ['published', 'tbc', 'immediate']) {
    const chunk = { tenant_id: TENANT, content_type: 'event', status };
    assert.equal(isChunkVisibleToMember(chunk, memberCtx()), true);
  }
});

test('event: group-private hidden unless in group or group_event_public', () => {
  const base = {
    tenant_id: TENANT,
    content_type: 'event',
    status: 'published',
    member_group_id: 'group-9',
  };
  assert.equal(isChunkVisibleToMember(base, memberCtx()), false);
  assert.equal(
    isChunkVisibleToMember(
      { ...base, group_event_public: true },
      memberCtx()
    ),
    true
  );
  assert.equal(
    isChunkVisibleToMember(base, memberCtx({ groupIds: new Set(['group-9']) })),
    true
  );
});

test('complex_event keeps published/tbc timing and rejects immediate', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'complex_event',
    status: 'published',
    event_state: 'draft',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
  assert.equal(
    isChunkVisibleToMember(
      { ...chunk, event_state: 'live' },
      memberCtx()
    ),
    true
  );
  assert.equal(
    isChunkVisibleToMember({ ...chunk, event_state: 'active', status: 'immediate' }, memberCtx()),
    false
  );
});

test('news_post: unpublished or future-dated hidden', () => {
  const base = {
    tenant_id: TENANT,
    content_type: 'news_post',
    status: 'published',
  };
  assert.equal(isChunkVisibleToMember(base, memberCtx()), true);
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'draft' }, memberCtx()),
    false
  );
  assert.equal(
    isChunkVisibleToMember(
      { ...base, published_date: '2026-08-01T00:00:00Z' },
      memberCtx()
    ),
    false
  );
});

test('blog_post: only published visible, future publish hidden', () => {
  const base = {
    tenant_id: TENANT,
    content_type: 'blog_post',
    status: 'published',
  };
  assert.equal(isChunkVisibleToMember(base, memberCtx()), true);
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'draft' }, memberCtx()),
    false
  );
  assert.equal(
    isChunkVisibleToMember(
      { ...base, published_date: '2026-09-01T00:00:00Z' },
      memberCtx()
    ),
    false
  );
});

test('canvas_page: only published is visible', () => {
  const base = { tenant_id: TENANT, content_type: 'canvas_page' };
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'published' }, memberCtx()),
    true
  );
  assert.equal(
    isChunkVisibleToMember({ ...base, status: 'draft' }, memberCtx()),
    false
  );
});

test('canvas_page: public content is not blocked by a member feature gate', () => {
  const chunk = {
    tenant_id: TENANT,
    content_type: 'canvas_page',
    status: 'published',
    feature_key: null,
  };
  // A member who can access no features at all still sees a public page.
  assert.equal(
    isChunkVisibleToMember(chunk, memberCtx({ canAccessFeature: () => false })),
    true
  );
});

test('canvas_page: published page visible to a member with no role or groups', () => {
  const chunk = { tenant_id: TENANT, content_type: 'canvas_page', status: 'published' };
  assert.equal(
    isChunkVisibleToMember(chunk, memberCtx({ roleId: null, groupIds: new Set() })),
    true
  );
});

test('canvas_page: cross-tenant is never visible', () => {
  const chunk = {
    tenant_id: 'other-tenant',
    content_type: 'canvas_page',
    status: 'published',
  };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});

test('unknown content type is never visible', () => {
  const chunk = { tenant_id: TENANT, content_type: 'secret_thing' };
  assert.equal(isChunkVisibleToMember(chunk, memberCtx()), false);
});
