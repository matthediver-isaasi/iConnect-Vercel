import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { resolveTransactionalInboxLabel } from '../../_lib/transactionalInbox.js';

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

// Fetch every transactional message for a member, paging past the 1000-row
// PostgREST cap. State (read/pin/archive/favourite/folder) is co-located on
// each row, so no separate state join is needed.
async function fetchAllTransactional(memberId, tenantId) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from('member_transactional_message')
      .select(
        'id, subject, preheader, from_name, from_email, sent_at, communication_category_id, label_key, ' +
        'is_read, is_pinned, is_archived, is_favourite, folder_id, read_at'
      )
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
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

// Resolve tenant Communication Category names for a set of ids in one query.
async function fetchCategoryNames(ids, tenantId) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (unique.length === 0) return map;
  const { data, error } = await supabase
    .from('communication_category')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .in('id', unique);
  if (error) {
    console.error('[Inbox] category name lookup error:', error);
    return map;
  }
  for (const c of data || []) map.set(c.id, c.name);
  return map;
}

function toMessage(r, state, catMap) {
  const c = r.email_campaign || {};
  const catName = c.communication_category_id ? catMap.get(c.communication_category_id) : null;
  const source = c.member_group_id ? 'group' : 'admin';
  return {
    recipient_id: r.id,
    campaign_id: r.campaign_id,
    name: c.name || '',
    subject: c.subject || '',
    preheader: c.preheader || '',
    from_name: c.from_name || '',
    from_email: c.from_email || '',
    sent_at: r.sent_at || c.sent_at || null,
    source,
    label: catName || (source === 'group' ? 'Group' : 'Announcement'),
    member_group_id: c.member_group_id || null,
    is_read: state ? !!state.is_read : false,
    is_pinned: state ? !!state.is_pinned : false,
    is_archived: state ? !!state.is_archived : false,
    is_favourite: state ? !!state.is_favourite : false,
    folder_id: state ? state.folder_id || null : null,
    read_at: state ? state.read_at || null : null,
  };
}

