import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('stage transitions receive a dedicated execution budget before the general API rule', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const rules = Object.keys(config.functions);
  const endpoint = 'api/due-diligence/update-status.js';
  assert.equal(config.functions[endpoint].maxDuration, 300);
  assert.ok(rules.indexOf(endpoint) < rules.indexOf('api/**/*.js'));
  assert.equal(config.functions['api/**/*.js'].maxDuration, 60);
});