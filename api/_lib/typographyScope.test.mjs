import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScopedTypographyStyles } from './typographyScope.js';

const M1 = 'mmmmmmmm-1111-1111-1111-111111111111';
const M2 = 'mmmmmmmm-2222-2222-2222-222222222222';

function style(id, opts = {}) {
  return {
    id,
    style_type: opts.style_type || 'h1',
    microsite_id: opts.microsite_id ?? null,
    is_default: opts.is_default ?? false,
    is_active: opts.is_active ?? true,
    name: id,
  };
}

test('main-site scope returns only main-site styles', () => {
  const all = [
    style('main-h1', { style_type: 'h1', is_default: true }),
    style('main-p', { style_type: 'paragraph' }),
    style('ms-h1', { style_type: 'h1', microsite_id: M1, is_default: true }),
  ];
  const out = resolveScopedTypographyStyles(all, null);
  assert.deepEqual(out.map((s) => s.id).sort(), ['main-h1', 'main-p']);
  assert.equal(out.find((s) => s.id === 'main-h1').is_default, true);
});

test('inactive styles are excluded in every scope', () => {
  const all = [
    style('main-h1', { style_type: 'h1', is_default: true }),
    style('main-off', { style_type: 'h2', is_active: false }),
    style('ms-off', { style_type: 'h1', microsite_id: M1, is_active: false }),
  ];
  assert.deepEqual(resolveScopedTypographyStyles(all, null).map((s) => s.id), ['main-h1']);
  assert.deepEqual(resolveScopedTypographyStyles(all, M1).map((s) => s.id), ['main-h1']);
});

test('microsite scope includes main-site styles plus its own', () => {
  const all = [
    style('main-h1', { style_type: 'h1', is_default: true }),
    style('main-p', { style_type: 'paragraph', is_default: true }),
    style('ms-h2', { style_type: 'h2', microsite_id: M1 }),
    style('other-ms', { style_type: 'h1', microsite_id: M2, is_default: true }),
  ];
  const out = resolveScopedTypographyStyles(all, M1);
  assert.deepEqual(out.map((s) => s.id).sort(), ['main-h1', 'main-p', 'ms-h2']);
});

test('microsite default suppresses the main-site default for that style_type', () => {
  const all = [
    style('main-h1', { style_type: 'h1', is_default: true }),
    style('main-p', { style_type: 'paragraph', is_default: true }),
    style('ms-h1', { style_type: 'h1', microsite_id: M1, is_default: true }),
  ];
  const out = resolveScopedTypographyStyles(all, M1);
  const defaults = out.filter((s) => s.is_default);
  // Exactly one default per style_type: microsite h1 wins, main paragraph inherited.
  assert.deepEqual(defaults.map((s) => s.id).sort(), ['main-p', 'ms-h1']);
  assert.equal(out.find((s) => s.id === 'main-h1').is_default, false);
});

test('main-site default is inherited when the microsite defines no default for that type', () => {
  const all = [
    style('main-h1', { style_type: 'h1', is_default: true }),
    style('ms-h1-alt', { style_type: 'h1', microsite_id: M1, is_default: false }),
  ];
  const out = resolveScopedTypographyStyles(all, M1);
  assert.equal(out.find((s) => s.id === 'main-h1').is_default, true);
});

test('empty / nullish input is tolerated', () => {
  assert.deepEqual(resolveScopedTypographyStyles(null, null), []);
  assert.deepEqual(resolveScopedTypographyStyles(undefined, M1), []);
});
