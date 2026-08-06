// Regression guard: training fund balances are ledger-backed and must never
// be writable through generic paths. Both workflow executors (the serverless
// api/_lib/workflows.js path AND the server/workflowEngine.ts path), the form
// field-mapping processor, and the generic entity API must all consult the
// shared protected-field helper before writing organization core fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED_ORG_BALANCE_FIELDS, isProtectedOrgBalanceField, stripProtectedOrgBalanceFields } from './protectedOrgFields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

test('helper flags exactly the ledger-backed balance columns', () => {
  assert.deepEqual([...PROTECTED_ORG_BALANCE_FIELDS], ['training_fund_balance', 'training_fund_pending_balance']);
  assert.equal(isProtectedOrgBalanceField('training_fund_balance'), true);
  assert.equal(isProtectedOrgBalanceField('training_fund_pending_balance'), true);
  assert.equal(isProtectedOrgBalanceField('name'), false);
  assert.equal(isProtectedOrgBalanceField(undefined), false);
});

test('stripProtectedOrgBalanceFields removes exactly the protected fields in place (POST + PATCH bodies)', () => {
  // Shape of a generic entity API create/update body attempting a bypass
  const body = {
    name: 'Test Org',
    website_url: 'https://example.com',
    training_fund_balance: 999,
    training_fund_pending_balance: 50,
  };
  const stripped = stripProtectedOrgBalanceFields(body);
  assert.deepEqual(stripped.sort(), ['training_fund_balance', 'training_fund_pending_balance']);
  assert.deepEqual(body, { name: 'Test Org', website_url: 'https://example.com' });

  // Bodies without protected fields are untouched
  const clean = { name: 'Clean Org' };
  assert.deepEqual(stripProtectedOrgBalanceFields(clean), []);
  assert.deepEqual(clean, { name: 'Clean Org' });

  // Explicit null/0 values are still stripped (presence is what matters)
  const zeroed = { training_fund_balance: 0, training_fund_pending_balance: null };
  assert.deepEqual(stripProtectedOrgBalanceFields(zeroed).length, 2);
  assert.deepEqual(zeroed, {});

  // Non-object inputs are safe no-ops
  assert.deepEqual(stripProtectedOrgBalanceFields(null), []);
  assert.deepEqual(stripProtectedOrgBalanceFields(undefined), []);
  assert.deepEqual(stripProtectedOrgBalanceFields('x'), []);
});

test('entity API create (POST) path strips protected fields via the shared helper', () => {
  const src = read('api/entities/[entity]/index.js');
  assert.match(src, /stripProtectedOrgBalanceFields\(sanitizedBody\)/);
  // The strip must run in the organization create branch
  const idx = src.indexOf("entityNorm === 'organization'");
  assert.ok(idx > -1, 'organization create branch exists');
  assert.ok(src.indexOf('stripProtectedOrgBalanceFields(sanitizedBody)', idx) > idx, 'strip runs in the create branch');
});

test('serverless workflow executor guards core update_field with the helper', () => {
  const src = read('api/_lib/workflows.js');
  assert.match(src, /isProtectedOrgBalanceField\(action\.config\?\.field_id\)/);
  // Guard must appear before the core-field snapshot/write logic in the file.
  const guardIdx = src.indexOf('isProtectedOrgBalanceField(action.config?.field_id)');
  const writeIdx = src.indexOf('update_field (core):', guardIdx);
  assert.ok(guardIdx > -1 && writeIdx > guardIdx, 'guard must precede the core write');
});

test('server workflowEngine executor guards core update_field with the helper', () => {
  const src = read('server/workflowEngine.ts');
  assert.match(src, /isProtectedOrgBalanceField\(config\.field_id\)/);
  const guardIdx = src.indexOf('isProtectedOrgBalanceField(config.field_id)');
  const writeIdx = src.indexOf('.update({ [config.field_id]: newValue })');
  assert.ok(guardIdx > -1 && writeIdx > guardIdx, 'guard must precede the core write');
});

test('form field-mapping processor skips protected org fields', () => {
  const src = read('api/forms/process-application.js');
  assert.match(src, /isProtectedOrgBalanceField\(target_field\)/);
});

test('generic entity API strips protected fields from Organization updates (PATCH)', () => {
  const src = read('api/entities/[entity]/[id].js');
  assert.match(src, /stripProtectedOrgBalanceFields\(sanitizedBody\)/);
});
