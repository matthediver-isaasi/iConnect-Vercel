import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

async function getBoardMembershipForCard(cardId, identityId) {
  const { data: card } = await supabase
    .from('project_card')
    .select('board_id, list_id, title')
    .eq('id', cardId)
    .single();

  if (!card) return null;

  const { data: membership } = await supabase
    .from('project_board_member')
    .select('role')
    .eq('board_id', card.board_id)
    .eq('identity_id', identityId)
    .single();

  return { card, membership };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  const { cardId } = req.query;

  if (!cardId) {
    return res.status(400).json({ error: 'Card ID required' });
  }

  try {
    const access = await getBoardMembershipForCard(cardId, session.identityId);
    if (!access?.membership) {
      return res.status(403).json({ error: 'Not a member of this board' });
    }

    if (req.method === 'GET') {
      const { data: card, error } = await supabase
        .from('project_card')
        .select(`
          *,
          project_card_label(label_id),
          project_card_assignee(identity_id),
          project_card_checklist(
            id, name, position,
            project_checklist_item(id, text, is_complete, position, due_date, assignee_id)
          )
        `)
        .eq('id', cardId)
        .single();

      if (error || !card) {
        return res.status(404).json({ error: 'Card not found' });
      }

      const { data: comments } = await supabase
        .from('project_card_comment')
        .select('*')
        .eq('card_id', cardId)
        .order('created_at', { ascending: true });

      const { data: attachments } = await supabase
        .from('project_card_attachment')
        .select('*')
        .eq('card_id', cardId)
        .order('uploaded_at', { ascending: false });

      const { data: activity } = await supabase
        .from('project_card_activity')
        .select('*')
        .eq('card_id', cardId)
        .order('created_at', { ascending: false })
        .limit(50);

      return res.json({
        card,
        comments: comments || [],
        attachments: attachments || [],
        activity: activity || []
      });
    }

    if (req.method === 'PATCH') {
      if (access.membership.role === 'viewer') {
        return res.status(403).json({ error: 'Viewers cannot update cards' });
      }

      const {
        title, description, list_id, position, cover_image, cover_color,
        due_date, due_reminder, start_date, is_complete, is_archived,
        priority, estimated_hours, actual_hours
      } = req.body;

      const updateData = { updated_at: new Date().toISOString() };
      const activityData = {};

      if (title !== undefined) {
        updateData.title = title.trim();
        activityData.title = title.trim();
      }
      if (description !== undefined) updateData.description = description?.trim() || null;
      if (list_id !== undefined) {
        updateData.list_id = list_id;
        activityData.moved_to_list = list_id;
      }
      if (position !== undefined) updateData.position = position;
      if (cover_image !== undefined) updateData.cover_image = cover_image;
      if (cover_color !== undefined) updateData.cover_color = cover_color;
      if (due_date !== undefined) updateData.due_date = due_date;
      if (due_reminder !== undefined) updateData.due_reminder = due_reminder;
      if (start_date !== undefined) updateData.start_date = start_date;
      if (is_archived !== undefined) updateData.is_archived = is_archived;
      if (priority !== undefined) updateData.priority = priority;
      if (estimated_hours !== undefined) updateData.estimated_hours = estimated_hours;
      if (actual_hours !== undefined) updateData.actual_hours = actual_hours;

      if (is_complete !== undefined) {
        updateData.is_complete = is_complete;
        if (is_complete) {
          updateData.completed_at = new Date().toISOString();
          updateData.completed_by = session.identityId;
        } else {
          updateData.completed_at = null;
          updateData.completed_by = null;
        }
      }

      const { data: updated, error } = await supabase
        .from('project_card')
        .update(updateData)
        .eq('id', cardId)
        .select(`
          *,
          project_card_label(label_id),
          project_card_assignee(identity_id)
        `)
        .single();

      if (error) {
        console.error('[Card] Update error:', error);
        return res.status(500).json({ error: 'Failed to update card' });
      }

      let actionType = 'updated';
      if (list_id !== undefined && list_id !== access.card.list_id) actionType = 'moved';
      if (is_complete === true) actionType = 'completed';
      if (is_complete === false) actionType = 'reopened';
      if (is_archived === true) actionType = 'archived';

      await supabase.from('project_card_activity').insert({
        card_id: cardId,
        identity_id: session.identityId,
        action_type: actionType,
        action_data: activityData
      });

      return res.json({ card: updated });
    }

    if (req.method === 'DELETE') {
      if (!['owner', 'admin'].includes(access.membership.role)) {
        return res.status(403).json({ error: 'Only owners/admins can delete cards' });
      }

      const { error } = await supabase
        .from('project_card')
        .delete()
        .eq('id', cardId);

      if (error) {
        console.error('[Card] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete card' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Card] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
