import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { stripHiddenDynamicRegions, applyDynamicSlotValues } from '../../_lib/campaignService.js';

const INBOX_FEATURE = 'communication.inbox';

async function memberHasInboxAccess(roleId) {
  if (!roleId) return true;
  return hasFeatureAccess(roleId, INBOX_FEATURE);
}

const EVENT_QR_BLOCK_RE = /<!--\s*EVENT_QR_BLOCK:START\s*-->[\s\S]*?<!--\s*EVENT_QR_BLOCK:END\s*-->/gi;

// Mirror api/communication/inbox/[id].js: pull the single per-send dynamic slot
// values / hidden slots so the searchable text matches what was delivered.
function parseDesign(campaign) {
  let slotValues = null;
  let hiddenSlots = null;
  if (campaign.design_json) {
    try {
      const d = typeof campaign.design_json === 'string'
        ? JSON.parse(campaign.design_json)
        : campaign.design_json;
      if (d?.slotValues && typeof d.slotValues === 'object') slotValues = d.slotValues;
      if (Array.isArray(d?.hiddenSlots)) hiddenSlots = d.hiddenSlots.filter((t) => typeof t === 'string');
    } catch (e) {
      // ignore malformed design_json
    }
  }
  return { slotValues, hiddenSlots };
}

// Reduce the delivered HTML body to the plain, human-readable text a member sees
// in the reading pane. Applies the same transforms as the [id] render path, then
// strips tags so searches don't match tag names, attributes, inline CSS or URLs.
function toSearchableText(campaign, recipient) {
  const { slotValues, hiddenSlots } = parseDesign(campaign);
  let html = campaign.html_content || '';

  html = stripHiddenDynamicRegions(html, hiddenSlots);
  if (slotValues) html = applyDynamicSlotValues(html, slotValues, { html: true });

  const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim();
  html = html
    .replace(/\{\{recipient_name\}\}/gi, recipientName)
    .replace(/\{\{first_name\}\}/gi, recipient.first_name || '')
    .replace(/\{\{last_name\}\}/gi, recipient.last_name || '')
    .replace(/\{\{email\}\}/gi, recipient.email || '');

  html = html.replace(EVENT_QR_BLOCK_RE, '').replace(/\{\{event_qr_image_url\}\}/gi, '');

  // Drop <style>/<script> contents entirely, then all remaining tags.
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');

  return text.toLowerCase();
}

// Fetch every delivered recipient for the member (with the fields needed to
// re-render the body), paging past the 1000-row PostgREST cap. Scoped to the
// member + tenant so search never reaches campaigns they didn't receive.
async function fetchMemberRecipientsForSearch(memberId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('email_campaign_recipient')
      .select(
        'id, first_name, last_name, email, sent_at, ' +
        'email_campaign!inner(id, tenant_id, html_content, design_json)'
      )
      .eq('member_id', memberId)
      .eq('email_campaign.tenant_id', tenantId)
      .not('sent_at', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Transactional messages store fully rendered HTML, so searchable text is just
// the tag-stripped body. Paged past the 1000-row cap, scoped to member+tenant.
async function fetchMemberTransactionalForSearch(memberId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('member_transactional_message')
      .select('id, subject, preheader, body_html')
      .eq('member_id', memberId)
      .eq('tenant_id', tenantId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Reduce delivered HTML to plain lowercase text for matching.
function htmlToSearchableText(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!ctx.memberId) {
      return res.status(401).json({ error: 'Member session required' });
    }
    if (!(await memberHasInboxAccess(ctx.roleId))) {
      return res.status(403).json({ error: 'You do not have access to the inbox' });
    }

    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const q = raw.trim().toLowerCase();
    if (q.length < 2) {
      return res.json({ recipientIds: [] });
    }

    const [recipients, transactional] = await Promise.all([
      fetchMemberRecipientsForSearch(ctx.memberId, ctx.tenantId),
      fetchMemberTransactionalForSearch(ctx.memberId, ctx.tenantId),
    ]);
    const recipientIds = [];
    for (const r of recipients) {
      const text = toSearchableText(r.email_campaign || {}, r);
      if (text.includes(q)) recipientIds.push(r.id);
    }
    // Transactional message ids share the same client-side id space (unique
    // UUIDs), so they can be returned in the same list.
    for (const t of transactional) {
      const text = htmlToSearchableText(t.body_html);
      if (text.includes(q)) recipientIds.push(t.id);
    }

    return res.json({ recipientIds });
  } catch (error) {
    console.error('[Inbox] search Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
