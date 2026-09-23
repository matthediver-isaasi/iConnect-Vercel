import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMemberEmailAddress, parseMemberEmailCc } from './memberEmailRecipients.mjs';

test('normalizes one plain mailbox without changing its explicit address', () => {
  assert.equal(normalizeMemberEmailAddress('  Person.Tag+mail@Example.COM  '), 'Person.Tag+mail@Example.COM');
});

test('parses comma and semicolon separated CC mailboxes in order', () => {
  assert.deepEqual(
    parseMemberEmailCc('one@example.com; Two@Example.org,three@example.net'),
    ['one@example.com', 'Two@Example.org', 'three@example.net'],
  );
  assert.deepEqual(parseMemberEmailCc('  '), []);
});

test('rejects display names, arrays, empty entries, and header injection', () => {
  for (const value of [
    ['one@example.com'],
    'Person <one@example.com>',
    'one@example.com,,two@example.com',
    ';,',
    'one@example.com\r\nBcc: victim@example.com',
  ]) {
    assert.throws(() => parseMemberEmailCc(value), Error);
  }
  for (const value of [
    'one@example.com\n',
    'one@example.com\u0000',
    '.one@example.com',
    'one.@example.com',
    'one..two@example.com',
    `${'a'.repeat(65)}@example.com`,
  ]) {
    assert.throws(() => normalizeMemberEmailAddress(value), Error);
  }
});