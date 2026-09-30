import { getTenantContext } from './tenantContext.js';

/**
 * Mark a response as user/session-specific. In particular, a redacted guest
 * response must never be reused for a later member request, and a member
 * response must never be reused for a guest request.
 */
export function setMemberContentCacheHeaders(res, { includeHost = false } = {}) {
  res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
  const existingVary = res.getHeader?.('Vary');
  const vary = existingVary ? String(existingVary) : '';
  const fields = new Set(
    vary.split(',').map((field) => field.trim()).filter(Boolean)
  );
  fields.add('Cookie');
  fields.add('Authorization');
  if (includeHost) fields.add('Host');
  res.setHeader('Vary', Array.from(fields).join(', '));
}

export function viewerFromTenantContext(context, tenantId) {
  if (
    !context
    || context.tenantMismatch
    || context.isAuthenticated !== true
    || !context.tenantId
    || !tenantId
    || String(context.tenantId) !== String(tenantId)
  ) {
    return {
      allowMemberOnlyContent: false,
      isAuthenticated: false,
      isTenantUser: false,
      memberId: null,
    };
  }

  return {
    allowMemberOnlyContent: true,
    isAuthenticated: true,
    isTenantUser: !!context.tenantUserId,
    memberId: context.memberId || null,
  };
}

/**
 * Resolve whether this request has a trusted, authenticated identity in the
 * requested tenant. `getTenantContext` verifies the session against the
 * tenant; this wrapper additionally fails closed on missing/mismatched
 * context, resolver failures, and unauthenticated host-only requests.
 */
export async function resolveCanvasViewer(req, tenantId, { resolveContext = getTenantContext } = {}) {
  const guest = {
    allowMemberOnlyContent: false,
    isAuthenticated: false,
    isTenantUser: false,
    memberId: null,
  };
  if (!tenantId) return guest;

  try {
    const context = await resolveContext(req);
    return viewerFromTenantContext(context, tenantId);
  } catch (error) {
    // Public content must fail closed if session resolution is unavailable.
    console.warn('[Canvas member-only] Viewer resolution failed; serving guest projection:', error?.message || error);
    return guest;
  }
}
