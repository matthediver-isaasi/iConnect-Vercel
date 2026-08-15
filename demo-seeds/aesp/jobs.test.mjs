// Behavioural tests for the AESP demo job-board seed plan.
//
// planJobPostings is pure (RNG + dates in, upsert-ready rows out), so these
// tests pin the contract the seed relies on: determinism, unique idempotency
// keys, status mix for the admin page, logo reuse from seeded orgs, member
// attribution and the reserved-domain provenance rule (job_posting has no
// is_sample column — contact_email domain + manifest are the markers).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, dateHelpers } from '../engine.mjs';
import { JOB_POSTINGS, planJobPostings } from './engagement.mjs';

const NOW = new Date('2026-08-15T12:00:00Z');

function fixtures() {
  const orgsByName = {
    'Greenstone Environmental Consulting': { id: 'org-green', name: 'Greenstone Environmental Consulting', logo_url: 'https://cdn.example/green.png' },
    'CarbonWise Consulting': { id: 'org-cw', name: 'CarbonWise Consulting', logo_url: null }, // logo not generated yet
    'Meridian Infrastructure Group': { id: 'org-mig', name: 'Meridian Infrastructure Group', logo_url: 'https://cdn.example/mig.png' },
  };
  const activeMembers = [
    { memberId: 'm1', first: 'Sarah', last: 'Mitchell', email: 'sarah.mitchell@aesp.example.com', orgName: 'Greenstone Environmental Consulting' },
    { memberId: 'm2', first: 'James', last: 'Walker', email: 'james.walker@aesp.example.com', orgName: 'Meridian Infrastructure Group' },
    { memberId: 'm3', first: 'Priya', last: 'Patel', email: 'priya.patel@aesp.example.com', orgName: 'Greenstone Environmental Consulting' },
  ];
  return { orgsByName, activeMembers };
}

const plan = () => planJobPostings({ rng: createRng('aesp-v1:jobs'), dates: dateHelpers(NOW), ...fixtures() });

test('deterministic: identical output across runs', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(plan())), JSON.parse(JSON.stringify(plan())));
});

test('idempotency keys (titles) are unique and one row per definition', () => {
  const rows = plan();
  assert.equal(rows.length, JOB_POSTINGS.length);
  const titles = rows.map((r) => r.match.title);
  assert.equal(new Set(titles).size, titles.length);
});

test('status mix covers the admin tabs: active, pending, rejected, expired-active', () => {
  const rows = plan().map((r) => r.row);
  const active = rows.filter((r) => r.status === 'active');
  const today = NOW.toISOString().slice(0, 10);
  const activeLive = active.filter((r) => r.closing_date >= today);
  const activeExpired = active.filter((r) => r.closing_date < today);
  assert.ok(activeLive.length >= 12, `expected >=12 live active postings, got ${activeLive.length}`);
  assert.ok(activeExpired.length >= 2, 'expected expired active postings for the archived tab');
  assert.ok(rows.filter((r) => r.status === 'pending_approval').length >= 2);
  assert.ok(rows.some((r) => r.status === 'rejected'));
  // Featured postings must be live actives (public board pins them first).
  const featured = rows.filter((r) => r.featured);
  assert.ok(featured.length >= 2);
  for (const f of featured) {
    assert.equal(f.status, 'active');
    assert.ok(f.closing_date >= today, 'featured posting must not be expired');
  }
});

test('company logo reused from the seeded org; missing logo stays null', () => {
  const rows = plan().map((r) => r.row);
  const green = rows.find((r) => r.company_name === 'Greenstone Environmental Consulting');
  assert.equal(green.company_logo_url, 'https://cdn.example/green.png');
  assert.equal(green.posted_by_organization_id, 'org-green');
  const cw = rows.find((r) => r.company_name === 'CarbonWise Consulting');
  assert.equal(cw.company_logo_url, null); // renders with fallback icon
  assert.equal(cw.posted_by_organization_id, 'org-cw');
});

test('member attribution when the employer has seeded members; org fallback otherwise', () => {
  const rows = plan().map((r) => r.row);
  const green = rows.find((r) => r.company_name === 'Greenstone Environmental Consulting');
  assert.equal(green.is_member_post, true);
  assert.ok(['m1', 'm3'].includes(green.posted_by_member_id));
  assert.ok(green.contact_email.endsWith('@aesp.example.com'));
  // Org known but no members in fixtures -> non-member post with recruitment contact.
  const cw = rows.find((r) => r.company_name === 'CarbonWise Consulting');
  assert.equal(cw.is_member_post, false);
  assert.equal(cw.posted_by_member_id, null);
  assert.ok(cw.contact_email.startsWith('recruitment.'));
});

test('every posting carries reserved-domain provenance and valid application target', () => {
  for (const { row } of plan()) {
    assert.ok(row.contact_email.endsWith('@aesp.example.com'), `contact_email ${row.contact_email} must be on the reserved demo domain`);
    if (row.application_method === 'email') {
      assert.ok(row.application_value.endsWith('@aesp.example.com'));
    } else {
      assert.equal(row.application_method, 'url');
      assert.ok(row.application_value.startsWith('https://careers.aesp.example.com/'));
    }
    assert.match(row.closing_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(row.expiry_date, row.closing_date);
    assert.ok(row.description.includes('<ul>'));
    assert.ok(new Date(row.created_date) < NOW);
  }
});
