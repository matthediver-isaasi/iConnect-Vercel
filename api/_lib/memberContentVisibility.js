// Task #2363: Member AI Knowledge Assistant — visibility boundary.
//
// The retrieval filter IS the security boundary. This module holds the single
// source of truth for deciding whether a retrieved chunk is one the asking
// member is allowed to SEE on the portal — mirroring the public/browse rules:
//   - resources : api/public/resources.js  (status active, member_group_id,
//                  allowed_role_ids)
//   - events    : api/public/events.js     (status published/tbc/immediate, never
//                  event_state=draft, group_event_public / group membership)
//   - news      : api/public/news.js       (status published, published_date<=now)
//   - blog      : api/public/article.js    (status published)
//
// It is a PURE function of (chunk, ctx) so it can be unit-tested and reused
// verbatim by the ask endpoint. Feature-key RBAC gating is applied first.

export const CONTENT_TYPES = [
  'resource',
  'event',
  'complex_event',
  'news_post',
  'blog_post',
  'canvas_page',
];

// Canvas Builder page layout_types that are publicly viewable — the exact set
// the public page renderer (api/public/page/[slug].js) serves. Member layout
// pages are additionally indexed as authenticated-only projections by the
// member knowledge corpus; public layouts may also have member-only blocks.
export const PUBLIC_CANVAS_LAYOUT_TYPES = [
  'public',
  'hybrid',
  'public_no_chrome',
  'public_header_only',
  'public_footer_only',
];

/**
 * @param {object} chunk  a row returned by match_member_content_chunks
 * @param {object} ctx
 *   - isAdmin {boolean}          authenticated tenant/admin user (no member RBAC)
 *   - roleId {string|null}       member role id
 *   - groupIds {Set<string>}     member's active group ids
 *   - isAuthenticated {boolean}  trusted authenticated session
 *   - canAccessFeature {(key:string)=>boolean}
 *   - tenantId {string}          expected tenant (defence in depth)
 *   - now {Date}                 clock for published_date checks
 * @returns {boolean}
 */
import { isPublicSimpleEventStatus } from '../../shared/eventTiming.js';
import { isResourceReleased } from '../../shared/resourceRelease.js';

export function isChunkVisibleToMember(chunk, ctx) {
  if (!chunk) return false;
  const {
    isAdmin = false,
    isAuthenticated = true,
    roleId = null,
    groupIds = new Set(),
    canAccessFeature = () => true,
    tenantId = null,
    now = new Date(),
  } = ctx || {};

  // Defence in depth: never leak across tenants even if the RPC changed.
  if (tenantId && chunk.tenant_id && chunk.tenant_id !== tenantId) return false;

  // Feature-key RBAC gate (admins pass everything via canAccessFeature).
  if (chunk.feature_key && !canAccessFeature(chunk.feature_key)) return false;
  if (chunk.access_scope === 'authenticated' && !isAuthenticated) return false;

  const type = chunk.content_type;

  if (type === 'resource') {
    if (chunk.status !== 'active') return false;
    if (!isResourceReleased(chunk, now)) return false;
    if (!isAdmin) {
      // A resource which is not published to the public library is a
      // member/role surface, not a tenant-wide shortcut.  The normal resource
      // detail flow denies a member with no effective role even where an old
      // row has an empty allowed_role_ids list, so retain that distinction in
      // AI retrieval.  `null` is treated as non-public: missing access
      // metadata must never broaden access.
      if (chunk.is_public !== true && !roleId) return false;
      if (chunk.member_group_id && !groupIds.has(chunk.member_group_id)) {
        return false;
      }
      const allowed = chunk.allowed_role_ids;
      if (Array.isArray(allowed) && allowed.length > 0) {
        if (!roleId || !allowed.includes(roleId)) return false;
      }
    }
    return true;
  }

  if (type === 'event' || type === 'complex_event') {
    // simple events also accept 'immediate'; complex_event does not (immutable complex allowlist)
    const validStatus = type === 'event'
      ? isPublicSimpleEventStatus(chunk.status)
      : ['published', 'tbc'].includes(chunk.status);
    if (!validStatus) return false;
    if (chunk.event_state === 'draft') return false;
    if (!isAdmin && chunk.member_group_id) {
      if (chunk.group_event_public !== true && !groupIds.has(chunk.member_group_id)) {
        return false;
      }
    }
    return true;
  }

  if (type === 'news_post') {
    if (chunk.status !== 'published') return false;
    if (chunk.published_date && new Date(chunk.published_date) > now) return false;
    return true;
  }

  if (type === 'blog_post') {
    if (chunk.status !== 'published') return false;
    if (chunk.published_date && new Date(chunk.published_date) > now) return false;
    return true;
  }

  if (type === 'canvas_page') {
    // Mirror the public page renderer (api/public/page/[slug].js): only
    // published pages surface. Canvas pages carry no role/group columns
    // (i_edit_page has none), so there is no per-role/per-group gating; the
    // layout/scope is assigned by the indexer per projection; no feature key
    // applies to portal pages themselves.
    if (chunk.status !== 'published') return false;
    return true;
  }

  return false;
}
