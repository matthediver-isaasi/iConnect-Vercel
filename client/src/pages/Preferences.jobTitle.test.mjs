import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@babel/parser';

test('About-me Job Title input never supplies a placeholder', () => {
  const source = readFileSync(new URL('./Preferences.jsx', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const inputs = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXOpeningElement' && node.attributes.some(
      a => a.type === 'JSXAttribute' && a.name.name === 'id' && a.value?.value === 'jobTitle',
    )) inputs.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  assert.equal(inputs.length, 1);
  assert.ok(!inputs[0].attributes.some(a => a.name?.name === 'placeholder'));
});
