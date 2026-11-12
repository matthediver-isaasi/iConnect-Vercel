import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveEffectiveOrgGuestAccess } from '../api/_lib/orgGuestAccess.js';

// Exercise unchanged production functions against isolated stored-row fixtures.
const processor = readFileSync('api/forms/process-application.js', 'utf8');
const renderer = readFileSync('client/src/components/forms/FormRenderer.jsx', 'utf8');
function database(value, guest = false) {
  const rows = {
    organization: [{ id: 'org-a', name: 'Fixture', tenant_id: 'a', guest_access_enabled: guest }],
    preference_field: [
      { id: 'field-b', tenant_id: 'b', name: 'verified_domains', entity_scope: 'organization', is_active: true },
      { id: 'field-a', tenant_id: 'a', name: 'verified_domains', entity_scope: 'organization', is_active: true },
    ],
    organization_preference_value: [
      { organization_id: 'org-a', field_id: 'field-b', value: 'wrong.test' },
      { organization_id: 'org-a', field_id: 'field-a', value },
      { organization_id: 'org-b', field_id: 'field-a', value: 'wrong-org.test' },
    ],
    system_settings: [{ tenant_id: 'a', setting_key: 'guest_access', setting_value: JSON.stringify({ enabled: guest, default_period_days: 30 }) }],
  };
  return { from(table) {
    let result = rows[table];
    return { select() { return this; }, eq(key, val) { result = result.filter(r => r[key] === val); return this; },
      async maybeSingle() { assert.ok(result.length <= 1); return { data: result[0] || null, error: null }; },
      async single() { return this.maybeSingle(); } };
  } };
}
const backend = vm.runInNewContext(`(function() {
  ${processor.slice(processor.indexOf('const loadOrgVerifiedDomains ='), processor.indexOf('// Helper function to check role capacity'))}
  return {loadOrgVerifiedDomains,resolveDomainGuestContext};
})()`, { resolveEffectiveOrgGuestAccess, console, Date });

function validate(email, domains, guests) {
  let valid, error;
  const context = {
    field: { id: 'email', validate_org_domain: true },
    organizationInfo: { name: 'Fixture', verified_domains: domains },
    selectedOrgGuestAccess: { accepts_guests: guests, default_period_days: 30 },
    domainErrorRef: { current: '' }, emailFormatErrorRef: { current: '' },
    setDomainError: e => { error = e; }, setDomainInfoMessage() {},
    onValidityChange: (_, v) => { valid = v; },
  };
  vm.runInNewContext(`${renderer.slice(renderer.indexOf('  const validateEmailDomain ='), renderer.indexOf('  const organizationSourceAnswers ='))}; validateEmailDomain(${JSON.stringify(email)});`, context);
  return { valid, error };
}

for (const value of [['example.test'], '["example.test"]', 'example.test, other.test']) {
  test(`saved domains resolve through public/backend lookup: ${JSON.stringify(value)}`, async () => {
    const db = database(value);
    const domains = await backend.loadOrgVerifiedDomains(db, 'org-a', 'a');
    assert.equal(domains[0], 'example.test');
    assert.ok(!domains.includes('wrong.test'));
    let body;
    const source = readFileSync('api/public/organisation/[id]/domains.js', 'utf8')
      .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
    const handler = vm.runInNewContext(`${source}; handler`, {
      createClient: () => db, resolveEffectiveOrgGuestAccess, console,
      process: { env: { SUPABASE_URL: 'fixture', SUPABASE_SERVICE_KEY: 'fixture' } },
    });
    await handler({ method: 'GET', query: { id: 'org-a' } }, { json(v) { body = v; }, status() { return this; } });
    assert.equal(body.verified_domains[0], 'example.test');
    assert.equal(validate('member@EXAMPLE.TEST', body.verified_domains, false).valid, true);
    assert.equal(validate('member@wrong.test', body.verified_domains, false).valid, false);
    assert.equal(validate('member@wrong.test', body.verified_domains, true).valid, true);
    assert.equal((await backend.resolveDomainGuestContext(db, 'org-a', 'member@example.test')).domainMatches, true);
    assert.equal((await backend.resolveDomainGuestContext(db, 'org-a', 'member@wrong.test')).guestStamp, null);
    assert.equal((await backend.resolveDomainGuestContext(database(value, true), 'org-a', 'member@wrong.test')).guestStamp.is_guest, true);
  });
}
test('empty domains preserve rejection and guest exception', () => {
  assert.equal(validate('member@example.test', [], false).valid, false);
  assert.equal(validate('member@example.test', [], true).valid, true);
});

test('existing admin layout exposes the field without rewriting saved cards', () => {
  const source = readFileSync('client/src/hooks/useOrgDetailLayout.js', 'utf8');
  const merge = vm.runInNewContext(source.slice(source.indexOf('export function mergeLayoutWithCustomFields'))
    .replace('export function', 'function') + '; mergeLayoutWithCustomFields');
  const layout = { cards: [{ id: 'card-details', title: 'Details', columns: 2, fields: [{ id: 'core:name', type: 'core' }] }] };
  const before = JSON.stringify(layout);
  const result = merge(layout, [{ id: 'verified-field' }]);
  assert.equal(JSON.stringify(layout), before);
  assert.equal(result.cards[1].title, 'Custom Fields');
  assert.equal(result.cards[1].fields[0].fieldId, 'verified-field');
});
