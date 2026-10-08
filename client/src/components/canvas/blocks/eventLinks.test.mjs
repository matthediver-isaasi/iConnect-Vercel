import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./dynamicBlocks.jsx', import.meta.url), 'utf8');

test('Canvas event list, card and carousel link to EventDetails by ID, not slug', () => {
  const links = [...source.matchAll(/href=\{asEditor \? undefined : (`\/EventDetails\?id=\$\{encodeURIComponent\((e|event)\.id\)\}`)\}/g)];
  assert.equal(links.length, 3);
  for (const [, expression, variable] of links) {
    const href = new Function(variable, `return ${expression};`);
    assert.equal(
      href({ id: '2fd9cec7-20e7-46b7-9e91-e7a62cdfad48', slug: 'different-event-slug' }),
      '/EventDetails?id=2fd9cec7-20e7-46b7-9e91-e7a62cdfad48',
    );
    assert.equal(href({ id: 'id&other=value' }), '/EventDetails?id=id%26other%3Dvalue');
  }
  assert.doesNotMatch(source, /\/Events\/\$\{/);
});
