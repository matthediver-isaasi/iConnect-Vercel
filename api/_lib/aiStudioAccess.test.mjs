// Tests for the AI Design Studio permission split + governance switches
// (Task #2852, spec §29): generate / approve / configure remain distinct,
// reusing the role access map, and the illustration policy helpers.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canUseAiFeature,
  illustrationBlocked,
  filterBriefsByPolicy,
  AI_FEATURE_GENERATE,
  AI_FEATURE_APPROVE,
  AI_FEATURE_EDITOR,
} from './aiStudioAccess.js';
import {
  sanitizeStudioSettings,
  buildGuidanceSummary,
} from './aiDesignStudioSettings.js';

function accessFn(allowedKeys) {
  return async (roleId, key) => allowedKeys.includes(key);
}

test('tenant-user (admin dashboard) sessions bypass per-feature RBAC', async () => {
  const ok = await canUseAiFeature(
    { tenantUserId: 'tu-1' },
    AI_FEATURE_GENERATE,
    { hasFeatureAccess: async () => false },
  );
  assert.equal(ok, true);
});

test('member without a role is denied', async () => {
  const ok = await canUseAiFeature({ memberId: 'm1' }, AI_FEATURE_GENERATE, {
    hasFeatureAccess: async () => true,
  });
  assert.equal(ok, false);
});

test('member missing the baseline page-editor permission is denied even with the action key', async () => {
  const ok = await canUseAiFeature(
    { roleId: 'r1' },
    AI_FEATURE_GENERATE,
    { hasFeatureAccess: accessFn([AI_FEATURE_GENERATE]) },
  );
  assert.equal(ok, false);
});

test('member with page-editor but with ai-generate excluded is denied generation', async () => {
  const ok = await canUseAiFeature(
    { roleId: 'r1' },
    AI_FEATURE_GENERATE,
    { hasFeatureAccess: accessFn([AI_FEATURE_EDITOR, AI_FEATURE_APPROVE]) },
  );
  assert.equal(ok, false);
});

test('generate vs approve are distinct: approve-only role cannot generate and vice versa', async () => {
  const approveOnly = accessFn([AI_FEATURE_EDITOR, AI_FEATURE_APPROVE]);
  const generateOnly = accessFn([AI_FEATURE_EDITOR, AI_FEATURE_GENERATE]);

  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_APPROVE, { hasFeatureAccess: approveOnly }), true);
  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_GENERATE, { hasFeatureAccess: approveOnly }), false);
  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_GENERATE, { hasFeatureAccess: generateOnly }), true);
  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_APPROVE, { hasFeatureAccess: generateOnly }), false);
});

test('member with both keys is allowed both actions', async () => {
  const both = accessFn([AI_FEATURE_EDITOR, AI_FEATURE_GENERATE, AI_FEATURE_APPROVE]);
  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_GENERATE, { hasFeatureAccess: both }), true);
  assert.equal(await canUseAiFeature({ roleId: 'r1' }, AI_FEATURE_APPROVE, { hasFeatureAccess: both }), true);
});

test('illustrationBlocked only bites generated_illustration when the switch is off', () => {
  const off = { allowGeneratedIllustration: false };
  const on = { allowGeneratedIllustration: true };
  assert.equal(illustrationBlocked(off, 'generated_illustration'), true);
  assert.equal(illustrationBlocked(off, 'image'), false);
  assert.equal(illustrationBlocked(on, 'generated_illustration'), false);
  assert.equal(illustrationBlocked(null, 'generated_illustration'), false);
});

test('filterBriefsByPolicy strips illustration briefs when disallowed', () => {
  const briefs = [
    { elementId: 'a', type: 'image', brief: { subject: 'photo' } },
    { elementId: 'b', type: 'generated_illustration', brief: { subject: 'drawing' } },
  ];
  const kept = filterBriefsByPolicy(briefs, { allowGeneratedIllustration: false });
  assert.deepEqual(kept.map((b) => b.elementId), ['a']);
  assert.equal(filterBriefsByPolicy(briefs, { allowGeneratedIllustration: true }).length, 2);
});

test('sanitizeStudioSettings keeps preferredExamplePages and governance booleans', () => {
  const s = sanitizeStudioSettings({
    preferredExamplePages: '/about, /conference',
    allowAiCopy: false,
    allowGeneratedIllustration: false,
    requireFactualApproval: false,
  });
  assert.equal(s.preferredExamplePages, '/about, /conference');
  assert.equal(s.allowAiCopy, false);
  assert.equal(s.allowGeneratedIllustration, false);
  assert.equal(s.requireFactualApproval, false);
});

test('buildGuidanceSummary carries the copy/illustration/example-page rules into prompts', () => {
  const summary = buildGuidanceSummary(sanitizeStudioSettings({
    allowAiCopy: false,
    allowGeneratedIllustration: false,
    preferredExamplePages: '/about-us',
  }));
  assert.match(summary, /Do NOT write new marketing copy/);
  assert.match(summary, /Never add generated_illustration/);
  assert.match(summary, /\/about-us/);
});
