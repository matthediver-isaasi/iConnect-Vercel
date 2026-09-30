import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRoute = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const customFieldRoute = await readRoute('../public/custom-field/[id].js');
const organizationValuesRoute = await readRoute(
  '../public/organisation/[id]/preference-values.js',
);
const prefillMemberRoute = await readRoute('../public/form/prefill-member.js');
const prefillBookingRoute = await readRoute('../public/form/prefill-booking.js');

const PUBLIC_SCOPE_FILTER = /entity_scope\.is\.null,entity_scope\.neq\.custom_object/;

test('public custom-field lookup excludes Custom Object fields', () => {
  assert.match(customFieldRoute, PUBLIC_SCOPE_FILTER);
});

test('public organization preference values use tenant-scoped allowed field IDs', () => {
  assert.match(
    organizationValuesRoute,
    /\.from\('preference_field'\)[\s\S]*\.eq\('tenant_id', tenantId\)[\s\S]*entity_scope\.is\.null,entity_scope\.neq\.custom_object/,
  );
  assert.match(
    organizationValuesRoute,
    /\.from\('organization_preference_value'\)[\s\S]*\.in\('field_id', allowedFieldIds\)/,
  );
});

test('public member prefill values use tenant-scoped allowed field IDs', () => {
  assert.match(
    prefillMemberRoute,
    /\.from\('preference_field'\)[\s\S]*\.eq\('tenant_id', tenantId\)[\s\S]*entity_scope\.is\.null,entity_scope\.neq\.custom_object/,
  );
  assert.match(
    prefillMemberRoute,
    /\.from\('member_preference_value'\)[\s\S]*\.in\('field_id', allowedFieldIds\)/,
  );
});

test('public booking prefill filters both member and organization value reads', () => {
  assert.match(
    prefillBookingRoute,
    /\.from\('preference_field'\)[\s\S]*\.eq\('tenant_id', tenantId\)[\s\S]*entity_scope\.is\.null,entity_scope\.neq\.custom_object/,
  );
  assert.match(
    prefillBookingRoute,
    /\.from\('member_preference_value'\)[\s\S]*\.in\('field_id', memberFieldIds\)/,
  );
  assert.match(
    prefillBookingRoute,
    /\.from\('organization_preference_value'\)[\s\S]*\.in\('field_id', organizationFieldIds\)/,
  );
});