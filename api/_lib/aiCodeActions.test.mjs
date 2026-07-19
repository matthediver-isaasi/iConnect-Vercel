// Tests for AI Design Studio V2 Phase 2 (Task #2906): the action system
// (external URL validation, canonical hrefs, hint resolution, editor-picked
// resolution, publish gate) and the slot system (trusted block mapping).
// Pure — all lookups are injected, no DB or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExternalUrl,
  buildActionHref,
  resolveCodeActions,
  resolveActionWithTarget,
  unresolvedActionKeys,
  assessAiCodePublishGate,
} from './aiCodeActions.js';
import { resolveCodeSlots } from './aiCodeSlots.js';

// ---------------------------------------------------------------------------
// validateExternalUrl
// ---------------------------------------------------------------------------

test('validateExternalUrl accepts a normal https URL', () => {
  const v = validateExternalUrl('https://example.org/page?x=1');
  assert.equal(v.ok, true);
  assert.match(v.url, /^https:\/\/example\.org\//);
});

test('validateExternalUrl rejects http, javascript, credentials and junk', () => {
  assert.equal(validateExternalUrl('http://example.org').ok, false);
  assert.equal(validateExternalUrl('javascript:alert(1)').ok, false);
  assert.equal(validateExternalUrl('https://user:pw@example.org').ok, false);
  assert.equal(validateExternalUrl('not a url').ok, false);
  assert.equal(validateExternalUrl('').ok, false);
  assert.equal(validateExternalUrl(`https://example.org/${'a'.repeat(2100)}`).ok, false);
  assert.equal(validateExternalUrl('https://localhost').ok, false); // no dot in host
});

// ---------------------------------------------------------------------------
// buildActionHref — canonical in-app URLs (mirrors V1 aicLinkHref)
// ---------------------------------------------------------------------------

test('buildActionHref builds the canonical href per action type', () => {
  assert.equal(buildActionHref({ type: 'anchor', anchorId: 'join-us' }), '#join-us');
  assert.equal(buildActionHref({ type: 'email', address: 'hi@example.org' }), 'mailto:hi@example.org');
  assert.equal(buildActionHref({ type: 'tel', number: '+44 20 1234 567' }), 'tel:+44201234567');
  assert.equal(buildActionHref({ type: 'internal_page', slug: 'about-us' }), '/about-us');
  assert.equal(buildActionHref({ type: 'event', recordId: 'abc-123' }), '/EventDetails?id=abc-123');
  assert.equal(buildActionHref({ type: 'event_registration', recordId: 'abc-123' }), '/EventDetails?id=abc-123&register=1');
  assert.equal(buildActionHref({ type: 'form', slug: 'contact' }), '/FormView?slug=contact');
  assert.equal(buildActionHref({ type: 'membership_application', recordId: 't1' }), '/MembershipApplication?tier=t1');
  assert.equal(buildActionHref({ type: 'membership_application' }), '/MembershipApplication');
  assert.equal(buildActionHref({ type: 'document', fileUrl: 'https://x.example/f.pdf' }), 'https://x.example/f.pdf');
});

test('buildActionHref refuses malformed identifiers', () => {
  assert.equal(buildActionHref({ type: 'internal_page', slug: '../etc' }), null);
  assert.equal(buildActionHref({ type: 'anchor', anchorId: 'Bad Anchor!' }), null);
  assert.equal(buildActionHref({ type: 'event', recordId: 'x" onmouseover="' }), null);
});

// ---------------------------------------------------------------------------
// resolveCodeActions — hint → record resolution
// ---------------------------------------------------------------------------

test('resolveCodeActions: self-resolving, record-backed and unresolved paths', async () => {
  const lookups = {
    findEvent: async (hint) => (hint.includes('summer') ? { id: 'ev1', title: 'Summer Fair' } : null),
    findPage: async () => null,
  };
  const out = await resolveCodeActions([
    { key: 'a', type: 'external_url', url: 'https://example.org' },
    { key: 'b', type: 'event_registration', hint: 'summer fair' },
    { key: 'c', type: 'internal_page', hint: 'nowhere' },
    { key: 'd', type: 'not-a-type' },
  ], lookups);
  assert.equal(out[0].resolved, true);
  assert.equal(out[0].href, 'https://example.org/');
  assert.equal(out[1].resolved, true);
  assert.equal(out[1].href, '/EventDetails?id=ev1&register=1');
  assert.equal(out[1].recordTitle, 'Summer Fair');
  assert.equal(out[2].resolved, false);
  assert.match(out[2].unresolvedReason, /No matching record/);
  assert.equal(out[3].resolved, false);
});

test('resolveCodeActions never throws when a lookup throws', async () => {
  const out = await resolveCodeActions(
    [{ key: 'x', type: 'form', hint: 'contact' }],
    { findForm: async () => { throw new Error('boom'); } },
  );
  assert.equal(out[0].resolved, false);
});

// ---------------------------------------------------------------------------
// resolveActionWithTarget — editor-picked resolution
// ---------------------------------------------------------------------------

test('resolveActionWithTarget verifies the record by id and builds the href', async () => {
  const byId = { findEvent: async (id) => (id === 'ev9' ? { id: 'ev9', title: 'AGM' } : null) };
  const ok = await resolveActionWithTarget({ key: 'k', type: 'event' }, { recordId: 'ev9' }, byId);
  assert.equal(ok.action.resolved, true);
  assert.equal(ok.action.href, '/EventDetails?id=ev9');
  const missing = await resolveActionWithTarget({ key: 'k', type: 'event' }, { recordId: 'nope' }, byId);
  assert.match(missing.error, /not found/i);
  const noId = await resolveActionWithTarget({ key: 'k', type: 'event' }, {}, byId);
  assert.ok(noId.error);
});

test('resolveActionWithTarget handles self-resolving targets', async () => {
  const ok = await resolveActionWithTarget({ key: 'k', type: 'external_url' }, { url: 'https://example.org' }, {});
  assert.equal(ok.action.resolved, true);
  const bad = await resolveActionWithTarget({ key: 'k', type: 'external_url' }, { url: 'http://x.org' }, {});
  assert.ok(bad.error);
});

// ---------------------------------------------------------------------------
// Publish gate
// ---------------------------------------------------------------------------

test('unresolvedActionKeys only counts actions referenced from the markup', () => {
  const doc = {
    actions: [
      { key: 'used-bad', type: 'form', resolved: false, unresolvedReason: 'nope' },
      { key: 'used-ok', type: 'anchor', resolved: true, href: '#x' },
      { key: 'orphan-bad', type: 'form', resolved: false },
    ],
    sanitisation: { actionKeys: ['used-bad', 'used-ok'] },
  };
  const u = unresolvedActionKeys(doc);
  assert.deepEqual(u.map((x) => x.key), ['used-bad']);
});

test('assessAiCodePublishGate aggregates blockers across compositions', () => {
  const gate = assessAiCodePublishGate([
    { compositionId: 'c1', title: 'Hero', document: { actions: [{ key: 'a', type: 'form', resolved: false }] } },
    { compositionId: 'c2', title: 'Body', document: { actions: [{ key: 'b', type: 'anchor', resolved: true, href: '#x' }] } },
  ]);
  assert.equal(gate.ok, false);
  assert.equal(gate.blockers.length, 1);
  assert.equal(gate.blockers[0].compositionId, 'c1');
  const clean = assessAiCodePublishGate([
    { compositionId: 'c2', document: { actions: [{ key: 'b', type: 'anchor', resolved: true, href: '#x' }] } },
  ]);
  assert.equal(clean.ok, true);
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

test('resolveCodeSlots maps slot kinds to trusted blocks', async () => {
  const lookups = {
    findForm: async () => ({ id: 'f1', slug: 'contact', title: 'Contact' }),
    findMembershipTier: async () => ({ id: 't1', title: 'Full member' }),
  };
  const out = await resolveCodeSlots([
    { key: 's1', type: 'form', hint: 'contact' },
    { key: 's2', type: 'event_listing' },
    { key: 's3', type: 'membership_application', hint: 'full' },
    { key: 's4', type: 'directory', hint: 'members' }, // no lookup provided → unresolved
    { key: 's5', type: 'bogus' },
  ], lookups);
  assert.equal(out[0].resolved, true);
  assert.equal(out[0].block.type, 'form-embed');
  assert.equal(out[0].block.content.formSlug, 'contact');
  assert.equal(out[1].resolved, true);
  assert.equal(out[1].block.type, 'event-list');
  assert.equal(out[2].resolved, true);
  assert.equal(out[2].block.type, 'membership-application-cta');
  assert.equal(out[2].block.content.tierId, 't1');
  assert.equal(out[3].resolved, false);
  assert.equal(out[4].resolved, false);
});
