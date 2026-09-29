import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipConfigResolver } from './membershipConfigResolverCore.js';

const config = {
  id: 'scoped', tenant_id: 'tenant', structure_scope_type: 'organization',
  structure_field_id: 'field', structure_match_value: 'yes',
};
const forbidden = () => { throw new Error('Writes forbidden'); };
function client({ configError = null, preferenceError = null, configs = [config] } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      reads.push(table);
      const query = {
        select() { return query; }, eq() { return query; }, or() { return query; },
        order() { return query; }, in() { return query; },
        then(resolve, reject) {
          return Promise.resolve(table === 'membership_tier_config'
            ? { data: configError ? null : configs, error: configError }
            : { data: preferenceError ? null : [{ field_id: 'field', value: 'YES' }], error: preferenceError })
            .then(resolve, reject);
        },
        insert: forbidden, update: forbidden, upsert: forbidden, delete: forbidden,
      };
      return query;
    },
  };
}

test('strict organisation resolver distinguishes a failed structure read from no matching structure', async () => {
  const error = { message: 'Structures unavailable' };
  const db = client({ configError: error });
  await assert.rejects(
    createMembershipConfigResolver(db).getConfigForOrganisation('tenant', 'org', {}, '2026-01-01', { strict: true }),
    error,
  );
  assert.deepEqual(db.reads, ['membership_tier_config']);
  const empty = client({ configs: [] });
  assert.equal(await createMembershipConfigResolver(empty)
    .getConfigForOrganisation('tenant', 'org', {}, '2026-01-01', { strict: true }), null);
});

test('strict organisation resolver does not silently choose a default when scoped preferences fail', async () => {
  const error = { message: 'Preferences unavailable' };
  const db = client({ preferenceError: error, configs: [
    config, { id: 'default', tenant_id: 'tenant', structure_scope_type: 'organization' },
  ] });
  await assert.rejects(
    createMembershipConfigResolver(db).getConfigForOrganisation('tenant', 'org', {}, '2026-01-01', { strict: true }),
    error,
  );
  assert.deepEqual(db.reads, ['membership_tier_config', 'organization_preference_value']);
  const normal = client();
  assert.equal((await createMembershipConfigResolver(normal)
    .getConfigForOrganisation('tenant', 'org', {}, '2026-01-01', { strict: true })).id, 'scoped');
});