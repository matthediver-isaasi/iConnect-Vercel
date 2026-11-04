import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCompletion, INPUT, SOURCE_SHA, strictDate, completionReport, HEADERS } from './bnms-completion-proposal.mjs';
import { TENANT_ID, readAll } from './bnms-final-resources-proposal.mjs';
import { readOnlyFetch } from './prepare-bnms-completion.mjs';
const categories = ['Collection', 'Resource Type', 'Focus Area'].map(name => ({
  tenant_id: TENANT_ID, name, is_active: true, applies_to_content_types: ['Resources'],
  subcategories: name === 'Collection' ? ['Working in NM'] : name === 'Resource Type' ? ['Videos'] : [],
}));
const row = (values = {}, n = 2) => ({ row: n, source: { ...Object.fromEntries(HEADERS.map(h => [h, ''])),
  Reference: `REF${n}`, 'Source reference': `old.xlsx#Resources!${n}`, Title: 'A',
  'Resource URL': 'https://example.org/a', 'Member Only': 'Yes', Collection: 'Working in NM',
  'Resource Type': 'Videos', ...values }, hyperlinks: [], formulas: [] });
const build = (rows, resources = [], cats = categories) => completionReport({ rows, headers: HEADERS }, resources, cats);
test('pinned actual workbook accounts for every candidate and review column', () => {
  const w = readCompletion(readFileSync(INPUT));
  assert.equal(w.checksum, SOURCE_SHA);
  assert.equal(w.rows.length, 257);
  assert(w.rows.every(r => r.source['Ready to upload'] === '' && r.source['Team notes'] === ''));
  assert.equal(w.rows.filter(r => !r.source['Member Only']).length, 93);
  assert.equal(w.rows.filter(r => !r.source['Resource Type']).length, 91);
});
test('ambiguous dates never acquire an invented day', () => {
  for (const v of ['44174', 'Dec-20', '2025', 2025, '2025-02-30', '01/02/2025']) assert.equal(strictDate(v).kind, 'invalid');
  assert.equal(strictDate('').kind, 'blank');
  assert.equal(strictDate('2025-02-28').value, '2025-02-28');
  assert.equal(strictDate(46002).value, '2025-12-11');
});
test('safe subset remains unapproved; blank fields and every restriction preserved', () => {
  const old = { id: 'a', tenant_id: TENANT_ID, title: 'Old', target_url: 'https://example.org/a',
    is_public: false, allowed_role_ids: ['role'], member_group_id: 'g', subcategories: ['Unrelated'],
    release_date: '2024-01-01', description: 'Keep', status: 'draft', tags: ['keep'] };
  const r = build([row()], [old]);
  assert.equal(r.summary.update, 1);
  for (const k of ['is_public', 'allowed_role_ids', 'member_group_id', 'release_date', 'description', 'status', 'tags'])
    assert.deepEqual(r.rows[0].proposed[k], old[k]);
  assert(r.rows[0].proposed.subcategories.includes('Unrelated'));
  assert(r.safeSubset[0].approvalRequired);
  const held = build([row({ 'Member Only': '' })], [old]);
  assert.equal(held.summary.blocked, 1);
  assert.equal(held.rows[0].proposed.is_public, false);
  assert.equal(build([row({ 'Member Only': 'No' })], [old]).rows[0].accessDecision.held, true);
});
test('duplicates exclude review metadata, unknown taxonomy and title matches block', () => {
  const dup = build([row(), row({}, 3)]);
  assert.equal(dup.summary.blocked, 2);
  assert.equal(dup.summary.verifiedIdentities, 1);
  assert(dup.rows[0].issues.includes('identical_source_duplicate_review'));
  assert.equal(build([row({ Collection: 'Unknown' })]).summary.blocked, 1);
  assert.equal(build([row()], [{ tenant_id: TENANT_ID, id: 'a', title: 'A', target_url: 'https://other.org' }]).summary.blocked, 1);
  assert.equal(build([row({ 'Resource URL': 'example.org/a' })]).summary.blocked, 1);
});
test('transport refuses mutations, foreign hosts and unscoped reads before fetch', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.throws(() => readOnlyFetch('https://example.org', { method }), /refused/);
  assert.throws(() => readOnlyFetch('https://example.org'), /Foreign/);
  assert.throws(() => readOnlyFetch('https://lvmzliemqnieeoruhkik.supabase.co/rest/v1/resource'), /Tenant filter/);
});
test('pagination stops on unstable counts or premature empty pages', async () => {
  const client = { from() { return this; }, select() { return this; }, eq() { return this; }, order() { return this; },
    async range() { return { data: [], count: 1200, error: null }; } };
  await assert.rejects(readAll(client, 'resource', '*'), /premature/);
});
