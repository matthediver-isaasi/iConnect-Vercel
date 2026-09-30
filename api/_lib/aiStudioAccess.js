/**
 * AI Design Studio — permission split (Task #2852, spec §29).
 *
 * Four distinct actions, reusing the role access map (excluded-features
 * model: a key is allowed unless the role explicitly excludes it):
 *   generate  → site-builder.ai-generate   (create/propose/imagery/review)
 *   approve   → site-builder.ai-approve    (accept proposals, undo versions)
 *   publish   → existing page publish flow (site-builder.pages / page-editor)
 *   configure → admin.ai-design-studio     (admin settings + usage report)
 *
 * All AI composition actions ALSO require site-builder.page-editor (the
 * baseline editor permission) — the split narrows, never widens, access.
 */

import { hasFeatureAccess as defaultHasFeatureAccess } from './tenantContext.js';

export const AI_FEATURE_GENERATE = 'site-builder.ai-generate';
export const AI_FEATURE_APPROVE = 'site-builder.ai-approve';
export const AI_FEATURE_CONFIGURE = 'admin.ai-design-studio';
export const AI_FEATURE_EDITOR = 'site-builder.page-editor';

/**
 * Pure decision: may this context perform the given AI Studio action?
 * Tenant-user (admin dashboard) sessions bypass per-feature RBAC like every
 * other admin surface; member sessions need page-editor AND the action key.
 *
 * @param {object} context - tenant context ({ tenantUserId?, roleId? })
 * @param {string} featureId - one of the AI_FEATURE_* action keys
 * @param {object} [deps] - { hasFeatureAccess } injectable for tests
 * @returns {Promise<boolean>}
 */
export async function canUseAiFeature(context, featureId, deps = {}) {
  const hasFeatureAccess = deps.hasFeatureAccess || defaultHasFeatureAccess;
  if (context?.tenantUserId) return true;
  if (!context?.roleId) return false;
  if (!(await hasFeatureAccess(context.roleId, AI_FEATURE_EDITOR))) return false;
  if (!featureId || featureId === AI_FEATURE_EDITOR) return true;
  return !!(await hasFeatureAccess(context.roleId, featureId));
}

/**
 * Governance switch (spec §28): should this image-generation request be
 * blocked because the tenant has turned off AI illustration?
 * Photographic/product imagery stays governed by allowImageGeneration.
 */
export function illustrationBlocked(settings, elementType) {
  if (!settings || settings.allowGeneratedIllustration !== false) return false;
  return elementType === 'generated_illustration';
}

/** Filter a collectImageBriefs() list against the illustration policy. */
export function filterBriefsByPolicy(briefs, settings) {
  const list = Array.isArray(briefs) ? briefs : [];
  if (!settings || settings.allowGeneratedIllustration !== false) return list;
  return list.filter((b) => b.type !== 'generated_illustration');
}
