// Task #2407: Member AI assistant — conversation history (list + create).
//
// GET  -> list the calling member's conversations for the active tenant,
//         most recent first (lightweight: id, title, updated_at).
// POST -> create a conversation with its initial messages (the first
//         question/answer turn); title auto-derived client-side from the
//         first question.
//
// Scope: STRICTLY (tenant_id, member_id) — see api/_lib/memberAiHistory.js
// for how context is resolved (mirrors api/member-ai/ask.js) and why
// authenticated non-member users get 403 'not_member'.

import { supabase } from '../_lib/database.js';
import {
  resolveMemberScope,
  sanitizeMessages,
  MAX_TITLE_LEN,
  MAX_MESSAGES,
} from '../_lib/memberAiHistory.js';

const LIST_LIMIT = 50;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const scope = await resolveMemberScope(req, res);
  if (!scope) return;
  const { tenantId, memberId } = scope;

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('member_ai_conversation')
        .select('id, title, updated_at, created_at')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .order('updated_at', { ascending: false })
        .limit(LIST_LIMIT);
      if (error) throw error;
      return res.status(200).json({ conversations: data || [] });
    }

    if (req.method === 'POST') {
      const title =
        typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title) {
        return res.status(400).json({ error: 'Title is required' });
      }
      const messages = sanitizeMessages(req.body?.messages);
      if (!messages || messages.length === 0) {
        return res.status(400).json({ error: 'Messages are required' });
      }
      if (messages.length > MAX_MESSAGES) {
        return res.status(400).json({ error: 'Too many messages' });
      }

      const { data: conversation, error: convError } = await supabase
        .from('member_ai_conversation')
        .insert({
          tenant_id: tenantId,
          member_id: memberId,
          title: title.slice(0, MAX_TITLE_LEN),
        })
        .select('id, title, updated_at, created_at')
        .single();
      if (convError) throw convError;

      const rows = messages.map((m, i) => ({
        conversation_id: conversation.id,
        role: m.role,
        content: m.content,
        sources: m.sources,
        position: i,
      }));
      const { error: msgError } = await supabase
        .from('member_ai_message')
        .insert(rows);
      if (msgError) {
        // Don't leave an empty shell conversation behind.
        await supabase
          .from('member_ai_conversation')
          .delete()
          .eq('id', conversation.id)
          .eq('tenant_id', tenantId)
          .eq('member_id', memberId);
        throw msgError;
      }

      return res.status(201).json({ conversation });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Member AI Conversations] Error:', error);
    return res
      .status(500)
      .json({ error: 'Something went wrong with chat history.' });
  }
}
