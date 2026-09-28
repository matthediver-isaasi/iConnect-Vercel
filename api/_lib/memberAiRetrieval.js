import { CONTENT_TYPES } from './memberContentVisibility.js';
import { canAccessResourceEvents } from './singleResourceAccess.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories } from './resourceCategoryAccess.js';

// These are the feature keys written by memberContentIndexer. Never accept
// permission lists, member identity or admin flags from the question payload.
const FEATURES = ['content.resources', 'events.browse-events', 'content.news', 'content.articles'];
export const MEMBER_AI_RPC_ARGUMENTS = [
  'query_embedding', 'p_tenant_id', 'match_count', 'p_is_authenticated',
  'p_is_admin', 'p_role_id', 'p_group_ids', 'p_accessible_event_ids',
  'p_accessible_session_ids', 'p_hidden_subcategories', 'p_allowed_feature_keys',
  'p_eligible_pdf_chunk_ids', 'p_query_text', 'p_allowed_content_types',
];

export async function resolveMemberAiRetrievalContext({
  db, tenantId, memberId, roleId, groupIds, isAdmin, canAccessFeature,
}) {
  if (!tenantId || (!memberId && !isAdmin)) throw new Error('Validated AI viewer required');
  const categories = await fetchCategoriesWithAccess(db, tenantId);
  const hidden = computeHiddenSubcategories(categories, { roleId, isPrivileged: isAdmin });
  const eventIds = new Set();
  const sessionIds = new Set();
  // Reuse the resource download/browse authorization, including confirmed
  // bookings, exact attendee email, tenant scope and ticket/track session gates.
  // Query only link metadata (never private resource text) before retrieval.
  if (!isAdmin && canAccessFeature('content.resources')) {
    const links = new Map();
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.from('resource').select('id, linked_events')
        .eq('tenant_id', tenantId).eq('status', 'active')
        .order('id').range(offset, offset + 499);
      if (error) throw error;
      for (const resource of data || []) {
        for (const link of Array.isArray(resource.linked_events) ? resource.linked_events : []) {
          if (link?.event_id) links.set(`${link.event_id}:${link.session_id || ''}`, link);
        }
      }
      if ((data || []).length < 500) break;
      if (offset >= 24500) throw new Error('Resource authorization limit exceeded; no partial AI retrieval');
    }
    const ctx = { tenantId, memberId, roleId };
    for (const link of links.values()) {
      if (await canAccessResourceEvents(db, { linked_events: [link] }, ctx)) {
        eventIds.add(link.event_id);
        if (link.session_id) sessionIds.add(link.session_id);
      }
    }
  }
  return {
    p_tenant_id: tenantId,
    p_is_authenticated: true,
    p_is_admin: isAdmin === true,
    p_role_id: roleId || null,
    p_group_ids: [...groupIds],
    p_accessible_event_ids: [...eventIds],
    p_accessible_session_ids: [...sessionIds],
    p_hidden_subcategories: [...hidden],
    p_allowed_feature_keys: FEATURES.filter(canAccessFeature),
    // Derived PDFs require file/folder/gallery authorization that this endpoint
    // does not implement. Never inherit their access from the parent resource.
    p_eligible_pdf_chunk_ids: [],
    p_allowed_content_types: [...CONTENT_TYPES],
  };
}

export function memberAiRetrievalArguments(context, embedding, question, count = 40) {
  if (!Array.isArray(embedding) || embedding.length !== 1536 ||
      embedding.some(value => !Number.isFinite(value))) throw new Error('Invalid AI query embedding');
  return {
    ...context,
    query_embedding: embedding,
    match_count: Math.min(100, Math.max(1, Math.trunc(count))),
    p_query_text: question,
  };
}