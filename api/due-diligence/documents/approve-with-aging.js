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
    const { documentId, previousApprovedId } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: 'documentId is required' });
    }

    const now = new Date().toISOString();

    // Verify document exists and belongs to tenant
    const { data: existingDoc, error: fetchError } = await supabase
      .from('submission_document')
      .select('*')
      .eq('id', documentId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (fetchError || !existingDoc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // If there's a previously approved document, age it first
    if (previousApprovedId && previousApprovedId !== documentId) {
      const { error: ageError } = await supabase
        .from('submission_document')
        .update({
          status: 'aged',
          status_changed_at: now,
          status_changed_by: member.email,
          updated_at: now
        })
        .eq('id', previousApprovedId)
        .eq('tenant_id', tenantCtx.tenantId);

      if (ageError) {
        console.error('[DD Documents] Age previous version error:', ageError);
        // Continue with approval even if aging fails
      }
    }

    // Approve the document
    const { data: updatedDoc, error: updateError } = await supabase
      .from('submission_document')
      .update({
        status: 'approved',
        status_changed_at: now,
        status_changed_by: member.email,
        updated_at: now
      })
      .eq('id', documentId)
      .select()
      .single();

    if (updateError) {
      console.error('[DD Documents] Approve error:', updateError);
      return res.status(500).json({ error: 'Failed to approve document' });
    }

    return res.status(200).json({
      success: true,
      document: updatedDoc
    });

  } catch (error) {
    console.error('[DD Documents] Approve with aging error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
