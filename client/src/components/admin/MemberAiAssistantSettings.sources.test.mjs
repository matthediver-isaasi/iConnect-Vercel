import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTENT_TYPE_CONFIG } from '../../../../api/_lib/memberContentIndexer.js';
import { CONTENT_TYPES } from '../../../../api/_lib/memberContentVisibility.js';
import { MEMBER_AI_DEFAULTS } from '../../../../api/_lib/memberAiUsage.js';

const source = readFileSync(new URL('./MemberAiAssistantSettings.jsx', import.meta.url), 'utf8');
const assistant = readFileSync(new URL('../ai/MemberAiAssistant.jsx', import.meta.url), 'utf8');

test('source controls expose both page builders with the canonical iEdit type', () => {
  assert.match(source, /\["canvas_page", "Canvas pages"\]/);
  assert.match(source, /\["iedit_page", "iEdit pages"\]/);
  assert.match(source, /<MemberAiSourceSettings key=\{tenantId\} tenantId=\{tenantId\}/);
  assert.match(assistant, /iedit_page: FileText/);
});

test('UI source choices and new defaults align with the real supported indexer types', () => {
  const options = source.match(/export const MEMBER_AI_SOURCE_OPTIONS = \[([\s\S]*?)\n\];/)[1];
  const types = [...options.matchAll(/\["([^"]+)", "[^"]+"\]/g)].map(match => match[1]);
  assert.deepEqual(types, CONTENT_TYPES);
  assert.deepEqual(types, MEMBER_AI_DEFAULTS.allowed_content_types);
  assert.deepEqual([...types].sort(), Object.keys(CONTENT_TYPE_CONFIG).sort());
});

test('source settings load and save via authenticated admin API without enabling excluded types', () => {
  assert.match(source, /adminFetch\("\/api\/admin\/member-ai-settings", \{ credentials: "include" \}\)/);
  assert.match(source, /setSelected\(\[\.\.\.data\.settings\.allowed_content_types\]\)/);
  assert.doesNotMatch(source, /allowed_content_types:\s*MEMBER_AI_SOURCE_OPTIONS/);
  assert.match(source, /body: JSON\.stringify\(\{ \.\.\.settings, allowed_content_types: selected \}\)/);
  assert.match(source, /Choose at least one knowledge source/);
  assert.match(source, /disabled=\{!dirty \|\| !selected\.length \|\| saving\}/);
  assert.match(source, /Retry knowledge sources/);
});
