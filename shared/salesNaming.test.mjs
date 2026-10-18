import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteNamingErrors, resolveQuoteNaming, quotePath, suggestQuoteSlug, RESERVED_SALES_SEGMENTS, canonicalQuoteLink } from './salesNaming.js';

test('defaults, explicit grammar, Unicode labels and lowercase URL suggestions', () => {
  assert.deepEqual(resolveQuoteNaming(), { singular: 'Quote', plural: 'Quotes', slug: 'quotes' });
  assert.equal(suggestQuoteSlug('Sales Plans'), 'sales-plans');
  assert.equal(suggestQuoteSlug('Proposals'), 'proposals');
  assert.equal(suggestQuoteSlug('Événements'), 'evenements');
  assert.deepEqual(quoteNamingErrors({ quoteSingularName: '  提案  ', quotePluralName: '😀'.repeat(100), quoteUrlSegment: 'quotes' }), []);
  for (const slug of [...RESERVED_SALES_SEGMENTS, 'My-plans', '-plans', 'plans-', 'plans--new', 'a/b', 'a?b', '', 'é', 'quotes\n', 'a'.repeat(101)]) {
    assert.ok(quoteNamingErrors({ quoteUrlSegment: slug }).length, slug);
  }
  for (const label of ['', ' ', '😀'.repeat(101), null, 123]) assert.ok(quoteNamingErrors({ quotePluralName: label }).length);
});

test('path construction and canonicalization preserve search and fragment exactly', () => {
  const naming = { singular: 'Sales Plan', plural: 'Sales Plans', slug: 'sales-plans' };
  assert.equal(quotePath(naming, 'new'), '/sales/sales-plans/new');
  assert.equal(canonicalQuoteLink('/sales/quotes/new?opportunityId=a%26b#notes', naming), '/sales/sales-plans/new?opportunityId=a%26b#notes');
  assert.equal(canonicalQuoteLink('/sales/proposals/id?q=1#terms', naming, { slug: 'proposals' }), '/sales/sales-plans/id?q=1#terms');
  for (const path of ['/quote/token', '/api/sales/quotes', '/sales/unknown', '/sales/settings']) assert.equal(canonicalQuoteLink(path, naming), path);
});
