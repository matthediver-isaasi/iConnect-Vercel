import assert from 'node:assert/strict';
import test from 'node:test';
import {
  memberExportCountError,
  parseExpectedMemberExportTotal,
  shouldRejectEmptyMemberExport,
} from './memberExportContract.js';

test('legacy non-empty GET exports do not activate expected-total validation', () => {
  const expectedTotal = parseExpectedMemberExportTotal('GET', null);
  assert.equal(expectedTotal, null);
  assert.equal(memberExportCountError(expectedTotal, 925), null);
});

test('legacy empty GET exports retain their header-only CSV response', () => {
  assert.equal(shouldRejectEmptyMemberExport('GET', 0), false);
});

test('absent expected totals do not accidentally become zero', () => {
  assert.equal(parseExpectedMemberExportTotal('POST', null), null);
  assert.equal(parseExpectedMemberExportTotal('POST', undefined), null);
  assert.equal(parseExpectedMemberExportTotal('POST', ''), null);
});

test('POST exports reject mismatched and unexpectedly empty populations', () => {
  const expectedTotal = parseExpectedMemberExportTotal('POST', 925);
  assert.equal(expectedTotal, 925);
  assert.match(memberExportCountError(expectedTotal, 0), /found no members/);
  assert.match(memberExportCountError(expectedTotal, 924), /found 924 members/);
  assert.equal(memberExportCountError(expectedTotal, 925), null);
  assert.equal(shouldRejectEmptyMemberExport('POST', 0), true);
});