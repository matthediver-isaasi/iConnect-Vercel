import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./process-application.js', import.meta.url), 'utf8');

test('all modern application mapping paths validate and coalesce explicit fallback groups', () => {
  const validationCalls = source.match(/assertValidExplicitFallbackGroups\(/g) || [];
  const coalesceCalls = source.match(/coalesceExplicitFallbackMappings\(/g) || [];
  assert.ok(validationCalls.length >= 3, 'top-level, primary pipeline, and additional-member arrays must validate');
  assert.ok(coalesceCalls.length >= 3, 'top-level, primary pipeline, and additional-member arrays must coalesce');
});

test('additional-member identity and writes use the coalesced visible mappings', () => {
  assert.match(source, /const effectiveMemberMappings = coalesceExplicitFallbackMappings\(\s*memberConfig\.mappings,\s*form_values,\s*hiddenSubmissionFieldIds/);
  assert.match(source, /const emailMapping = effectiveMemberMappings\.find/);
  assert.match(source, /for \(const mapping of effectiveMemberMappings\)/);
  assert.match(source, /email fallback resolved to explicit clear/);
  assert.match(source, /if \(mapping\.source_type === 'clear'\) \{\s*value = '__clear__'/);
});