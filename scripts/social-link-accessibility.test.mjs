import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@babel/parser';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

test('shared header and footer social links have names with built-in or custom icons', async () => {
  const labels = [];
  for (const file of ['PublicHeader', 'PublicLayout']) {
    const source = readFileSync(`client/src/components/layouts/${file}.jsx`, 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
    walk(ast, (node) => {
      if (node.type !== 'JSXOpeningElement' || node.name.name !== 'a') return;
      const href = node.attributes.find((attr) => attr.name?.name === 'href');
      const expression = href?.value?.expression;
      const hrefText = expression && source.slice(expression.start, expression.end);
      if (hrefText !== 'cfg.url' && !/^socialIcons\.\w+\.url$/.test(hrefText)) return;
      const label = node.attributes.find((attr) => attr.name?.name === 'aria-label')?.value;
      assert.ok(label, `${file} ${hrefText} needs an accessible name`);
      if (label.type === 'StringLiteral') labels.push(label.value);
      else {
        for (const key of ['linkedin', 'twitter', 'facebook', 'instagram', 'youtube']) {
          labels.push(runInNewContext(source.slice(label.expression.start, label.expression.end), { key }));
        }
      }
    });
  }
  assert.equal(labels.length, 10);
  assert.equal(labels.filter((label) => label === 'YouTube (opens in a new tab)').length, 2);
  const dom = new JSDOM('<!doctype html><html lang="en"><head><title>Social links</title></head><body></body></html>', { runScripts: 'outside-only' });
  try {
    for (const label of labels) {
      assert.ok(label && !label.includes('undefined'));
      for (const custom of [false, true]) {
        const link = dom.window.document.createElement('a');
        link.href = 'https://example.com/social';
        link.setAttribute('aria-label', label);
        link.innerHTML = custom ? '<span aria-hidden="true"><svg><path /></svg></span>' : '<svg><path /></svg>';
        dom.window.document.body.append(link);
      }
    }
    dom.window.eval(axe.source);
    const result = await dom.window.axe.run(dom.window.document, { runOnly: ['link-name'] });
    assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  } finally { dom.window.close(); }
});
