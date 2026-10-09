import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createProjectInboxHandler({ db = supabase, sessionFor = getSession } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control','private, no-store');
    if (!['GET','PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const identityId = (await sessionFor(req))?.data?.identityId;
      if (!identityId) return res.status(401).json({ error: 'Not authenticated' });
      const { boardId } = req.query;
      if (!uuid(boardId)) return res.status(400).json({ error: 'Valid board ID required' });
      const membership = await db.from('project_board_member').select('role')
        .eq('board_id',boardId).eq('identity_id',identityId).maybeSingle();
      if (membership.error) throw membership.error;
      if (!membership.data) return res.status(403).json({ error: 'Not a member of this board' });
      const board = await db.from('project_board').select('is_archived').eq('id',boardId).maybeSingle();
      if (board.error) throw board.error;
      if (!board.data || board.data.is_archived) return res.status(404).json({ error: 'Board unavailable' });
      if (req.method === 'GET') {
        // Card badges must include mentions beyond the inbox's current page.
        if (req.query.summary === 'true') {
          const cardIds = new Set();
          const pageSize = 500;
          for (let offset = 0; ; offset += pageSize) {
            const rows = await db.from('project_mention_inbox')
              .select('id,card_id,card:project_card!inner(is_archived)')
              .eq('board_id',boardId).eq('recipient_id',identityId)
              .eq('is_archived',false).is('read_at',null)
              .eq('card.is_archived',false).eq('card.board_id',boardId)
              .order('id',{ascending:true}).range(offset,offset+pageSize-1);
            if (rows.error) throw rows.error;
            for (const row of rows.data || []) cardIds.add(row.card_id);
            if ((rows.data || []).length < pageSize) break;
          }
          return res.json({unreadCardIds:[...cardIds]});
        }
        const page = Number(req.query.page || 1), pageSize = Number(req.query.pageSize || 30);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100000
          || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          return res.status(400).json({ error: 'Invalid pagination' });
        }
        const base = columns => db.from('project_mention_inbox')
          .select(columns,{count:'exact'}).eq('board_id',boardId).eq('recipient_id',identityId)
          .eq('is_archived',false)
          .eq('card.is_archived',false).eq('card.board_id',boardId);
        const rows = await base('id,card_id,comment_id,content,author_name,created_at,read_at,pinned_at,card:project_card!inner(title,is_archived)')
          .order('pinned_at',{ascending:false,nullsFirst:false})
          .order('created_at',{ascending:false}).order('id',{ascending:false})
          .range((page-1)*pageSize,page*pageSize-1);
        if (rows.error) throw rows.error;
        const unread = await base('id,card:project_card!inner(is_archived)').is('read_at',null).limit(0);
        if (unread.error) throw unread.error;
        return res.json({
          items:(rows.data || []).map(({card,...item})=>({...item,card_title:card?.title || 'Card'})),
          total:rows.count || 0, unreadCount:unread.count || 0, page, pageSize,
        });
      }
      const body = req.body || {};
      const hasRead = Object.hasOwn(body,'read'), hasPin = Object.hasOwn(body,'pinned');
      if (hasRead === hasPin || (hasRead && typeof body.read !== 'boolean')
        || (hasPin && typeof body.pinned !== 'boolean')) {
        return res.status(400).json({error:'Choose a read or pin action'});
      }
      const all = body.all === true;
      const byCard = Object.hasOwn(body,'cardId');
      if (byCard && (!uuid(body.cardId) || all || Object.hasOwn(body,'ids') || !hasRead || body.read !== true)) {
        return res.status(400).json({error:'Choose a valid card to mark read'});
      }
      if (all && (!hasRead || body.read !== true)) return res.status(400).json({error:'Only mark-all-read is supported'});
      if (!all && !byCard && (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || body.ids.some(id=>!uuid(id)))) {
        return res.status(400).json({error:'Select up to 100 inbox messages'});
      }
      if (byCard) {
        const card = await db.from('project_card').select('id')
          .eq('id',body.cardId).eq('board_id',boardId).eq('is_archived',false).maybeSingle();
        if (card.error) throw card.error;
        if (!card.data) return res.status(404).json({error:'Card unavailable'});
      }
      const value = (hasRead ? body.read : body.pinned) ? new Date().toISOString() : null;
      let update = db.from('project_mention_inbox').update({[hasRead?'read_at':'pinned_at']:value})
        .eq('board_id',boardId).eq('recipient_id',identityId).eq('is_archived',false);
      if (byCard) update = update.eq('card_id',body.cardId).is('read_at',null);
      else if (!all) update = update.in('id',[...new Set(body.ids)]);
      const result = await update;
      if (result.error) throw result.error;
      return res.json({updated:true});
    } catch (error) {
      console.error('[Project inbox]',error.code || 'request_failed');
      return res.status(500).json({error:'Unable to update or load your board inbox. Please retry.'});
    }
  };
}
export default createProjectInboxHandler();
