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
    const { formSubmissionId, fieldName } = req.query;

    if (!formSubmissionId || !fieldName) {
      return res.status(400).json({ error: 'formSubmissionId and fieldName are required' });
    }

    const { data: versions, error } = await supabase
      .from('submission_document')
      .select('*')
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('form_submission_id', formSubmissionId)
      .eq('field_name', fieldName)
      .order('version', { ascending: false });

    if (error) {
      console.error('[DD Documents] Get versions error:', error);
      return res.status(500).json({ error: 'Failed to fetch document versions' });
    }

    if (versions && versions.length > 0) {
      const docIds = versions.map(d => d.id);
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

      versions.forEach(doc => {
        doc.comments = commentsByDocId[doc.id] || [];
      });
    }

    return res.status(200).json({
      success: true,
      versions: versions || []
    });

  } catch (error) {
    console.error('[DD Documents] Get versions error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
