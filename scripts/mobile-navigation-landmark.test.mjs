import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';

test('mobile portal is a named landmark and closed controls are hidden and inert', async () => {
  const source = readFileSync('client/src/components/layouts/PublicHeader.jsx', 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  let drawer;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement' && node.openingElement.attributes.some(
      a => a.name?.name === 'aria-label' && a.value?.value === 'Mobile navigation',
    )) drawer = node;
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  }
  walk(ast);
  assert.ok(drawer);
  assert.equal(drawer.openingElement.name.name, 'nav');
  const markup = source.slice(drawer.start, drawer.end);
  assert.match(markup, /link-mobile-drawer-logo/);
  assert.match(markup, /renderMobileNavItem/);
  const attributes = drawer.openingElement.attributes;
  for (const mobileMenuOpen of [false, true]) {
    const value = name => {
      const expression = attributes.find(a => a.name?.name === name).value.expression;
      return runInNewContext(source.slice(expression.start, expression.end), { mobileMenuOpen });
    };
    assert.equal(value('aria-hidden'), !mobileMenuOpen);
    assert.equal(value('inert'), mobileMenuOpen ? undefined : '');
    assert.match(value('className'), /fixed inset-0 z-50 overflow-hidden lg:hidden/);
  }
  const dom = new JSDOM('<!doctype html><html><body><nav aria-label="Mobile navigation"><a href="/">Logo</a><a href="/contact-us">Contact</a><input aria-label="Search"></nav></body></html>', { runScripts: 'outside-only' });
  try {
    dom.window.eval(axe.source);
    const result = await dom.window.axe.run(dom.window.document, { runOnly: ['region'] });
    assert.equal(result.violations.length, 0);
  } finally { dom.window.close(); }
});
