import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEmbeddedFormFrame } from './embeddedFormConsent.js';

test('only framed form embeds suppress their independent consent runtime', () => {
  const cases = [
    ['/embed/form/example', true, true],
    ['/embed/form/example/', true, true],
    ['/embed/form/example', false, false],
    ['/FormView', true, false],
    ['/some-canvas-page', true, false],
    ['/embed/event/example', true, false],
    ['/embed/form/', true, false],
  ];
  for (const [pathname, framed, expected] of cases) {
    const browser = { location: { pathname }, self: {} };
    browser.top = framed ? {} : browser.self;
    assert.equal(isEmbeddedFormFrame(browser), expected, `${pathname}, framed=${framed}`);
  }
  assert.equal(isEmbeddedFormFrame(null), false);
});
