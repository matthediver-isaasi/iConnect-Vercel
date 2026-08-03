import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { stripHiddenDynamicRegions, applyDynamicSlotValues } from '../../_lib/campaignService.js';
import { resolveTransactionalInboxLabel } from '../../_lib/transactionalInbox.js';

const INBOX_FEATURE = 'communication.inbox';

async function memberHasInboxAccess(roleId) {
  if (!roleId) return true;
  return hasFeatureAccess(roleId, INBOX_FEATURE);
}

const EVENT_QR_BLOCK_RE = /<!--\s*EVENT_QR_BLOCK:START\s*-->[\s\S]*?<!--\s*EVENT_QR_BLOCK:END\s*-->/gi;

// Minimal design parse: pull the single per-send dynamic slot values / hidden
// slots so the read-only body matches what was delivered.
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

function renderBody(campaign, recipient) {
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

  // Per-recipient event QR is not rendered in the inbox view; strip the block.
  html = html.replace(EVENT_QR_BLOCK_RE, '').replace(/\{\{event_qr_image_url\}\}/gi, '');

  return html;
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const ctx = await getTenantContext(req);
    if (!ctx?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const memberId = ctx.memberId;
    if (!memberId) {
      return res.status(401).json({ error: 'Member session required' });
    }
    const tenantId = ctx.tenantId;

    if (!(await memberHasInboxAccess(ctx.roleId))) {
      return res.status(403).json({ error: 'You do not have access to the inbox' });
    }

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const recipientId = req.query.id;
    if (!recipientId) {
      return res.status(400).json({ error: 'Message id is required' });
    }

    // Transactional messages store their fully rendered HTML on the row itself.
    if (req.query.source === 'transactional') {
      const { data: msg, error: txnErr } = await supabase
        .from('member_transactional_message')
        .select(
          'id, subject, preheader, from_name, from_email, sent_at, body_html, is_read, ' +
          'communication_category_id, label_key'
        )
        .eq('id', recipientId)
        .eq('member_id', memberId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (txnErr) {
        console.error('[Inbox] transactional fetch error:', txnErr);
        return res.status(500).json({ error: 'Failed to load message' });
      }
      if (!msg) {
        return res.status(404).json({ error: 'Message not found' });
      }

      let catName = null;
      if (msg.communication_category_id) {
        const { data: cat } = await supabase
          .from('communication_category')
          .select('name')
          .eq('id', msg.communication_category_id)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        catName = cat?.name || null;
      }

      const nowIso = new Date().toISOString();
      await supabase
        .from('member_transactional_message')
        .update({ is_read: true, read_at: nowIso, updated_at: nowIso })
        .eq('id', msg.id)
        .eq('member_id', memberId)
        .eq('tenant_id', tenantId);

      return res.json({
        message: {
          recipient_id: msg.id,
          campaign_id: null,
          name: msg.from_name || '',
          subject: msg.subject || '',
          preheader: msg.preheader || '',
          from_name: msg.from_name || '',
          from_email: msg.from_email || '',
          sent_at: msg.sent_at || null,
          source: 'transactional',
          label: resolveTransactionalInboxLabel(msg.label_key, catName),
          html: msg.body_html || '',
          is_read: true,
        },
      });
    }

    const { data: recipient, error } = await supabase
      .from('email_campaign_recipient')
      .select(
        'id, campaign_id, email, first_name, last_name, sent_at, ' +
        'email_campaign!inner(id, tenant_id, name, subject, from_name, from_email, sent_at, html_content, design_json, member_group_id, preheader)'
      )
      .eq('id', recipientId)
      .eq('member_id', memberId)
      .eq('email_campaign.tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      console.error('[Inbox] message fetch error:', error);
      return res.status(500).json({ error: 'Failed to load message' });
    }
    if (!recipient || !recipient.sent_at) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const campaign = recipient.email_campaign || {};
    const html = renderBody(campaign, recipient);

    // Auto-mark read on open.
    const nowIso = new Date().toISOString();
    await supabase
      .from('member_inbox_message_state')
      .upsert(
        {
          tenant_id: tenantId,
          member_id: memberId,
          recipient_id: recipient.id,
          is_read: true,
          read_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: 'member_id,recipient_id', ignoreDuplicates: false }
      );

    return res.json({
      message: {
        recipient_id: recipient.id,
        campaign_id: recipient.campaign_id,
        name: campaign.name || '',
        subject: campaign.subject || '',
        preheader: campaign.preheader || '',
        from_name: campaign.from_name || '',
        from_email: campaign.from_email || '',
        sent_at: recipient.sent_at || campaign.sent_at || null,
        source: campaign.member_group_id ? 'group' : 'admin',
        html,
        is_read: true,
      },
    });
  } catch (error) {
    console.error('[Inbox] message Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
