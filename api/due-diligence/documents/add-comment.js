import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { documentId, comment } = req.body;

    if (!documentId || !comment || !comment.trim()) {
      return res.status(400).json({ error: 'documentId and comment are required' });
    }

    const { data: existingDoc, error: fetchError } = await supabase
      .from('submission_document')
      .select('id')
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const authorName = [member.first_name, member.last_name]
      .filter(Boolean)
      .join(' ') || member.email;

    const { data: newComment, error: insertError } = await supabase
      .from('submission_document_comment')
      .insert({
        tenant_id: tenantCtx.tenantId,
        submission_document_id: documentId,
        comment: comment.trim(),
        author_email: member.email,
        author_name: authorName
      })
      .select()
      .single();

    if (insertError) {
      console.error('[DD Documents] Add comment error:', insertError);
      return res.status(500).json({ error: 'Failed to add comment' });
    }

    return res.status(201).json({
      success: true,
      comment: newComment
    });

  } catch (error) {
    console.error('[DD Documents] Add comment error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
