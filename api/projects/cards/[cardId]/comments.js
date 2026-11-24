import { supabase } from '../../../_lib/database.js';
import { getSession } from '../../../_lib/session.js';
import { guardSalesLinkedProject } from '../../../_lib/salesLinkedProjectGuard.js';
import { readProjectDiscussion } from '../../../_lib/projectDiscussion.js';
import { normalizeDiscussionContent, discussionUuid, DISCUSSION_EMOJI } from '../../../_lib/projectDiscussionContent.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const session = (await getSession(req))?.data;
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { cardId } = req.query;
  if (!cardId) return res.status(400).json({ error: 'Card ID required' });
  try {
    const { data: card, error: cardError } = await supabase.from('project_card').select('board_id').eq('id', cardId).single();
    if (cardError) throw cardError;
    if (!card) return res.status(404).json({ error: 'Card unavailable' });
    const { data: membership, error: memberError } = await supabase.from('project_board_member')
      .select('role').eq('board_id', card.board_id).eq('identity_id', session.identityId).single();
    if (memberError && memberError.code !== 'PGRST116') throw memberError;
    if (!membership) return res.status(403).json({ error: 'Not a member of this board' });
    if (!await guardSalesLinkedProject(req, res, card.board_id)) return;
    if (req.method === 'GET') return res.json(await readProjectDiscussion(supabase, cardId, session.identityId));
    const operations = { POST: 'create', PATCH: 'edit', DELETE: 'delete', PUT: 'react' };
    const operation = operations[req.method];
    if (!operation) return res.status(405).json({ error: 'Method not allowed' });
    if (!['owner', 'admin', 'member'].includes(membership.role)) return res.status(403).json({ error: 'This board is read-only' });
    const body = req.body || {};
    const args = { p_card_id: cardId, p_actor_id: session.identityId, p_operation: operation };
    if (operation !== 'create') {
      if (!discussionUuid(body.commentId)) return res.status(400).json({ error: 'Comment ID required' });
      args.p_comment_id = body.commentId;
    }
    if (['create', 'edit'].includes(operation)) {
      const normalized = normalizeDiscussionContent(body);
      Object.assign(args, {
        p_content: normalized.content, p_rich_content: normalized.richContent,
        p_recipient_ids: normalized.mentionIdentityIds, p_attachment_ids: normalized.attachmentIds,
      });
    }
    if (operation === 'create') {
      if ((body.requestId !== undefined && !discussionUuid(body.requestId)) ||
        (body.replyToCommentId != null && !discussionUuid(body.replyToCommentId)) ||
        ((body.attachmentIds?.length || body.richContent || body.replyToCommentId) && !body.requestId)) {
        return res.status(400).json({ error: 'A valid request ID and reply target are required' });
      }
      args.p_request_id = body.requestId || null;
      args.p_reply_to_id = body.replyToCommentId || null;
    }
    if (operation === 'react') {
      if (body.emoji !== null && !DISCUSSION_EMOJI.includes(body.emoji)) return res.status(400).json({ error: 'Unsupported reaction' });
      args.p_emoji = body.emoji;
    }
    const { data, error } = await supabase.rpc('write_project_discussion', args);
    if (error) throw error;
    if (!data || !Array.isArray(data.comments)) throw new Error('Incomplete discussion response');
    return res.status(operation === 'create' ? 201 : 200).json(data);
  } catch (error) {
    const status = error.status || ({ '22023': 400, '22P02': 400, '42501': 403, P0002: 404, PT409: 409 }[error.code]) || 500;
    if (status === 500) console.error('[Discussion]', error.code || error.message);
    return res.status(status).json({ error: status === 500 ? 'Could not load or update this discussion. Your draft is kept; try again.' : error.message });
  }
}
