import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCsvBytes, deduplicate, reconcileRows, resourceIdentity,
} from './audit-bnms-resource-imports-lib.mjs';
import { readOnlyFetch } from './audit-bnms-resource-imports.mjs';

const source = (overrides = {}) => ({
  sourceFile: 'source.xlsx', sheet: 'Resources', row: 2, source: {},
  title: 'A', sourceUrl: 'https://drive.google.com/file/d/abc123/view',
  memberOnly: 'Yes', collection: '', resourceType: '', hyperlinks: [], formulas: [], ...overrides,
});

test('provider identity is conservative and stable', () => {
  assert.equal(resourceIdentity('https://drive.google.com/open?id=abc123').identity, 'drive:abc123');
  assert.equal(resourceIdentity('not a url').valid, false);
  assert.equal(resourceIdentity('https://drive.google.com/drive/folders/folder1').kind, 'shared_folder');
});

test('matching distinguishes present, mismatch, ambiguous, holds and evidenced absence', () => {
  const resources = [{
    id: '1', title: 'A', target_url: source().sourceUrl,
    is_public: false, subcategories: [],
  }];
  assert.equal(reconcileRows([source()], resources)[0].classification, 'present');
  assert.equal(reconcileRows([source({ memberOnly: 'No' })], resources)[0].classification, 'metadata_access_mismatch');
  assert.equal(reconcileRows([source()], [...resources, { ...resources[0], id: '2' }])[0].classification, 'ambiguous');
  const history = new Map([['source.xlsx', new Map([[2, { held: true }]])]]);
  assert.equal(reconcileRows([source()], [], history)[0].classification, 'intentional_hold');
  history.set('source.xlsx', new Map([[2, { executedId: 'gone' }]]));
  assert.equal(reconcileRows([source()], [], history)[0].classification, 'confirmed_absent_identity');
});

test('terminal execution supersedes an earlier hold and retains timeline', () => {
  const history = new Map([['source.xlsx', new Map([[2, {
    held: true,
    issues: ['proposal_hold'],
    executedId: 'executed-id',
    evidenceFile: 'proposal.json',
    executionEvidenceFile: 'journal.jsonl',
  }]])]]);
  const absent = reconcileRows([source()], [], history)[0];
  assert.equal(absent.classification, 'confirmed_absent_identity');
  assert.match(absent.historicalOutcome, /supersedes/);
  assert.deepEqual(absent.historicalTimeline.map((event) => event.outcome), ['held', 'executed']);
});

test('executed ID matches a present row after URL change and records metadata mismatch', () => {
  const history = new Map([['source.xlsx', new Map([[2, { executedId: 'executed-id' }]])]]);
  const row = reconcileRows([source()], [{
    id: 'executed-id',
    title: 'A',
    target_url: 'https://drive.google.com/file/d/changed/view',
    is_public: false,
    subcategories: [],
  }], history)[0];
  assert.equal(row.matchMethod, 'historical_executed_id');
  assert.equal(row.classification, 'metadata_access_mismatch');
  assert.deepEqual(row.mismatchFields.target_url, {
    source: source().sourceUrl,
    destination: 'https://drive.google.com/file/d/changed/view',
  });
  assert.equal(row.absentFromDestination, false);
});

test('executed ID disambiguates duplicate current URL identities', () => {
  const history = new Map([['source.xlsx', new Map([[2, { executedId: 'chosen' }]])]]);
  const base = {
    title: 'A', target_url: source().sourceUrl, is_public: false, subcategories: [],
  };
  const row = reconcileRows([source()], [{ id: 'other', ...base }, { id: 'chosen', ...base }], history)[0];
  assert.equal(row.classification, 'present');
  assert.deepEqual(row.candidateIds, ['chosen']);
  assert.deepEqual(row.urlIdentityCandidateIds.sort(), ['chosen', 'other']);
});

test('deduplication does not count a repeated historical hold as missing', () => {
  const rows = [
    { identity: 'drive:a', classification: 'intentional_hold', absentFromDestination: true, historicalOutcome: 'held', currentOutcome: 'absent', sourceFile: 'a', sheet: 's', row: 2, title: 'A' },
    { identity: 'drive:a', classification: 'no_execution_evidence', absentFromDestination: true, historicalOutcome: 'none', currentOutcome: 'absent', sourceFile: 'b', sheet: 's', row: 9, title: 'A' },
  ];
  assert.deepEqual(deduplicate(rows).map((row) => row.classification), ['intentional_hold']);
  assert.equal(deduplicate(rows)[0].absentFromDestination, true);
});

test('shared folders, hyperlink conflicts and formulas remain unresolved despite exact matches', () => {
  const folder = source({ sourceUrl: 'https://drive.google.com/drive/folders/folder1' });
  const folderResource = [{ id: 'f', title: 'A', target_url: folder.sourceUrl, is_public: false, subcategories: [] }];
  assert.equal(reconcileRows([folder], folderResource)[0].classification, 'ambiguous');
  const conflict = source({
    hyperlinks: [{
      header: 'Resource URL',
      cell: 'https://drive.google.com/file/d/abc123/view',
      target: 'https://drive.google.com/file/d/different/view',
    }],
  });
  assert.equal(reconcileRows([conflict], [{
    id: '1', title: 'A', target_url: conflict.sourceUrl, is_public: false, subcategories: [],
  }])[0].classification, 'ambiguous');
  assert.equal(reconcileRows([source({ formulas: [{ header: 'Title', formula: 'A1' }] })], [{
    id: '1', title: 'A', target_url: source().sourceUrl, is_public: false, subcategories: [],
  }])[0].classification, 'ambiguous');
});

test('row evidence exposes detailed mismatches, matched access context and human action', () => {
  const row = source({
    source: {
      Title: 'A',
      'Brief Description': 'new description',
      'Resource Type': 'Guidelines',
      Topic: 'Yes',
    },
    resourceType: 'Guidelines',
  });
  const result = reconcileRows([row], [{
    id: '1', title: 'A', description: 'old', target_url: row.sourceUrl,
    is_public: false, subcategories: [], allowed_role_ids: ['role'], member_group_id: 'group',
    status: 'active',
  }])[0];
  assert.equal(result.classification, 'metadata_access_mismatch');
  assert.deepEqual(Object.keys(result.mismatchFields).sort(), ['description', 'resource_type_taxonomy', 'topics']);
  assert.deepEqual(result.contextualAccessEvidence.allowed_role_ids, ['role']);
  assert.match(result.humanReason, /description/);
  assert.ok(result.recommendedNextAction);
  assert.ok(result.historicalOutcome);
  assert.ok(result.currentOutcome);
});

test('CSV decoder strictly validates UTF-8 and records Windows-1252 fallback', () => {
  assert.match(decodeCsvBytes(Buffer.from('\uFEFFa,b')).encoding, /UTF-8 BOM/);
  assert.match(decodeCsvBytes(Buffer.from([0x61, 0x2c, 0x80])).encoding, /Windows-1252/);
});

test('transport rejects every write method before network access', () => {
  assert.throws(() => readOnlyFetch('https://example.invalid', { method: 'POST' }), /refused POST/);
  assert.throws(() => readOnlyFetch('https://example.invalid', { method: 'PATCH' }), /refused PATCH/);
  assert.throws(() => readOnlyFetch('https://example.invalid', { method: 'DELETE' }), /refused DELETE/);
});