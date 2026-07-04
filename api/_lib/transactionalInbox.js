import { supabase } from './database.js';

// Built-in fallback labels for transactional inbox messages, keyed by a stable
// label key. Used when no tenant Communication Category is configured for the
// message (or the category was deleted). Keep this list in sync with the
// documented set of transactional email families.
export const TRANSACTIONAL_INBOX_LABELS = {
  events: 'Events',
  membership: 'Membership',
  billing: 'Billing',
  forms: 'Forms',
  groups: 'Groups',
  automations: 'Automations',
};

// Neutral catch-all when neither a category name nor a known label key is
// available.
export const DEFAULT_TRANSACTIONAL_INBOX_LABEL = 'Notifications';

// Resolve a human-readable label for an inbox message. Prefer a configured
// tenant Communication Category name; otherwise fall back to the built-in label
// for the key. Shared by every inbox read endpoint so labelling stays
// consistent across list / detail / (future) surfaces.
export function resolveTransactionalInboxLabel(labelKey, categoryName) {
  if (categoryName && typeof categoryName === 'string' && categoryName.trim()) {
    return categoryName.trim();
  }
  if (labelKey && TRANSACTIONAL_INBOX_LABELS[labelKey]) {
    return TRANSACTIONAL_INBOX_LABELS[labelKey];
  }
  return DEFAULT_TRANSACTIONAL_INBOX_LABEL;
}

// Candidate Communication Category names per label key. When a tenant has
// created a Communication Category whose name matches one of these
// (case-insensitive), the inbox message links to it so the displayed label
// follows the category (including future renames) and lines up with the
// member's subscription categories. Otherwise the built-in labelKey fallback
// applies. This is how "the tenant's configurable Communication Category when
// set, else the built-in fallback" is honoured for families that don't already
// carry an explicit category id (forms do — they pass one directly).
const LABEL_CATEGORY_NAME_CANDIDATES = {
  events: ['Events'],
  membership: ['Membership'],
  billing: ['Purchase Orders', 'Billing'],
  forms: ['Forms'],
  groups: ['Groups'],
  automations: ['Automations'],
};

// Short-lived per-tenant cache of communication_category name (lowercased) → id.
const categoryCache = new Map();
const CATEGORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function loadTenantCategoryMap(tenantId) {
  const cached = categoryCache.get(tenantId);
  if (cached && (Date.now() - cached.timestamp) < CATEGORY_CACHE_TTL) {
    return cached.map;
  }
  const map = new Map();
  try {
    if (supabase) {
      const { data } = await supabase
        .from('communication_category')
        .select('id, name')
        .eq('tenant_id', tenantId);
      for (const row of data || []) {
        if (row?.name) map.set(String(row.name).trim().toLowerCase(), row.id);
      }
    }
  } catch (err) {
    console.error('[Transactional Inbox] Failed to load communication categories:', err?.message || err);
  }
  categoryCache.set(tenantId, { map, timestamp: Date.now() });
  return map;
}

// Resolve the tenant's configured Communication Category id for a family label
// key by name-matching. Returns null when the tenant has no matching category.
export async function resolveCommunicationCategoryIdForLabel(tenantId, labelKey) {
  if (!tenantId || !labelKey) return null;
  const candidates = LABEL_CATEGORY_NAME_CANDIDATES[labelKey];
  if (!candidates || candidates.length === 0) return null;
  const map = await loadTenantCategoryMap(tenantId);
  for (const name of candidates) {
    const id = map.get(name.toLowerCase());
    if (id) return id;
  }
  return null;
}

// Resolve a member id from a recipient email (case-insensitive) within a tenant.
// Returns null when the address maps to no member (guest recipient).
export async function resolveMemberIdByEmail(tenantId, email) {
  if (!tenantId || !email || typeof email !== 'string') return null;
  const clean = email.trim();
  if (!clean) return null;
  try {
    if (!supabase) return null;
    const { data } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .ilike('email', clean)
      .limit(1);
    return data?.[0]?.id || null;
  } catch (err) {
    console.error('[Transactional Inbox] Failed to resolve member by email:', err?.message || err);
    return null;
  }
}

// Build an inboxDelivery descriptor for a transactional send, or null when no
// member can be resolved (guest/admin-only recipients are skipped). When
// memberId is not supplied directly it is resolved from the recipient email.
// An explicit communicationCategoryId (e.g. a form's configured category) wins;
// otherwise the tenant's category for the family label is resolved by name,
// falling back to the built-in labelKey label at read time when none is set.
export async function buildInboxDelivery({
  tenantId,
  memberId = null,
  email = null,
  labelKey = null,
  communicationCategoryId = null,
  preheader = null,
}) {
  if (!tenantId) return null;
  let resolvedMemberId = memberId || null;
  if (!resolvedMemberId && email) {
    resolvedMemberId = await resolveMemberIdByEmail(tenantId, email);
  }
  if (!resolvedMemberId) return null;
  let catId = communicationCategoryId || null;
  if (!catId && labelKey) {
    catId = await resolveCommunicationCategoryIdForLabel(tenantId, labelKey);
  }
  return {
    memberId: resolvedMemberId,
    labelKey: labelKey || null,
    communicationCategoryId: catId || null,
    preheader: preheader || null,
  };
}

// Split a From header ("Name <email@x>" or a bare address) into name + email.
function parseFromAddress(fromAddress) {
  if (!fromAddress || typeof fromAddress !== 'string') return { name: '', email: '' };
  const m = fromAddress.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    return { name: (m[1] || '').replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  }
  return { name: '', email: fromAddress.trim() };
}

// Persist a transactional email into a member's inbox. NEVER throws — mirrors
// sendEmail's swallow-and-return behaviour so a failed inbox write can never
// break (or appear to break) an email send. Returns the created row id, or null
// on any skip/failure. Called from sendEmail() only when an inboxDelivery
// descriptor is present and the send itself succeeded.
export async function recordTransactionalInboxMessage({
  tenantId,
  memberId,
  to,
  subject,
  html,
  fromAddress,
  preheader = null,
  communicationCategoryId = null,
  labelKey = null,
}) {
  try {
    if (!supabase) return null;
    if (!tenantId || !memberId) {
      console.warn(
        `[Transactional Inbox] Skipping record — missing ${!tenantId ? 'tenantId' : 'memberId'}`
      );
      return null;
    }

    const { name: fromName, email: fromEmail } = parseFromAddress(fromAddress);
    const recipientEmail = Array.isArray(to) ? to[0] : to;

    const row = {
      tenant_id: tenantId,
      member_id: memberId,
      recipient_email: recipientEmail || null,
      subject: subject || '',
      preheader: preheader || null,
      body_html: html || '',
      from_name: fromName || null,
      from_email: fromEmail || null,
      communication_category_id: communicationCategoryId || null,
      label_key: labelKey || null,
      sent_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('member_transactional_message')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[Transactional Inbox] Failed to record message:', error.message || error);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.error('[Transactional Inbox] Unexpected error recording message:', err?.message || err);
    return null;
  }
}
