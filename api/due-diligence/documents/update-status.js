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
    const { documentId, status } = req.body;

    if (!documentId || !status) {
      return res.status(400).json({ error: 'documentId and status are required' });
    }

    const validStatuses = ['pending', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    const { data: existingDoc, error: fetchError } = await supabase
      .from('submission_document')
      .select('*')
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { data: updatedDoc, error: updateError } = await supabase
      .from('submission_document')
      .update({
        status: status,
        status_changed_at: new Date().toISOString(),
        status_changed_by: member.email,
        updated_at: new Date().toISOString()
      })
      .eq('id', documentId)
      .select()
      .single();

    if (updateError) {
      console.error('[DD Documents] Update status error:', updateError);
      return res.status(500).json({ error: 'Failed to update document status' });
    }

    return res.status(200).json({
      success: true,
      document: updatedDoc
    });

  } catch (error) {
    console.error('[DD Documents] Update status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
