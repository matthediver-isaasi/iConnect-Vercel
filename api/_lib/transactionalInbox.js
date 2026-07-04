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