function toTransactionalMessage(t, catMap) {
  const catName = t.communication_category_id ? catMap.get(t.communication_category_id) : null;
  return {
    recipient_id: t.id,
    campaign_id: null,
    name: t.from_name || '',
    subject: t.subject || '',
    preheader: t.preheader || '',
    from_name: t.from_name || '',
    from_email: t.from_email || '',
    sent_at: t.sent_at || null,
    source: 'transactional',
    label: resolveTransactionalInboxLabel(t.label_key, catName),
    member_group_id: null,
    is_read: !!t.is_read,
    is_pinned: !!t.is_pinned,
    is_archived: !!t.is_archived,
    is_favourite: !!t.is_favourite,
    folder_id: t.folder_id || null,
    read_at: t.read_at || null,
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
      const [recipients, stateMap, foldersRes, transactional] = await Promise.all([
        fetchAllRecipients(memberId, tenantId),
        fetchAllStates(memberId, tenantId),
        supabase
          .from('member_inbox_folder')
          .select('id, name, created_at')
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId)
          .order('name', { ascending: true }),
        fetchAllTransactional(memberId, tenantId),
      ]);

      const deliveredRecipients = recipients.filter(recipientIsDelivered);

      // Resolve all referenced Communication Category names in one query so
      // both campaign and transactional messages can show a human label.
      const catIds = [];
      for (const r of deliveredRecipients) {
        const id = r.email_campaign?.communication_category_id;
        if (id) catIds.push(id);
      }
      for (const t of transactional) {
        if (t.communication_category_id) catIds.push(t.communication_category_id);
      }
      const catMap = await fetchCategoryNames(catIds, tenantId);

      const messages = [
        ...deliveredRecipients.map((r) => toMessage(r, stateMap.get(r.id), catMap)),
        ...transactional.map((t) => toTransactionalMessage(t, catMap)),
      ].sort((a, b) => {
        const at = a.sent_at ? new Date(a.sent_at).getTime() : 0;
        const bt = b.sent_at ? new Date(b.sent_at).getTime() : 0;
        return bt - at;
      });

      const unreadCount = messages.filter((m) => !m.is_read && !m.is_archived).length;

      return res.json({
        messages,
        folders: foldersRes.data || [],
        unreadCount,
      });
    }

    if (req.method === 'POST') {
      const {
        recipient_id,
        recipient_ids,
        transactional_id,
        transactional_ids,
        action,
      } = req.body || {};
      let { folder_id } = req.body || {};

      // Campaign messages are identified by `recipient_id`/`recipient_ids`;
      // transactional messages by `transactional_id`/`transactional_ids`. A
      // single request may carry both (mixed bulk selection). Normalise each to
      // a de-duped list. `isBulk` preserves the legacy single-vs-array response
      // shape for the campaign-only path.
      const rawCampaignIds = Array.isArray(recipient_ids)
        ? recipient_ids
        : recipient_id != null
          ? [recipient_id]
          : [];
      const rawTxnIds = Array.isArray(transactional_ids)
        ? transactional_ids
        : transactional_id != null
          ? [transactional_id]
          : [];
      const ids = [...new Set(rawCampaignIds.filter(Boolean))];
      const txnIds = [...new Set(rawTxnIds.filter(Boolean))];
      const isBulk = Array.isArray(recipient_ids) || Array.isArray(transactional_ids);

      if (ids.length + txnIds.length === 0 || !action) {
        return res
          .status(400)
          .json({ error: 'recipient_id(s)/transactional_id(s) and action are required' });
      }
      if (!ACTIONS.has(action)) {
        return res.status(400).json({ error: `action must be one of: ${[...ACTIONS].join(', ')}` });
      }

      // Confirm every campaign recipient row belongs to this member/tenant.
      let ownedIds = [];
      if (ids.length > 0) {
        const { data: ownedRows, error: recErr } = await supabase
          .from('email_campaign_recipient')
          .select('id, member_id, email_campaign!inner(tenant_id)')
          .in('id', ids)
          .eq('member_id', memberId)
          .eq('email_campaign.tenant_id', tenantId);
        if (recErr) {
          console.error('[Inbox] recipient lookup error:', recErr);
          return res.status(500).json({ error: 'Failed to verify message' });
        }
        ownedIds = (ownedRows || []).map((r) => r.id);
        if (ownedIds.length !== ids.length) {
          return res.status(404).json({ error: 'Message not found' });
        }
      }

      // Confirm every transactional message row belongs to this member/tenant.
      let ownedTxnIds = [];
      if (txnIds.length > 0) {
        const { data: ownedTxn, error: txnErr } = await supabase
          .from('member_transactional_message')
          .select('id')
          .in('id', txnIds)
          .eq('member_id', memberId)
          .eq('tenant_id', tenantId);
        if (txnErr) {
          console.error('[Inbox] transactional lookup error:', txnErr);
          return res.status(500).json({ error: 'Failed to verify message' });
        }
        ownedTxnIds = (ownedTxn || []).map((r) => r.id);
        if (ownedTxnIds.length !== txnIds.length) {
          return res.status(404).json({ error: 'Message not found' });
        }
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

      let states = [];
      if (ownedIds.length > 0) {
        const { data: upserted, error: upErr } = await supabase
          .from('member_inbox_message_state')
          .upsert(
            ownedIds.map((rid) => ({
              tenant_id: tenantId,
              member_id: memberId,
              recipient_id: rid,
              ...patch,
              updated_at: nowIso,
            })),
            { onConflict: 'member_id,recipient_id' }
          )
          .select('recipient_id, is_read, is_pinned, is_archived, is_favourite, folder_id, read_at');
        if (upErr) {
          console.error('[Inbox] state upsert error:', upErr);
          return res.status(500).json({ error: 'Failed to update message' });
        }
        states = upserted || [];
      }

      // Transactional state is co-located on the message row, so this is a plain
      // update (the rows already exist and ownership is verified above).
      let txnStates = [];
      if (ownedTxnIds.length > 0) {
        const { data: updated, error: txnUpErr } = await supabase
          .from('member_transactional_message')
          .update({ ...patch, updated_at: nowIso })
          .in('id', ownedTxnIds)
          .eq('member_id', memberId)
          .eq('tenant_id', tenantId)
          .select('id, is_read, is_pinned, is_archived, is_favourite, folder_id, read_at');
        if (txnUpErr) {
          console.error('[Inbox] transactional update error:', txnUpErr);
          return res.status(500).json({ error: 'Failed to update message' });
        }
        txnStates = (updated || []).map((r) => ({ ...r, recipient_id: r.id }));
      }

      const allStates = [...states, ...txnStates];
      if (isBulk) {
        return res.json({ states: allStates, updated: allStates.length });
      }
      return res.json({ state: allStates[0] || null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Inbox] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
