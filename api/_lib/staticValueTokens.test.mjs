// Unit tests for the shared static-value token resolver used by both the DD
// stage-action executor and process-application.js. Run with:
//   node --test api/_lib/staticValueTokens.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticTodayToken } from './staticValueTokens.js';

const utcToday = () => {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

test('resolves {today} to current UTC date in YYYY-MM-DD format', () => {
  const result = resolveStaticTodayToken('{today}');
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result, utcToday());
});

test('match is case-insensitive', () => {
  assert.equal(resolveStaticTodayToken('{Today}'), utcToday());
  assert.equal(resolveStaticTodayToken('{TODAY}'), utcToday());
});

test('match tolerates surrounding whitespace', () => {
  assert.equal(resolveStaticTodayToken('  {today}  '), utcToday());
  assert.equal(resolveStaticTodayToken('\t{today}\n'), utcToday());
});

test('non-token strings pass through unchanged', () => {
  assert.equal(resolveStaticTodayToken('hello'), 'hello');
  assert.equal(resolveStaticTodayToken('{tomorrow}'), '{tomorrow}');
  assert.equal(resolveStaticTodayToken('today'), 'today');
  assert.equal(resolveStaticTodayToken('{today} extra'), '{today} extra');
  assert.equal(resolveStaticTodayToken(''), '');
});

test('non-string values pass through unchanged', () => {
  assert.equal(resolveStaticTodayToken(null), null);
  assert.equal(resolveStaticTodayToken(undefined), undefined);
  assert.equal(resolveStaticTodayToken(42), 42);
  assert.equal(resolveStaticTodayToken(true), true);
  const obj = { a: 1 };
  assert.equal(resolveStaticTodayToken(obj), obj);
});
