// Regression guard: organisation-group custom field values and custom field
// DEFINITIONS have server-side authorization boundaries in the generic entity
// API — the Custom Fields page gate is client-side only. Group values are
// read-only via the generic API (writes go through the guarded upsert
// endpoint, which validates admin access plus group/field tenant-and-scope
// pairing); PreferenceField mutations require admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const handlerFiles = [
  'api/entities/[entity]/index.js',
  'api/entities/[entity]/[id].js',
];

test('generic entity API blocks all writes to organization_group_preference_value', () => {
  for (const file of handlerFiles) {
    const src = read(file);
    const gateIdx = src.indexOf("entityNorm === 'organizationgrouppreferencevalue'");
    assert.ok(gateIdx > -1, `${file} must gate organizationgrouppreferencevalue`);
    const gateBlock = src.slice(gateIdx, gateIdx + 700);
    // Writes rejected outright — the upsert endpoint is the only write path.
    assert.match(gateBlock, /req\.method !== 'GET'/, `${file}: gate must reject non-GET`);
    assert.match(gateBlock, /status\(403\)/, `${file}: gate must return 403 for writes`);
    // Reads are admin-gated (group CRM surfaces are admin-only).
    assert.match(gateBlock, /hasAdminAccess\(tenantCtx\)/, `${file}: reads must require admin`);
  }
});

test('generic entity API requires admin for PreferenceField mutations', () => {
  for (const file of handlerFiles) {
    const src = read(file);
    const gateIdx = src.indexOf("entityNorm === 'preferencefield' && req.method !== 'GET'");
    assert.ok(gateIdx > -1, `${file} must gate PreferenceField writes`);
    const gateBlock = src.slice(gateIdx, gateIdx + 500);
    assert.match(gateBlock, /hasAdminAccess\(tenantCtx\)/, `${file}: PreferenceField writes must require admin`);
    assert.match(gateBlock, /status\(403\)/, `${file}: non-admin PreferenceField writes must 403`);
  }
});

test('group value upsert endpoint enforces admin + tenant + field-scope pairing', () => {
  const src = read('api/entities/organization-group-preference-value/upsert.js');
  // Admin-only.
  assert.match(src, /hasAdminAccess/, 'upsert must check admin access');
  // Group must belong to the caller tenant.
  assert.match(src, /from\('organization_group'\)[\s\S]{0,300}tenant_id/, 'upsert must verify the group belongs to the tenant');
  // Field must belong to the tenant AND be scoped to organisation groups.
  assert.match(src, /from\('preference_field'\)[\s\S]{0,400}tenant_id/, 'upsert must verify the field belongs to the tenant');
  assert.match(src, /entity_scope[\s\S]{0,60}organization_group/, "upsert must require entity_scope='organization_group'");
  // Upsert keyed on the unique (group, field) pair.
  assert.match(src, /onConflict:\s*'organization_group_id,field_id'/, 'upsert must target the unique pair');
});
