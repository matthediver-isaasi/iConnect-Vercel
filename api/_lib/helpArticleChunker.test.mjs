import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkArticleBody } from './helpArticleChunker.js';

/**
 * Parity coverage for the AI Q&A chunker (Task #2257).
 *
 * The retrieval filter IS the security boundary: a chunk must only be reachable
 * by the AI if the same reader would be allowed to SEE that text on the page.
 * The page gate lives in client/src/components/help/HelpArticleContent.jsx
 * ({{feature: KEY}} ... {{/feature}}, nestable). Here we assert the chunker
 * computes an equivalent gate set: a chunk is visible iff EVERY key in its
 * featureGates is accessible — mirroring "any enclosing denied gate hides it".
 */

// Mirror of the server-side access rule: all gates must be accessible.
function chunkVisible(chunk, canAccess) {
  return chunk.featureGates.every((g) => canAccess(g));
}

// Collect the visible text for a body under a given access predicate.
function visibleText(body, canAccess, requiredFeature = null) {
  return chunkArticleBody(body, { requiredFeature })
    .filter((c) => chunkVisible(c, canAccess))
    .map((c) => c.content)
    .join('\n');
}

test('single gate: allowed feature keeps inner content', () => {
  const body = [
    'Intro paragraph.',
    '{{feature: training.funds}}',
    'Gated step for training funds.',
    '{{/feature}}',
    'Outro paragraph.',
  ].join('\n');

  const text = visibleText(body, (k) => k === 'training.funds');
  assert.ok(text.includes('Intro paragraph.'));
  assert.ok(text.includes('Gated step for training funds.'));
  assert.ok(text.includes('Outro paragraph.'));
});

test('single gate: denied feature hides inner content only', () => {
  const body = [
    'Intro paragraph.',
    '{{feature: training.funds}}',
    'Gated step for training funds.',
    '{{/feature}}',
    'Outro paragraph.',
  ].join('\n');

  const text = visibleText(body, () => false);
  assert.ok(text.includes('Intro paragraph.'));
  assert.ok(!text.includes('Gated step for training funds.'));
  assert.ok(text.includes('Outro paragraph.'));
});

test('denied gate drops gated heading and body', () => {
  const body = [
    '{{feature: training.funds}}',
    '## Training Fund Steps',
    '- Do the thing',
    '{{/feature}}',
    'Always visible.',
  ].join('\n');

  const text = visibleText(body, () => false);
  assert.ok(!text.includes('Training Fund Steps'));
  assert.ok(!text.includes('Do the thing'));
  assert.ok(text.includes('Always visible.'));
});

test('nested gates: outer denied hides inner allowed content', () => {
  const body = [
    '{{feature: outer.key}}',
    'Outer content.',
    '{{feature: inner.key}}',
    'Inner content.',
    '{{/feature}}',
    'More outer content.',
    '{{/feature}}',
    'After both.',
  ].join('\n');

  const text = visibleText(body, (k) => k === 'inner.key');
  assert.ok(!text.includes('Outer content.'));
  assert.ok(!text.includes('Inner content.'));
  assert.ok(!text.includes('More outer content.'));
  assert.ok(text.includes('After both.'));
});

test('nested gates: outer allowed, inner denied hides inner only', () => {
  const body = [
    '{{feature: outer.key}}',
    'Outer content.',
    '{{feature: inner.key}}',
    'Inner content.',
    '{{/feature}}',
    'More outer content.',
    '{{/feature}}',
    'After both.',
  ].join('\n');

  const text = visibleText(body, (k) => k === 'outer.key');
  assert.ok(text.includes('Outer content.'));
  assert.ok(!text.includes('Inner content.'));
  assert.ok(text.includes('More outer content.'));
  assert.ok(text.includes('After both.'));
});

test('nested gates: both allowed shows all content', () => {
  const body = [
    '{{feature: outer.key}}',
    'Outer content.',
    '{{feature: inner.key}}',
    'Inner content.',
    '{{/feature}}',
    'More outer content.',
    '{{/feature}}',
  ].join('\n');

  const text = visibleText(body, () => true);
  assert.ok(text.includes('Outer content.'));
  assert.ok(text.includes('Inner content.'));
  assert.ok(text.includes('More outer content.'));
});

test('unclosed marker: denied gate suppresses rest of article', () => {
  const body = [
    'Visible intro.',
    '{{feature: training.funds}}',
    'Gated tail with no close.',
    'Still gated.',
  ].join('\n');

  const text = visibleText(body, () => false);
  assert.ok(text.includes('Visible intro.'));
  assert.ok(!text.includes('Gated tail with no close.'));
  assert.ok(!text.includes('Still gated.'));
});

test('unclosed marker: allowed gate keeps rest of article', () => {
  const body = [
    'Visible intro.',
    '{{feature: training.funds}}',
    'Gated tail with no close.',
  ].join('\n');

  const text = visibleText(body, () => true);
  assert.ok(text.includes('Visible intro.'));
  assert.ok(text.includes('Gated tail with no close.'));
});

test('stray close marker: does not leak marker text and keeps content', () => {
  const body = ['Some content.', '{{/feature}}', 'More content.'].join('\n');
  const chunks = chunkArticleBody(body, {});
  const all = chunks.map((c) => c.content).join('\n');
  assert.ok(all.includes('Some content.'));
  assert.ok(all.includes('More content.'));
  assert.ok(!all.includes('{{'));
});

test('feature markers never leak into chunk content', () => {
  const body = [
    '{{feature: some.key}}',
    'Gated content.',
    '{{/feature}}',
    'Ungated content.',
  ].join('\n');

  const all = chunkArticleBody(body, {}).map((c) => c.content).join('\n');
  assert.ok(!all.includes('{{feature'));
  assert.ok(!all.includes('{{/feature'));
  assert.ok(!all.includes('feature: some.key'));
});

test('article required_feature gates every chunk', () => {
  const body = [
    'Public-looking intro.',
    '{{feature: inner.key}}',
    'Inner content.',
    '{{/feature}}',
  ].join('\n');

  // required_feature denied => nothing is retrievable, even ungated sections.
  const denied = visibleText(body, () => false, 'support.help');
  assert.equal(denied, '');

  // required_feature allowed, inner denied => only inner hidden.
  const partial = visibleText(body, (k) => k === 'support.help', 'support.help');
  assert.ok(partial.includes('Public-looking intro.'));
  assert.ok(!partial.includes('Inner content.'));

  // every chunk carries the required_feature gate.
  const chunks = chunkArticleBody(body, { requiredFeature: 'support.help' });
  assert.ok(chunks.length > 0);
  for (const c of chunks) {
    assert.ok(c.featureGates.includes('support.help'));
  }
});

test('empty-key gate does not add a gate but preserves nesting', () => {
  const body = [
    '{{feature:}}',
    'Un-keyed gated content.',
    '{{feature: real.key}}',
    'Keyed inner content.',
    '{{/feature}}',
    '{{/feature}}',
    'After.',
  ].join('\n');

  // Un-keyed gate contributes nothing, so its content is always visible.
  const chunks = chunkArticleBody(body, {});
  const unkeyed = chunks.find((c) => c.content.includes('Un-keyed gated content.'));
  assert.ok(unkeyed);
  assert.deepEqual(unkeyed.featureGates, []);

  // Inner keyed content still gated only by real.key (nesting depth intact).
  const inner = chunks.find((c) => c.content.includes('Keyed inner content.'));
  assert.ok(inner);
  assert.deepEqual(inner.featureGates, ['real.key']);
});
