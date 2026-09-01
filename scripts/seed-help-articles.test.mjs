import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkArticleBody } from '../api/_lib/helpArticleChunker.js';
import { ARTICLES } from './seed-help-articles.mjs';

const bySlug = new Map(ARTICLES.map((article) => [article.slug, article]));
const canonicalGates = new Set([
  'crm.organisations',
  'forms.submissions',
  'commerce.membership',
  'commerce.membership.pay-online',
  'commerce.membership.submit-po',
  'membership.organisation-directory',
  'organisation.my-organisation',
  'events.browse-events',
  'membership.team',
  'membership.team.invite-member',
]);

function article(slug) {
  const value = bySlug.get(slug);
  assert.ok(value, `missing seeded article ${slug}`);
  return value;
}

function markerGates(body) {
  return [...body.matchAll(/\{\{feature:\s*([^}]+)\}\}/g)].map((match) => match[1].trim());
}

test('partner onboarding guides have stable global publication metadata', () => {
  const admin = article('organisation-onboarding-for-administrators');
  const contact = article('getting-started-organisation-contact');

  assert.equal(admin.status, 'published');
  assert.equal(admin.required_feature, 'crm.organisations');
  assert.equal(contact.status, 'published');
  assert.equal(contact.required_feature, 'organisation.my-organisation');
  assert.notEqual(admin.sort_order, contact.sort_order);
});

test('partner onboarding guides use canonical gates and index cleanly', () => {
  for (const guide of [
    article('organisation-onboarding-for-administrators'),
    article('getting-started-organisation-contact'),
  ]) {
    for (const gate of [guide.required_feature, ...markerGates(guide.body)]) {
      assert.ok(canonicalGates.has(gate), `unexpected feature gate ${gate}`);
    }

    const chunks = chunkArticleBody(guide.body, {
      requiredFeature: guide.required_feature,
    });
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((chunk) => chunk.featureGates.includes(guide.required_feature)));
    assert.ok(chunks.every((chunk) => !chunk.content.includes('{{feature:')));
  }
});

test('partner onboarding copy stays tenant-neutral and includes required guidance', () => {
  const admin = article('organisation-onboarding-for-administrators');
  const contact = article('getting-started-organisation-contact');
  const combined = `${admin.body}\n${contact.body}`;

  for (const tenantSpecificClaim of [
    'GFI',
    'Partner Enquiry Form',
    'Partner Full Application',
    '1 August',
    '31 July',
    'up to two additional',
    'Live – Click Review and send',
  ]) {
    assert.ok(!combined.includes(tenantSpecificClaim), `tenant-specific claim leaked: ${tenantSpecificClaim}`);
  }

  assert.match(admin.body, /Before you start/);
  assert.match(admin.body, /Decision:/);
  assert.match(admin.body, /Expected outcome:/);
  assert.match(admin.body, /Troubleshooting/);
  assert.match(contact.body, /Before you start/);
  assert.match(contact.body, /What success looks like/);
  assert.match(contact.body, /Troubleshooting/);
  assert.match(combined, /\{\{screenshot:/);
  assert.match(admin.body, /\/help\/forms-managing-submissions/);
  assert.match(contact.body, /\/help\/getting-started/);
});