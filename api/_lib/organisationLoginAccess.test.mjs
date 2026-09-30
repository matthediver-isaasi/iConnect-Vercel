import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateEffectiveOrganisationLoginAccess,
  evaluateMemberOrganisationLoginAccess,
  evaluateOrganisationLoginGate,
} from './organisationLoginGate.js';
import { isMemberSessionFenceRevoked } from './session.js';

const TENANT = 'tenant-a';

function db({ organizations = [], settings = [], members = [], preferences = [] } = {}) {
  const tables = {
    organization: organizations,
    system_settings: settings,
    member: members,
    organization_preference_value: preferences,
  };
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) {
          filters.push((row) => row?.[column] === value);
          return query;
        },
        maybeSingle: async () => ({
          data: (tables[table] || []).find((row) => filters.every((filter) => filter(row))) || null,
          error: null,
        }),
      };
      return query;
    },
  };
}

function gate(value) {
  return {
    tenant_id: TENANT,
    setting_key: 'organization_login_gate',
    setting_value: JSON.stringify({
      enabled: true,
      fieldSource: 'core',
      fieldKey: 'status',
      requiredValue: value,
    }),
  };
}

test('effective organisation access preserves independent manual and gate causes', async () => {
  const client = db({
    organizations: [{
      id: 'org-1',
      tenant_id: TENANT,
      status: 'denied',
      member_login_blocked: true,
      member_login_blocked_at: '2026-01-01T00:00:00Z',
      member_login_blocked_by: 'admin-1',
    }],
    settings: [gate('allowed')],
  });
  const result = await evaluateEffectiveOrganisationLoginAccess({
    supabase: client, tenantId: TENANT, organizationId: 'org-1',
  });
  assert.equal(result.blocked, true);
  assert.equal(result.manualBlocked, true);
  assert.equal(result.gateBlocked, true);
  assert.deepEqual(result.causes, ['manual', 'gate']);
  assert.equal(result.updatedBy, 'admin-1');
});

test('gate recovery does not clear a manual block', async () => {
  const client = db({
    organizations: [{
      id: 'org-1', tenant_id: TENANT, status: 'allowed', member_login_blocked: true,
    }],
    settings: [gate('allowed')],
  });
  const result = await evaluateEffectiveOrganisationLoginAccess({
    supabase: client, tenantId: TENANT, organizationId: 'org-1',
  });
  assert.equal(result.blocked, true);
  assert.equal(result.manualBlocked, true);
  assert.equal(result.gateBlocked, false);
  assert.deepEqual(result.causes, ['manual']);
});

test('an enabled but unresolved organisation gate fails closed, including no-organisation members', async () => {
  const client = db({ settings: [{
    tenant_id: TENANT,
    setting_key: 'organization_login_gate',
    setting_value: JSON.stringify({ enabled: true, fieldSource: 'core', fieldKey: 'unknown', requiredValue: 'x' }),
  }] });
  const result = await evaluateMemberOrganisationLoginAccess({
    supabase: client,
    tenantId: TENANT,
    member: { id: 'member-1', tenant_id: TENANT, organization_id: null },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.gateBlocked, true);
  assert.deepEqual(result.causes, ['gate']);
});

test('gate and revocation-state read failures do not silently allow member access', async () => {
  const unavailable = {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: null, error: { message: 'read unavailable' } }),
      };
      return query;
    },
  };
  const result = await evaluateOrganisationLoginGate({
    supabase: unavailable, tenantId: TENANT, organizationId: 'org-1',
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'GATE_CONFIGURATION_INVALID');
  const sessionSource = fs.readFileSync(new URL('./session.js', import.meta.url), 'utf8');
  assert.match(sessionSource, /MEMBER_SESSION_FENCE_UNAVAILABLE/);
});

test('durable member generations fence pre-block sessions after restore and targeted gate transitions', () => {
  const preBlockSession = {
    memberLoginGeneration: 4,
    organisationLoginGateGeneration: 8,
  };
  assert.equal(isMemberSessionFenceRevoked(preBlockSession, {
    memberGeneration: 5,
    gateGeneration: 8,
  }), true, 'manual block tombstone revokes an old session');
  assert.equal(isMemberSessionFenceRevoked(preBlockSession, {
    memberGeneration: 5,
    gateGeneration: 8,
  }), true, 'unblocking cannot clear a tombstone');
  assert.equal(isMemberSessionFenceRevoked({
    memberLoginGeneration: 5,
    organisationLoginGateGeneration: 8,
  }, {
    memberGeneration: 6,
    gateGeneration: 0,
  }), true, 'a targeted gate-denial transition fences the stale issue');
  assert.equal(isMemberSessionFenceRevoked({
    memberLoginGeneration: 6,
    organisationLoginGateGeneration: 8,
  }, {
    memberGeneration: 6,
    gateGeneration: 0,
  }), false, 'a fresh session at the current generations is valid');
  assert.equal(isMemberSessionFenceRevoked({
    memberLoginGeneration: 6,
    organizationLoginGeneration: 3,
  }, {
    memberGeneration: 6,
    organizationGeneration: 4,
  }), true, 'organisation generation fences members created after an initial block scan');
});

test('organisation access source wiring protects issuance, validation, promotion, and generic writes', () => {
  const sessionSource = fs.readFileSync(new URL('./session.js', import.meta.url), 'utf8');
  const entitySource = fs.readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
  const entityIndexSource = fs.readFileSync(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
  const endpointSource = fs.readFileSync(new URL('../admin/organizations/[id]/login-access.js', import.meta.url), 'utf8');
  assert.match(sessionSource, /evaluateMemberOrganisationLoginAccess/);
  assert.match(sessionSource, /tryPromoteMemberToTenantUser/);
  assert.match(sessionSource, /invalidateOrganizationMemberSessions/);
  assert.match(sessionSource, /memberLoginGeneration/);
  assert.match(sessionSource, /organizationLoginGeneration/);
  assert.match(sessionSource, /organisationLoginGateGeneration/);
  assert.match(entitySource, /Member login access can only be changed through the organisation login-access endpoint/);
  assert.match(entitySource, /targetSetting\?\.setting_key === 'organization_login_gate'/);
  const deleteBranch = entitySource.slice(entitySource.indexOf("req.method === 'DELETE'"));
  assert.match(deleteBranch, /targetSetting\?\.setting_key === 'organization_login_gate'/);
  assert.match(entityIndexSource, /sanitizedBody\.setting_key === 'organization_login_gate'/);
  assert.match(endpointSource, /hasAdminAccess/);
  assert.match(endpointSource, /eq\('tenant_id', tenantId\)/);
});