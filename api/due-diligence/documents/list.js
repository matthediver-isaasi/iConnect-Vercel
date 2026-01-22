import { supabase } from '../../_lib/database.js';
import { getSessionMember } from '../../_lib/session.js';
import { getTenantContext } from '../../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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
    const { formSubmissionId, includeAllVersions } = req.query;

    if (!formSubmissionId) {
      return res.status(400).json({ error: 'formSubmissionId is required' });
    }

    let query = supabase
      .from('submission_document')
      .select('*')
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('form_submission_id', formSubmissionId)
      .order('field_name', { ascending: true })
      .order('version', { ascending: false });

    if (includeAllVersions !== 'true') {
      query = query.eq('is_current_version', true);
    }

    const { data: documents, error } = await query;

    console.log('[DD Documents List] Query result:', {
      formSubmissionId,
      tenantId: tenantCtx.tenantId,
      includeAllVersions,
      documentsCount: documents?.length || 0,
      error: error?.message
    });

    if (documents && documents.length > 0) {
      const docIds = documents.map(d => d.id);
      const { data: comments } = await supabase
        .from('submission_document_comment')
        .select('*')
        .eq('tenant_id', tenantCtx.tenantId)
        .in('submission_document_id', docIds)
        .order('created_at', { ascending: true });

      const commentsByDocId = {};
      (comments || []).forEach(c => {
        if (!commentsByDocId[c.submission_document_id]) {
          commentsByDocId[c.submission_document_id] = [];
        }
        commentsByDocId[c.submission_document_id].push(c);
      });

      documents.forEach(doc => {
        doc.comments = commentsByDocId[doc.id] || [];
      });
    }

    if (error) {
      console.error('[DD Documents] List error:', error);
      return res.status(500).json({ error: 'Failed to fetch documents' });
    }

    return res.status(200).json({
      success: true,
      documents: documents || []
    });

  } catch (error) {
    console.error('[DD Documents] List error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
