import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';

const INBOX_FEATURE = 'communication.inbox';

// Members with no assigned role have no excluded features, so they see the
// inbox by default (mirrors the client's isFeatureExcluded behaviour). Only when
// a role IS assigned do we consult its exclusions.
async function memberHasInboxAccess(roleId) {
  if (!roleId) return true;
  return hasFeatureAccess(roleId, INBOX_FEATURE);
}

// A recipient row was actually delivered/attempted once sent_at is populated.
function recipientIsDelivered(r) {
  return !!r.sent_at;
}

// Fetch every row for a member across the 1000-row PostgREST page cap.
async function fetchAllRecipients(memberId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('email_campaign_recipient')
      .select(
        'id, campaign_id, email, first_name, last_name, status, sent_at, open_count, click_count, ' +
        'email_campaign!inner(id, tenant_id, name, subject, from_name, from_email, sent_at, status, member_group_id, communication_category_id, preheader)'
      )
      .eq('member_id', memberId)
      .eq('email_campaign.tenant_id', tenantId)
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchAllStates(memberId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const byRecipient = new Map();
  for (;;) {
    const { data, error } = await supabase
      .from('member_inbox_message_state')
      .select('recipient_id, is_read, is_pinned, is_archived, is_favourite, folder_id, read_at')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    for (const s of batch) byRecipient.set(s.recipient_id, s);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return byRecipient;
}

function toMessage(r, state) {
  const c = r.email_campaign || {};
  return {
    recipient_id: r.id,
    campaign_id: r.campaign_id,
    name: c.name || '',
    subject: c.subject || '',
    preheader: c.preheader || '',
    from_name: c.from_name || '',
    from_email: c.from_email || '',
    sent_at: r.sent_at || c.sent_at || null,
    source: c.member_group_id ? 'group' : 'admin',
    member_group_id: c.member_group_id || null,
    is_read: state ? !!state.is_read : false,
    is_pinned: state ? !!state.is_pinned : false,
    is_archived: state ? !!state.is_archived : false,
    is_favourite: state ? !!state.is_favourite : false,
    folder_id: state ? state.folder_id || null : null,
    read_at: state ? state.read_at || null : null,
  };
}

const ACTIONS = new Set(['read', 'unread', 'pin', 'unpin', 'archive', 'unarchive', 'favourite', 'unfavourite', 'move']);

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

    if (req.method === 'GET') {
      const [recipients, stateMap, foldersRes] = await Promise.all([
        fetchAllRecipients(memberId, tenantId),
        fetchAllStates(memberId, tenantId),
        supabase
          .from('member_inbox_folder')
          .select('id, name, created_at')
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId)
          .order('name', { ascending: true }),
      ]);

      const messages = recipients
        .filter(recipientIsDelivered)
        .map((r) => toMessage(r, stateMap.get(r.id)));

      const unreadCount = messages.filter((m) => !m.is_read && !m.is_archived).length;

      return res.json({
        messages,
        folders: foldersRes.data || [],
        unreadCount,
      });
    }

    if (req.method === 'POST') {
      const { recipient_id, action } = req.body || {};
      let { folder_id } = req.body || {};

      if (!recipient_id || !action) {
        return res.status(400).json({ error: 'recipient_id and action are required' });
      }
      if (!ACTIONS.has(action)) {
        return res.status(400).json({ error: `action must be one of: ${[...ACTIONS].join(', ')}` });
      }

      // Confirm the recipient row belongs to this member within this tenant.
      const { data: recipient, error: recErr } = await supabase
        .from('email_campaign_recipient')
        .select('id, member_id, email_campaign!inner(tenant_id)')
        .eq('id', recipient_id)
        .eq('member_id', memberId)
        .eq('email_campaign.tenant_id', tenantId)
        .maybeSingle();
      if (recErr) {
        console.error('[Inbox] recipient lookup error:', recErr);
        return res.status(500).json({ error: 'Failed to verify message' });
      }
      if (!recipient) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const patch = {};
      const nowIso = new Date().toISOString();
      switch (action) {
        case 'read':
          patch.is_read = true;
          patch.read_at = nowIso;
          break;
        case 'unread':
          patch.is_read = false;
          patch.read_at = null;
          break;
        case 'pin':
          patch.is_pinned = true;
          break;
        case 'unpin':
          patch.is_pinned = false;
          break;
        case 'archive':
          patch.is_archived = true;
          break;
        case 'unarchive':
          patch.is_archived = false;
          break;
        case 'favourite':
          patch.is_favourite = true;
          break;
        case 'unfavourite':
          patch.is_favourite = false;
          break;
        case 'move': {
          if (folder_id) {
            const { data: folder } = await supabase
              .from('member_inbox_folder')
              .select('id')
              .eq('id', folder_id)
              .eq('tenant_id', tenantId)
              .eq('member_id', memberId)
              .maybeSingle();
            if (!folder) {
              return res.status(404).json({ error: 'Folder not found' });
            }
          } else {
            folder_id = null;
          }
          patch.folder_id = folder_id;
          break;
        }
        default:
          break;
      }

      const { data: state, error: upErr } = await supabase
        .from('member_inbox_message_state')
        .upsert(
          {
            tenant_id: tenantId,
            member_id: memberId,
            recipient_id,
            ...patch,
            updated_at: nowIso,
          },
          { onConflict: 'member_id,recipient_id' }
        )
        .select('recipient_id, is_read, is_pinned, is_archived, is_favourite, folder_id, read_at')
        .single();
      if (upErr) {
        console.error('[Inbox] state upsert error:', upErr);
        return res.status(500).json({ error: 'Failed to update message' });
      }

      return res.json({ state });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Inbox] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
