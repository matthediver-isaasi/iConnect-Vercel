import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  if (!session.tenantId || !session.identityId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    if (req.method === 'GET') {
      const { archived } = req.query;
      
      const { data: memberBoards, error: memberError } = await supabase
        .from('project_board_member')
        .select('board_id')
        .eq('identity_id', session.identityId);

      if (memberError) {
        console.error('[Boards] Error fetching board memberships:', memberError);
        return res.status(500).json({ error: 'Failed to fetch boards' });
      }

      const boardIds = memberBoards?.map(m => m.board_id) || [];

      let query = supabase
        .from('project_board')
        .select(`
          *,
          project_board_member!inner(identity_id, role)
        `)
        .eq('tenant_id', session.tenantId)
        .in('id', boardIds.length > 0 ? boardIds : ['00000000-0000-0000-0000-000000000000']);

      if (archived !== 'true') {
        query = query.eq('is_archived', false);
      }

      const { data: boards, error } = await query.order('created_at', { ascending: false });

      if (error) {
        console.error('[Boards] Error fetching boards:', error);
        return res.status(500).json({ error: 'Failed to fetch boards' });
      }

      const enrichedBoards = boards.map(board => {
        const userMembership = board.project_board_member?.find(m => m.identity_id === session.identityId);
        return {
          ...board,
          user_role: userMembership?.role || 'member',
          project_board_member: undefined
        };
      });

      return res.json({ boards: enrichedBoards });
    }

    if (req.method === 'POST') {
      const { name, description, color, visibility } = req.body;

      if (!name?.trim()) {
        return res.status(400).json({ error: 'Board name is required' });
      }

      const { data: board, error: createError } = await supabase
        .from('project_board')
        .insert({
          tenant_id: session.tenantId,
          name: name.trim(),
          description: description?.trim() || null,
          color: color || '#6366f1',
          visibility: visibility || 'private',
          created_by: session.identityId
        })
        .select()
        .single();

      if (createError) {
        console.error('[Boards] Error creating board:', createError);
        return res.status(500).json({ error: 'Failed to create board' });
      }

      const { error: memberError } = await supabase
        .from('project_board_member')
        .insert({
          board_id: board.id,
          identity_id: session.identityId,
          role: 'owner',
          added_by: session.identityId
        });

      if (memberError) {
        console.error('[Boards] Error adding board owner:', memberError);
        await supabase.from('project_board').delete().eq('id', board.id);
        return res.status(500).json({ error: 'Failed to create board - could not add owner. Please ensure database migrations have been run.' });
      }

      const defaultLabels = [
        { name: 'High Priority', color: '#ef4444' },
        { name: 'Medium Priority', color: '#f59e0b' },
        { name: 'Low Priority', color: '#22c55e' },
        { name: 'Bug', color: '#dc2626' },
        { name: 'Feature', color: '#3b82f6' },
        { name: 'Enhancement', color: '#8b5cf6' }
      ];

      await supabase
        .from('project_label')
        .insert(defaultLabels.map(label => ({
          board_id: board.id,
          name: label.name,
          color: label.color
        })));

      return res.status(201).json({ board: { ...board, user_role: 'owner' } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Boards] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
