// Task #2407: Member AI assistant — single conversation (fetch/append/delete).
//
// GET    -> the conversation's full message thread (ordered by position).
// POST   -> append messages (a user+assistant turn) to the conversation and
//           bump updated_at so it sorts to the top of the history list.
// DELETE -> delete the conversation (messages cascade).
//
// Scope: STRICTLY (tenant_id, member_id) — ownership is verified on every
// method before any message read/write, so a member can never touch another
// member's (or another tenant's) conversation.

import { supabase } from '../../_lib/database.js';
import {
  resolveMemberScope,
  sanitizeMessages,
  MAX_MESSAGES,
} from '../../_lib/memberAiHistory.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const scope = await resolveMemberScope(req, res);
  if (!scope) return;
  const { tenantId, memberId } = scope;

  const conversationId =
    typeof req.query?.id === 'string' ? req.query.id : null;
  if (!conversationId) {
    return res.status(400).json({ error: 'Conversation id required' });
  }

  try {
    // Ownership check first — every method depends on it.
    const { data: conversation, error: convError } = await supabase
      .from('member_ai_conversation')
      .select('id, title, updated_at, created_at')
      .eq('id', conversationId)
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .maybeSingle();
    if (convError) throw convError;
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (req.method === 'GET') {
      const { data: messages, error } = await supabase
        .from('member_ai_message')
        .select('id, role, content, sources, position')
        .eq('conversation_id', conversationId)
        .order('position', { ascending: true })
        .limit(MAX_MESSAGES);
      if (error) throw error;
      return res.status(200).json({ conversation, messages: messages || [] });
    }

    if (req.method === 'POST') {
      const messages = sanitizeMessages(req.body?.messages);
      if (!messages || messages.length === 0) {
        return res.status(400).json({ error: 'Messages are required' });
      }

      // Next append position = current max + 1. A unique index on
      // (conversation_id, position) guarantees two concurrent appends can't
      // land on the same position — the loser gets 23505 and we retry with a
      // freshly-read base.
      const MAX_ATTEMPTS = 3;
      let inserted = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !inserted; attempt++) {
        const { data: last, error: lastError } = await supabase
          .from('member_ai_message')
          .select('position')
          .eq('conversation_id', conversationId)
          .order('position', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastError) throw lastError;
        const base = (last?.position ?? -1) + 1;
        if (base + messages.length > MAX_MESSAGES) {
          return res
            .status(400)
            .json({ error: 'This conversation is full — start a new chat.' });
        }

        const rows = messages.map((m, i) => ({
          conversation_id: conversationId,
          role: m.role,
          content: m.content,
          sources: m.sources,
          position: base + i,
        }));
        const { error: insertError } = await supabase
          .from('member_ai_message')
          .insert(rows);
        if (!insertError) {
          inserted = true;
        } else if (insertError.code === '23505' && attempt < MAX_ATTEMPTS - 1) {
          continue; // lost the position race — re-read max and retry
        } else {
          throw insertError;
        }
      }
      if (!inserted) {
        return res
          .status(409)
          .json({ error: 'Could not save this message — please try again.' });
      }

      const { error: touchError } = await supabase
        .from('member_ai_conversation')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId);
      if (touchError) throw touchError;

      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('member_ai_conversation')
        .delete()
        .eq('id', conversationId)
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Member AI Conversation] Error:', error);
    return res
      .status(500)
      .json({ error: 'Something went wrong with chat history.' });
  }
}
